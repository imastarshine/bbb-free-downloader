importScripts('config.js');

const CFG = BBB_CONFIG;
const KEY = 'bbbState';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function load() {
  const d = await chrome.storage.local.get(KEY);
  return d[KEY] || null;
}

async function save(s) {
  await chrome.storage.local.set({ [KEY]: s });
}

function armAlarm() {
  chrome.alarms.create('bbbHeartbeat', { periodInMinutes: CFG.STUCK_ALARM_PERIOD_MIN });
}

function disarmAlarm() {
  chrome.alarms.clear('bbbHeartbeat');
}

function bump(s) {
  s.signal = (s.signal || 0) + 1;
  s.lastEventAt = Date.now();
  refreshNow(s);
}

// The panel shows what is being downloaded right now and what is queued:
//  • downloading — downloads in flight (pendingStarted);
//  • waiting — the current driver batch, not started yet / waiting for retry.
function refreshNow(s) {
  try {
    const downloading = Object.values(s.pendingStarted || {}).slice(0, 5).map((e) => e && e.title);
    const pendIds = new Set(Object.values(s.pendingStarted || {}).map((e) => String(e && e.id)));
    const waitList = [];
    for (const r of s.batch || []) {
      if (waitList.length >= 5) break;
      const id = String(r && r.id);
      if (!pendIds.has(id) && !s.done[id] && !s.failed[id]) waitList.push(r.title);
    }
    for (const r of s.retryQueue || []) {
      if (waitList.length >= 5) break;
      if (r.retryAt > Date.now()) waitList.push(r.rec.title);
    }
    s.now = { downloading: downloading.filter(Boolean), waiting: waitList.filter(Boolean) };
  } catch (e) {
    s.now = { downloading: [], waiting: [] };
  }
}

function ensureQueues(s) {
  if (!s.pendingStarted) s.pendingStarted = {};
  if (!s.retryQueue) s.retryQueue = [];
  return s;
}

// "Is the run still going?" — used in late callbacks (a download registering
// after Stop/Pause) and in the watchdog, so a stopped run cannot "come back
// to life".
function isActive(s) {
  return !!s && !!s.running && !s.paused;
}

function retryDelay(attempt) {
  const delays = CFG.RETRY_DELAYS_MS || [2000, 5000, 12000];
  return delays[Math.min(Math.max(attempt - 1, 0), delays.length - 1)];
}

function markFailed(s, rec, error) {
  const e = Object.assign({}, rec, { filename: rec.filename || '', status: 'error', error: String(error || 'error'), at: Date.now() });
  s.failed[e.id] = e;
  s.log.push(e);
  bump(s);
  return e;
}

function markOk(s, rec, filename) {
  const e = Object.assign({}, rec, { filename, status: 'ok', error: '', at: Date.now() });
  s.done[e.id] = e;
  s.consecutiveFails = 0;
  s.log.push(e);
  bump(s);
  return e;
}

// Has the file at this URL already been downloaded successfully and does it
// sit on disk? (Marked as done without re-downloading — fast on repeat runs.)
function markCached(s, rec, filename) {
  const e = Object.assign({}, rec, { filename, status: 'ok', error: '', at: Date.now(), mode: 'cached' });
  s.done[e.id] = e;
  s.consecutiveFails = 0;
  s.log.push(e);
  bump(s);
  return e;
}

async function alreadyDownloaded(url) {
  try {
    // search({url}) matches both url and finalUrl (substring) — covers both.
    const items = await chrome.downloads.search({ url });
    for (const it of items || []) {
      if (it.state === 'complete' && it.exists) return it.filename || '';
    }
  } catch (e) {
    // The API may be unavailable — then we just download again.
  }
  return '';
}

function enqueueRetry(s, rec, reason) {
  const attempt = (rec.attempt || 0) + 1;
  // No duplicates in the retry queue — drop an older retry of the same id.
  s.retryQueue = (s.retryQueue || []).filter((r) => String(r.rec && r.rec.id) !== String(rec.id));
  if (attempt > (CFG.RETRY_ATTEMPTS || 3)) {
    markFailed(s, rec, reason ? 'retries-exhausted (' + reason + ')' : 'retries-exhausted');
    return;
  }
  s.retryQueue.push({
    rec: Object.assign({}, rec, { attempt, filename: '' }),
    retryAt: Date.now() + retryDelay(attempt),
    reason: reason || ''
  });
}

// Retry a download with a FORCED filename. Android/Kiwi does not uniquify
// on its own when the name is taken — it cancels the download
// (USER_CANCELED), so we pick a free name ourselves (nextFreeDownloadName)
// and pass it to download() via rec.saveName. The number of such retries is
// capped (uniqTry ≤ UNIQUIFY_MAX_TRIES in the USER_CANCELED handler).
function enqueueUniquifyRetry(s, rec, reason) {
  s.retryQueue = (s.retryQueue || []).filter((r) => String(r.rec && r.rec.id) !== String(rec.id));
  s.retryQueue.push({
    rec: Object.assign({}, rec, { attempt: (rec.attempt || 0) + 1 }),
    retryAt: Date.now() + (CFG.UNIQUIFY_RETRY_DELAY_MS || 3000),
    reason: reason || 'USER_CANCELED rename'
  });
}

// The first free "base (N)ext" name that is NOT yet on disk. We check the
// download history by full path (manually placed files are invisible here —
// but the retry will hit USER_CANCELED anyway, and N moves on).
// Returns { name, n } (name relative to the downloads folder) or null.
async function nextFreeDownloadName(full, startN) {
  const i = Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\'));
  const dir = i >= 0 ? full.slice(0, i + 1) : '';
  const name = i >= 0 ? full.slice(i + 1) : full;
  const d = name.lastIndexOf('.');
  const base = d > 0 ? name.slice(0, d) : name;
  const ext = d > 0 ? name.slice(d) : '';
  for (let n = Math.max(startN || 1, 1); n <= 20; n++) {
    const rel = base + ' (' + n + ')' + ext;
    const abs = dir + rel;
    let busy = false;
    try {
      const hits = await chrome.downloads.search({ filename: abs });
      for (const it of hits || []) {
        if (it && it.filename === abs && it.state === 'complete' && it.exists) { busy = true; break; }
      }
    } catch (e) { /* API unavailable — try the name blind */ }
    if (!busy) return { name: rel, n: n };
  }
  return null;
}

async function startDownload(s, rec) {
  // On Kiwi chrome.downloads.download can hang forever. We do not wait
  // forever: the timeout releases the wait (the batch is not blocked), and a
  // late resolution (if any) registers the download in fresh state — almost
  // no duplicates. If no answer EVER comes, the watchdog re-queues the file
  // (capped at RETRY_ATTEMPTS) so the item is not silently lost.
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const initTimeout = CFG.DOWNLOAD_INIT_TIMEOUT_MS || 8000;
    const timer = setTimeout(() => {
      finish(false);
      // Check later: maybe the answer never came and the file is "in the air".
      setTimeout(() => { watchdogUnregistered(rec).catch(() => {}); }, initTimeout * 2);
    }, initTimeout);
    const opts = { url: rec.dlUrl, conflictAction: 'uniquify', saveAs: false };
    // Name collision: instead of the server name, download under a free
    // "base (N)ext" (rec.saveName — name relative to the downloads folder).
    if (rec.saveName) opts.filename = rec.saveName;
    chrome.downloads.download(opts).then((dlId) => {
      clearTimeout(timer);
      load().then((fresh) => {
        // While waiting for the answer, the run may have been stopped
        // (Stop/Pause) — do not "revive" a download in a stopped run.
        if (!fresh || !isActive(fresh)) return null;
        fresh = ensureQueues(fresh);
        fresh.pendingStarted[String(dlId)] = rec;
        fresh.pendingCount = (fresh.pendingCount || 0) + 1;
        bump(fresh);
        return save(fresh);
      }).catch(() => {});
      finish(true);
    }, (e) => {
      clearTimeout(timer);
      load().then((fresh) => {
        if (!fresh || !isActive(fresh)) return null;
        fresh = ensureQueues(fresh);
        enqueueRetry(fresh, rec, 'init:' + String((e && e.message) || e));
        bump(fresh);
        return save(fresh);
      }).catch(() => {});
      finish(true);
    });
  });
}

// If downloads.download never answered (not registered, not done/failed) —
// re-queue the file. Capped at RETRY_ATTEMPTS → then an honest failed.
async function watchdogUnregistered(rec) {
  const s = await load();
  if (!s || !isActive(s)) return; // stop when the run is paused/stopped
  const pendIds = new Set(Object.values(s.pendingStarted || {}).map((e) => String(e && e.id)));
  if (pendIds.has(String(rec.id))) return;          // late answer arrived — ok
  if (s.done[rec.id] || s.failed[rec.id]) return;   // already resolved
  const fresh = ensureQueues(s);
  enqueueRetry(fresh, Object.assign({}, rec, { attempt: rec.attempt || 0 }), 'init-timeout');
  bump(fresh);
  await save(fresh);
}

async function handleFetchBatch(items) {
  let s = await load();
  if (!s) return { ok: false };
  s = ensureQueues(s);
  // The driver's current batch — full file data (needed for the expire-retry
  // via s.batch and for the "what we are waiting for" panel line).
  s.batch = (items || []).map((it) => ({
    id: it.id, title: it.title, slug: it.slug, url: it.url, dlUrl: it.dlUrl
  }));
  bump(s);
  await save(s);
  armAlarm();
  // Batch processing runs in the background and does NOT block the answer to
  // the driver: a hung downloads.download can no longer "freeze" the run,
  // and pause/stop keep working.
  void processBatch((items || []).slice());
  return { ok: true };
}

// Sequential launch of the batch's files. Each item has its own init timeout
// (startDownload), so the batch cannot hang on a single file.
async function processBatch(items) {
  try {
    for (const it of items || []) {
      const s0 = await load();
      if (!s0 || !s0.running || s0.paused) return;
      if (s0.done[it.id] || s0.failed[it.id]) continue;
      // Already downloading (registered in pendingStarted)? Do not start a
      // second copy — this same check makes the driver's recovery re-sends
      // safe (no duplicates).
      const pendIds = new Set(Object.values(s0.pendingStarted || {}).map((e) => String(e && e.id)));
      if (pendIds.has(String(it.id))) continue;
      const rec = {
        id: it.id,
        title: it.title,
        slug: it.slug,
        url: it.url,
        dlUrl: it.dlUrl,
        page: s0.page,
        mode: 'api',
        startedAt: Date.now(),
        attempt: 0
      };
      // Already downloaded earlier? done without re-downloading (bounded search).
      const cached = await Promise.race([
        alreadyDownloaded(rec.dlUrl),
        sleep((CFG.DOWNLOAD_INIT_TIMEOUT_MS || 8000) + 1000).then(() => '')
      ]);
      const s1 = await load();
      if (!s1 || !s1.running || s1.paused) return;
      if (cached) {
        markCached(s1, rec, cached);
        await save(s1);
        continue;
      }
      await startDownload(s1, rec);
      await sleep(150); // short pause between launches (anti-bot + Kiwi)
    }
    await flushRetryQueue();
  } catch (e) {
    // The processing chain must not bring anything else down.
  }
}

async function flushRetryQueue() {
  let s = await load();
  if (!s) return;
  // Explicit pause/stop — no retries; after a finished run (done) timeout
  // retries still get flushed (user asked for it: retries complete on their own).
  if (!s.running && (s.paused || s.state === 'stopped')) return;
  s = ensureQueues(s);
  const due = s.retryQueue.filter((r) => r.retryAt <= Date.now());
  if (due.length === 0) return;
  s.retryQueue = s.retryQueue.filter((r) => r.retryAt > Date.now());
  for (const r of due) {
    await startDownload(s, r.rec);
  }
  bump(s);
  await save(s);
}

async function onDownloadChanged(delta) {
  if (!delta || !delta.state) return;
  const cur = delta.state.current;
  if (cur !== 'complete' && cur !== 'interrupted') return;
  let s = await load();
  const key = String(delta.id);
  let entry = s && s.pendingStarted && s.pendingStarted[key];
  if (!entry) {
    for (let i = 0; i < 4 && !entry; i++) {
      await sleep(250);
      s = await load();
      entry = s && s.pendingStarted && s.pendingStarted[key];
    }
  }
  if (!entry) return;
  s = ensureQueues(s);
  delete s.pendingStarted[key];
  s.pendingCount = Math.max(0, (s.pendingCount || 1) - 1);
  const infos = await chrome.downloads.search({ id: delta.id }).catch(() => []);
  const info = infos && infos[0];
  const filename = info ? info.filename || '' : '';

  if (cur === 'interrupted') {
    const reason = (info && info.error) || 'interrupted';
    // USER_CANCELED = "Canceled" (by hand in the browser OR automatically —
    // "file already exists": another resource served a file with the same
    // name). It is not an error and not a reason to burn attempts: mark the
    // file done (green ✓, progress keeps moving), and on the next "Resume"
    // such files are retried (content strips mode:'canceled').
    if (reason === 'USER_CANCELED') {
      // Is there an ALREADY downloaded file on disk (by this url — "already
      // downloaded")?
      const haveUrl = await alreadyDownloaded(entry.dlUrl);
      if (haveUrl) {
        // The file at this URL really was downloaded — done, no retries.
        const e = Object.assign({}, entry, { filename, status: 'ok', error: 'canceled (USER_CANCELED), file already on disk', at: Date.now(), mode: 'cached' });
        s.done[e.id] = e;
        s.log.push(e);
        bump(s);
        await save(s);
        return;
      }
      // Filename collision: another resource served a file with the same
      // name. Android/Kiwi does not uniquify on its own — it cancels the
      // download (USER_CANCELED). We know the server name (filename) and
      // re-download under a free "base (N)ext". origName — the server name
      // (from the first cancel): numbering continues from it, not from the
      // already renamed "base (1).zip".
      const origName = entry.origName || filename;
      if (origName && (entry.uniqTry || 0) < (CFG.UNIQUIFY_MAX_TRIES || 3)) {
        const free = await nextFreeDownloadName(origName, (entry.uniqN || 0) + 1);
        if (free) {
          enqueueUniquifyRetry(s, Object.assign({}, entry, {
            origName,
            saveName: free.name,
            uniqN: free.n,
            uniqTry: (entry.uniqTry || 0) + 1
          }), 'USER_CANCELED: name taken — ' + free.name);
          armAlarm(); // the heartbeat will deliver the retry (and a fast flush below)
          bump(s);
          await save(s);
          // Speed the retry up: do not wait a whole alarm period —
          // the flush fires shortly after retryAt in the queue.
          if (s.running && !s.paused) {
            const wait = (CFG.UNIQUIFY_RETRY_DELAY_MS || 3000) + 400;
            setTimeout(() => { flushRetryQueue().catch(() => {}); }, wait);
          }
          return;
        }
      }
      // Neither URL nor a free name — mark as canceled (not an error):
      // "Resume" strips mode:'canceled' and tries again.
      const sameNameCheck = filename
        ? await chrome.downloads.search({ filename }).catch(() => [])
        : [];
      const sameName = sameNameCheck && sameNameCheck.some(
        (it) => String(it.id) !== String(delta.id) && it.state === 'complete' && it.exists
      );
      const note = sameName
        ? 'canceled (USER_CANCELED): name taken, no free options left — delete the extra file and hit Resume'
        : 'canceled (USER_CANCELED) — Resume will try again';
      const e = Object.assign({}, entry, { filename, status: 'ok', error: note, at: Date.now(), mode: 'canceled' });
      s.done[e.id] = e;
      s.log.push(e);
      bump(s);
      await save(s);
      return;
    }
    // Transient (throttled, NETWORK_*, SERVER_*, ...): retry with backoff.
    if ((entry.attempt || 0) < (CFG.RETRY_ATTEMPTS || 3)) {
      enqueueRetry(s, Object.assign({}, entry, { filename: '' }), reason);
      armAlarm(); // heartbeat will flush the queue while running
      bump(s);
      await save(s);
      return;
    }
    markFailed(s, Object.assign({}, entry, { filename: '' }), reason);
    await save(s);
    return;
  }

  // complete
  const lower = filename.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    markFailed(s, Object.assign({}, entry, { filename }), 'Got HTML instead of the file — download manually');
    await save(s);
    return;
  }
  markOk(s, Object.assign({}, entry, { filename }), filename);
  await save(s);
}

async function stopDownloads() {
  const s = await load();
  if (s) {
    s = ensureQueues(s);
    for (const k of Object.keys(s.pendingStarted || {})) {
      chrome.downloads.cancel(Number(k)).catch(() => {});
      delete s.pendingStarted[k];
    }
    s.retryQueue = [];
    s.batch = [];
    s.pendingCount = 0;
    s.running = false;
    s.paused = true;
    s.state = 'stopped';
    s.error = '';
    bump(s);
    await save(s);
  }
  disarmAlarm();
}

async function continueRun() {
  const s = await load();
  if (!s) return { ok: true };
  s = ensureQueues(s);
  s.running = true;
  s.paused = false;
  s.error = '';
  s.state = (s.state === 'done' || s.state === 'idle') ? 'starting' : s.state;
  bump(s);
  await save(s);
  armAlarm();
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg && msg.cmd === 'start') {
        // Desktop popup: tell the content script on the target tab to begin.
        if (msg.tabId) {
          await chrome.tabs.sendMessage(msg.tabId, { cmd: 'beginRun' }).catch(() => {});
        }
        sendResponse({ ok: true });
      } else if (msg && msg.cmd === 'fetch-batch') {
        sendResponse(await handleFetchBatch(msg.items));
      } else if (msg && msg.cmd === 'stop') {
        await stopDownloads();
        sendResponse({ ok: true });
      } else if (msg && msg.cmd === 'reset') {
        await chrome.storage.local.remove(KEY);
        disarmAlarm();
        sendResponse({ ok: true });
      } else if (msg && msg.cmd === 'continue') {
        sendResponse(await continueRun());
      } else if (msg && msg.cmd === 'pause') {
        // Pause: the driver stops, but downloads already in flight
        // finish (progress is kept).
        const s = await load();
        if (s) {
          s = ensureQueues(s);
          s.running = false;
          s.paused = true;
          s.state = 'paused';
          s.error = '';
          bump(s);
          await save(s);
        }
        sendResponse({ ok: true });
      } else if (msg && msg.cmd === 'expire') {
        // Force-close stuck batch items: cancel + retry.
        const s = await load();
        if (s) {
          s = ensureQueues(s);
          const batchMap = new Map((s.batch || []).map((r) => [String(r.id), r]));
          for (const id of msg.ids || []) {
            let found = false;
            for (const k of Object.keys(s.pendingStarted || {})) {
              const e = s.pendingStarted[k];
              if (e && String(e.id) === String(id)) {
                chrome.downloads.cancel(Number(k)).catch(() => {});
                delete s.pendingStarted[k];
                s.pendingCount = Math.max(0, (s.pendingCount || 1) - 1);
                // Do not "kill" the item: put it in the retry queue (capped).
                enqueueRetry(s, e, 'timeout');
                found = true;
                break;
              }
            }
            // Not registered yet (downloads.download is "hanging") — re-queue
            // it straight from the current batch: no file is lost.
            if (!found && batchMap.has(String(id))) {
              enqueueRetry(s, batchMap.get(String(id)), 'timeout');
              s.batch = (s.batch || []).filter((r) => String(r.id) !== String(id));
            }
          }
          bump(s);
          await save(s);
          // Restart the stuck ones right away instead of waiting for the
          // alarm (if the run is going).
          if (s.running && !s.paused) {
            const wait = (CFG.RETRY_DELAYS_MS && CFG.RETRY_DELAYS_MS[0]) || 2000;
            setTimeout(() => flushRetryQueue(), wait + 400);
          }
        }
        sendResponse({ ok: true });
      } else if (msg && msg.cmd === 'arm') {
        armAlarm();
        sendResponse({ ok: true });
      } else if (msg && msg.cmd === 'disarm') {
        disarmAlarm();
        sendResponse({ ok: true });
      } else if (msg && msg.cmd === 'exportLog') {
        const st = await load();
        const logs = (st && st.log) || [];
        if (logs.length === 0) {
          sendResponse({ ok: true, empty: true });
          return;
        }
        const lines = logs.map((e) => [e.status, e.filename, e.dlUrl, e.error || ''].join('\t'));
        const url = 'data:text/plain;charset=utf-8,' + encodeURIComponent(lines.join('\n'));
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        await chrome.downloads.download({ url: url, filename: 'bbb_log_' + stamp + '.txt', saveAs: false });
        sendResponse({ ok: true });
      } else if (msg && msg.cmd === 'getState') {
        sendResponse({ ok: true, state: await load() });
      } else {
        sendResponse({ ok: false });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

chrome.downloads.onChanged.addListener((delta) => {
  onDownloadChanged(delta).catch((e) => console.error('[BBB] onDownloadChanged:', e));
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm || alarm.name !== 'bbbHeartbeat') return;
  let s = await load();
  // Explicit pause/stop: timeouts untouched, no retries.
  if (!s || s.paused || s.state === 'stopped') return;
  s = ensureQueues(s);
  const now = Date.now();
  let changed = false;
  for (const k of Object.keys(s.pendingStarted || {})) {
    const e = s.pendingStarted[k];
    if (now - (e.startedAt || 0) > CFG.DOWNLOAD_TIMEOUT_MS) {
      delete s.pendingStarted[k];
      s.pendingCount = Math.max(0, (s.pendingCount || 1) - 1);
      // Do not "kill": put it in the retry queue (capped attempt count).
      enqueueRetry(s, e, 'timeout');
      changed = true;
    }
  }
  if (changed) await save(s);
  await flushRetryQueue();
  // Everything finished and no retries left — the alarm is no longer needed.
  s = await load();
  if (s && !s.running && !Object.keys(s.pendingStarted || {}).length && !(s.retryQueue || []).length) {
    disarmAlarm();
  }
});
