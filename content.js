(function () {
  const CFG = (typeof BBB_CONFIG !== 'undefined' && BBB_CONFIG) || {
    BATCH_SIZE: 8,
    BATCH_DELAY_MS: 1500,
    BATCH_TIMEOUT_MS: 45000,
    EXPIRE_SETTLE_MS: 2500,
    PAGE_LOAD_DELAY_MS: 700,
    PAGE_FETCH_DELAY_MS: 700,
    DOWNLOAD_TIMEOUT_MS: 120000,
    PENDING_POLL_MS: 1000,
    MAX_PAGE_GUARD: 2000,
    SELECTORS: {
      cardItem: '[class*="js-resourceListItem-"]',
      titleLink: '.structItem-title a',
      resourceHrefRe: /\/resources\/([a-z0-9-]+)\.(\d+)\/?/,
      pageNavMain: '.pageNav-main',
      pageNavPage: '.pageNav-page',
      pageNavSpan: 'span[onclick]'
    }
  };
  const SEL = CFG.SELECTORS;
  const KEY = 'bbbState';
  const PREF_KEY = 'bbbPrefs';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function load() {
    const d = await chrome.storage.local.get(KEY);
    return d[KEY] || null;
  }

  async function save(s) {
    await chrome.storage.local.set({ [KEY]: s });
  }

  async function loadPrefs() {
    const d = await chrome.storage.local.get(PREF_KEY);
    const p = d[PREF_KEY] || {};
    return { marks: p.marks !== false, skipLines: p.skipLines || '' };
  }

  async function savePrefs(p) {
    await chrome.storage.local.set({ [PREF_KEY]: p });
  }

  const STATE_LABEL = {
    starting: 'Starting',
    navigating: 'Navigating',
    scanning: 'Scanning',
    downloading: 'Downloading',
    'waiting-advance': 'Moving on',
    paused: 'Paused',
    stopped: 'Stopped',
    done: 'Done',
    error: 'Error',
    idle: 'Idle'
  };
  const STATE_COLOR = {
    starting: '#2ecc71',
    navigating: '#2ecc71',
    scanning: '#2ecc71',
    downloading: '#2ecc71',
    'waiting-advance': '#2ecc71',
    paused: '#f1c40f',
    stopped: '#f1c40f',
    done: '#3498db',
    error: '#e74c3c',
    idle: '#7f8c8d'
  };

  // ---------------------------------------------------------------- scan

  function scanCurrentPage() {
    const items = [];
    const seen = new Set();
    document.querySelectorAll(SEL.cardItem).forEach((card) => {
      const a = card.querySelector(SEL.titleLink);
      if (!a) return;
      const m = (a.getAttribute('href') || a.href || '').match(SEL.resourceHrefRe);
      if (!m) return;
      const id = m[2];
      if (seen.has(id)) return;
      seen.add(id);
      const slug = m[1];
      items.push({
        id,
        slug,
        title: (a.textContent || '').trim(),
        url: location.origin + '/resources/' + slug + '.' + id,
        dlUrl: location.origin + '/resources/' + slug + '.' + id + '/download'
      });
    });
    return items;
  }

  // ------------------------------------------------------------- skip list

  function parseSkip(lines) {
    const ids = new Set();
    const subs = [];
    String(lines || '').split(/\r?\n/).forEach((ln) => {
      const t = String(ln || '').trim();
      if (!t) return;
      if (/^\d+$/.test(t)) ids.add(t);
      else subs.push(t.toLowerCase());
    });
    return { ids, subs };
  }

  function isSkipped(it, skip) {
    if (skip.ids.has(String(it.id))) return true;
    const title = String(it.title || '').toLowerCase();
    return skip.subs.some((t) => title.includes(t));
  }

  function markSkipped(s, it) {
    s.done[it.id] = {
      id: it.id,
      title: it.title,
      slug: it.slug,
      url: it.url,
      dlUrl: it.dlUrl,
      filename: '',
      status: 'skipped',
      error: '',
      page: s.page,
      at: Date.now(),
      mode: 'skip'
    };
  }

  // Mark cards of the CURRENT page that match the skip list as done right away.
  async function applySkipNow() {
    const p = await loadPrefs();
    const skip = parseSkip(p.skipLines);
    const s = await load();
    if (!s) return;
    let changed = false;
    for (const it of scanCurrentPage()) {
      if (!s.done[it.id] && !s.failed[it.id] && isSkipped(it, skip)) {
        markSkipped(s, it);
        changed = true;
      }
    }
    if (changed) {
      s.signal = (s.signal || 0) + 1;
      await save(s);
    }
    render(s);
  }

  // ------------------------------------------------------------ pagination

  function pageNumOfUrl(u) {
    let m = String(u || '').match(/(?:[?&]page=)(\d+)/);
    if (m) return parseInt(m[1], 10);
    m = String(u || '').match(/\/page[-\/](\d+)/);
    if (m) return parseInt(m[1], 10);
    return 1;
  }

  // Set the page number in a link (?page=N / &page=N / /page-N / /page/N).
  function setPageNum(urlStr, num) {
    try {
      const s = String(urlStr);
      if (/([?&]page=)\d+/.test(s)) return s.replace(/([?&]page=)\d+/, '$1' + num);
      const pm = s.match(/\/page[-\/](\d+)/);
      if (pm) {
        const sep = pm[0].replace(/\d+$/, '');
        return s.replace(/\/page[-\/]\d+/, sep + num);
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  // Get the target URL from a pagination element: span[onclick] OR a[href].
  function resolveNavUrl(el) {
    try {
      let raw = null;
      if (el.getAttribute) {
        const onclick = el.getAttribute('onclick');
        if (onclick) {
          const m = onclick.match(/location\s*=\s*(['"])(.*?)\1/);
          raw = m ? m[2] : null;
        }
      }
      if (!raw && el.href) raw = el.href;
      if (!raw && el.getAttribute) raw = el.getAttribute('href');
      if (!raw) return null;
      return new URL(String(raw).replace(/&amp;/g, '&'), location.href).href;
    } catch (e) {
      return null;
    }
  }

  // Tolerant pagination parser — the markup comes in several flavors:
  //  • full (.pageNav-main .pageNav-page): buttons with span[onclick] OR a[href];
  //  • mobile (.pageNavSimple): "1 of N", Next/Last links with href="…page=N";
  //  • jump template (data-page-url="…page=%page%").
  // Result: { current, max, pageUrl(num) } — pageUrl builds the URL of any
  // page based on the site's OWN links (not on location.href).
  function getPagination() {
    const res = { current: 1, max: 1, pageUrl: null };
    const numUrls = new Map(); // exact URL per page number (from the DOM)
    let template = null;       // any link with an explicit number (to derive the rest)
    let jumpPattern = null;    // data-page-url with %page%

    const main = document.querySelector(SEL.pageNavMain);
    if (main) {
      main.querySelectorAll(SEL.pageNavPage).forEach((li) => {
        // Number button: either span[onclick] (standard) or <a> (our fix).
        const el = li.querySelector('span[onclick]') || li.querySelector('a');
        if (!el) return;
        const txt = String(el.textContent || '').trim();
        const num = parseInt(txt, 10);
        if (!Number.isFinite(num)) return;
        const url = resolveNavUrl(el);
        if (!url) return;
        if (!numUrls.has(num)) numUrls.set(num, url);
        if (num > res.max) res.max = num;
        if (li.classList.contains('pageNav-page--current')) res.current = num;
        if (!template && pageNumOfUrl(url) > 1) template = url;
      });
    }

    // Mobile pagination (the main source of the maximum on a phone):
    // the text "1 of 10" + Next/Last href links.
    const simple = document.querySelector('.pageNavSimple');
    if (simple) {
      const curEl = simple.querySelector('.pageNavSimple-el--current');
      if (curEl) {
        const m = String(curEl.textContent || '').match(/(\d+)\s+of\s+(\d+)/i);
        if (m) {
          const c = parseInt(m[1], 10);
          const mx = parseInt(m[2], 10);
          if (c > res.current) res.current = c;
          if (mx > res.max) res.max = mx;
        }
      }
      simple.querySelectorAll('a[href]').forEach((a) => {
        const url = resolveNavUrl(a);
        if (!url) return;
        const n = pageNumOfUrl(url);
        if (n > res.max) res.max = n;
        if (!numUrls.has(n)) numUrls.set(n, url);
        if (!template && n > 1) template = url;
      });
    }

    const jump = document.querySelector('[data-page-url]');
    if (jump) {
      const pat = jump.getAttribute('data-page-url');
      if (pat && /%page%/i.test(pat.replace(/%25/g, ''))) jumpPattern = pat.replace(/&amp;/g, '&');
    }

    res.pageUrl = function (num) {
      try {
        if (numUrls.has(num)) return numUrls.get(num);
        if (template) {
          const u = setPageNum(template, num);
          if (u) return u;
        }
        if (jumpPattern) {
          const u2 = jumpPattern.replace(/%25page%25/gi, String(num)).replace(/%page%/gi, String(num));
          if (u2 && u2 !== jumpPattern) return new URL(u2, location.href).href;
        }
        return pageUrlForPage(location.href, num);
      } catch (e) {
        return pageUrlForPage(location.href, num);
      }
    };
    return res;
  }

  // ------------------------------------------------ fetch-crawl (fast)

  // Build the URL of page N from the base (current) URL — no tab navigation.
  function pageUrlForPage(baseUrl, num) {
    try {
      const href = String(baseUrl || location.href);
      if (/(?:[?&]page=)/.test(href)) return href.replace(/([?&]page=)\d+/, '$1' + num);
      return href + (href.indexOf('?') >= 0 ? '&' : '?') + 'page=' + num;
    } catch (e) {
      return null;
    }
  }

  async function fetchPage(url) {
    // Timeout! On Kiwi fetch can hang forever — without it the driver would
    // get stuck in scanning, and pause/stop could not stop it.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), CFG.FETCH_PAGE_TIMEOUT_MS || 25000);
    try {
      const res = await fetch(url, { credentials: 'include', redirect: 'follow', cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.text();
    } catch (e) {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  // Parse cards from an HTML string (no tab loads: DOMParser exists in the
  // content script but not in the service worker — so the crawl runs here).
  function parseCardsFromHtml(html) {
    if (!html) return [];
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const items = [];
      const seen = new Set();
      doc.querySelectorAll(SEL.cardItem).forEach((card) => {
        const a = card.querySelector(SEL.titleLink);
        if (!a) return;
        const m = (a.getAttribute('href') || a.href || '').match(SEL.resourceHrefRe);
        if (!m) return;
        const id = m[2];
        if (seen.has(id)) return;
        seen.add(id);
        items.push({
          id,
          slug: m[1],
          title: (a.textContent || '').trim(),
          url: location.origin + '/resources/' + m[1] + '.' + id,
          dlUrl: location.origin + '/resources/' + m[1] + '.' + id + '/download'
        });
      });
      return items;
    } catch (e) {
      return [];
    }
  }

  // ------------------------------------------------------------- driver

  // Sends one batch fire-and-forget (never waiting for the background — it
  // can hang on downloads.download), then waits up to BATCH_TIMEOUT_MS and
  // force-closes stuck items via 'expire' (the background re-queues them
  // with backoff). The MV3 worker dies between await points — if the
  // background goes silent (never took the batch or is stuck on it), the
  // driver re-sends the unresolved items.
  async function runBatchChunk(chunk) {
    const myIds = new Set(chunk.map((it) => String(it.id)));
    let sentAt = Date.now();
    let nudges = 0;
    const send = (items) => {
      chrome.runtime.sendMessage({ cmd: 'fetch-batch', items }).catch(() => {});
      sentAt = Date.now();
    };
    send(chunk);

    const deadline = Date.now() + CFG.BATCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const st = await load();
      if (!st || !st.running || st.paused) return false;
      const remaining = chunk.filter((it) => !st.done[it.id] && !st.failed[it.id]);
      if (remaining.length === 0) return true;
      const titles = remaining.slice(0, 4).map((it) => it.title).join(' · ') + (remaining.length > 4 ? ' …' : '');
      showStatus('Page ' + ((chunk[0] && chunk[0].page) || '?') + '/' + (st.maxPage || '?') + ' · waiting ' + remaining.length + ':\n' + titles);

      // The background may have died (MV3 worker): detect it by whether it
      // took the batch (s.batch) and whether there is any activity from it
      // (lastEventAt).
      const batchReg = (st.batch || []).some((r) => r && myIds.has(String(r.id)));
      const hasPend = (st.pendingCount || 0) > 0 ||
        Object.values(st.pendingStarted || {}).some((e) => e && myIds.has(String(e.id)));
      const quietFor = Date.now() - (st.lastEventAt || 0);
      if (nudges < 3) {
        const willNudge =
          (!batchReg && quietFor > 4000) ||                       // the background never took the batch
          (batchReg && !hasPend && remaining.length > 0 && quietFor > 20000); // the background went quiet
        if (willNudge) {
          nudges++;
          showStatus('Background silent — re-sending batch (' + nudges + '):\n' + titles);
          send(remaining);
        }
      }
      await sleep(CFG.PENDING_POLL_MS || 1000);
    }
    const st = await load();
    if (!st || !st.running || st.paused) return false;
    const stale = chunk.filter((it) => !st.done[it.id] && !st.failed[it.id]);
    if (stale.length) {
      showStatus('Timeout ' + Math.round(CFG.BATCH_TIMEOUT_MS / 1000) + ' s — restarting: ' + stale.map((it) => it.title).join(' · '));
      await chrome.runtime.sendMessage({ cmd: 'expire', ids: stale.map((it) => it.id) }).catch(() => {});
      await sleep(CFG.EXPIRE_SETTLE_MS || 2500);
    }
    return true;
  }

  async function runFromCurrentPage() {
    if (driving) return; // a run is already going — no second one
    driving = true;
    try {
      let s = await load();
      if (!s || !s.running || s.paused) return;

      const baseUrl = location.href;
      const page = getPagination();
      const max = Math.min(page.max || 1, CFG.MAX_PAGE_GUARD || 2000);

      // Collect cards from all pages: the current one from the DOM, the rest
      // via fetch.
      const all = [];
      const seenIds = new Set();
      const pushItems = (list, pg) => {
        for (const it of list || []) {
          if (seenIds.has(it.id)) continue;
          seenIds.add(it.id);
          it.page = pg || 1;
          all.push(it);
        }
      };
      pushItems(scanCurrentPage(), page.current || 1);

      if (all.length === 0 && max <= 1) {
        await setError('No cards found — open a Free category page');
        return;
      }

      // Quickly fetch the HTML of the remaining pages (no tab loads).
      for (let pg = 1; pg <= max; pg++) {
        s = await load();
        if (!s || !s.running || s.paused) return;
        const url = page.pageUrl ? page.pageUrl(pg) : pageUrlForPage(baseUrl, pg);
        if (!url) break;
        s.state = 'scanning';
        s.page = pg;
        s.maxPage = max;
        s.error = '';
        await save(s);
        showStatus('Scanning page ' + pg + '/' + max + '…');
        if (pg > 1) await sleep(CFG.PAGE_FETCH_DELAY_MS || 700);
        const html = await fetchPage(url);
        const parsed = parseCardsFromHtml(html);
        if (pg > 1 && !html) {
          // Network / blocking — do not push further, work with what we got.
          showStatus('Page ' + pg + ' did not load — continuing with collected (' + all.length + ')');
          break;
        }
        if (pg > 1 && parsed.length === 0) {
          // Session expired or the page is empty — close the crawl.
          showStatus('Page ' + pg + ' is empty — continuing with collected (' + all.length + ')');
          break;
        }
        pushItems(parsed, pg);
      }

      s = await load();
      if (!s || !s.running || s.paused) return;

      // Skip list: matching cards are marked done right away, not downloaded.
      const skip = parseSkip((await loadPrefs()).skipLines);
      let changed = false;
      for (const it of all) {
        if (!s.done[it.id] && !s.failed[it.id] && isSkipped(it, skip)) {
          markSkipped(s, it);
          changed = true;
        }
      }
      if (changed) {
        s.signal = (s.signal || 0) + 1;
        await save(s);
      }

      s = await load();
      if (!s || !s.running || s.paused) return;

      // Do not re-send anything "in progress" (no duplicates after reload/continue).
      const pendingIds = new Set(Object.values(s.pendingStarted || {}).map((e) => e && e.id));
      const fresh = all.filter((it) => !s.done[it.id] && !s.failed[it.id] && !pendingIds.has(it.id));
      if (fresh.length === 0) {
        await finishRun();
        return;
      }

      s.total = all.length;
      s.maxPage = max;
      s.pageUrl = baseUrl;
      s.nextUrl = null;
      s.state = 'downloading';
      s.error = '';
      await save(s);

      for (let i = 0; i < fresh.length; i += CFG.BATCH_SIZE) {
        const chunk = fresh.slice(i, i + CFG.BATCH_SIZE);
        const pg = (chunk[0] && chunk[0].page) || 1;
        s = await load();
        if (!s) return;
        if (s.page !== pg) {
          s.page = pg; // show which page the current files come from
          await save(s);
        }
        const ok = await runBatchChunk(chunk);
        s = await load();
        if (!s) return;
        if (!ok || !s.running || s.paused) return;
        if (fresh.length > i + CFG.BATCH_SIZE) await sleep(CFG.BATCH_DELAY_MS);
      }

      s = await load();
      if (!s || !s.running || s.paused) return;
      await finishRun();
    } catch (e) {
      console.error('[BBB] run:', e);
      await setError(String((e && e.message) || e));
    } finally {
      driving = false;
    }
  }

  async function setError(text) {
    const st = await load();
    if (!st) return;
    st.running = false;
    st.paused = false;
    st.state = 'error';
    st.error = text;
    await save(st);
  }

  async function finishRun() {
    const s = await load();
    if (!s) return;
    s.running = false;
    s.paused = false;
    s.state = 'done';
    s.nextUrl = null;
    s.batch = [];
    s.now = { downloading: [], waiting: [] };
    await save(s);
  }

  function freshState() {
    return {
      running: true,
      paused: false,
      state: 'starting',
      page: 1,
      maxPage: 1,
      pageUrl: location.href,
      nextUrl: null,
      done: {},
      failed: {},
      log: [],
      pendingStarted: {},
      retryQueue: [],
      batch: [],
      now: { downloading: [], waiting: [] },
      total: 0,
      pendingCount: 0,
      signal: 0,
      consecutiveFails: 0,
      lastEventAt: Date.now()
    };
  }

  // Start (no run / done / error) or Resume (paused/stopped).
  async function startOrResume() {
    if (driving) return; // the driver is already running — no duplicates
    let s = await load();
    if (s && s.running && !s.paused) return; // already running
    const isFresh = !s || s.state === 'done' || s.state === 'idle' || s.state === 'error';
    if (isFresh) {
      await chrome.runtime.sendMessage({ cmd: 'reset' }).catch(() => {});
      showStatus('Starting…');
      s = freshState();
      await save(s);
      await chrome.runtime.sendMessage({ cmd: 'arm' }).catch(() => {});
    } else {
      // Paused/stopped: resume LOCALLY (even if the background is asleep or
      // dead), and also tell the background to continue (it re-arms the alarm).
      s = s || {};
      // Files marked "canceled (USER_CANCELED)" go back to work: the next
      // run tries them again (e.g. after the user removes the duplicate from
      // the folder). Their done records are stripped for that.
      if (s.done) {
        const canceled = Object.keys(s.done).filter((k) => s.done[k] && s.done[k].mode === 'canceled');
        for (const k of canceled) delete s.done[k];
        if (canceled.length) showStatus('Re-queued ' + canceled.length + ' canceled file' + (canceled.length === 1 ? '' : 's') + ' for download');
      }
      s.running = true;
      s.paused = false;
      s.error = '';
      if (['done', 'idle', 'paused', 'stopped'].indexOf(s.state) >= 0) s.state = 'starting';
      s.signal = (s.signal || 0) + 1;
      await save(s);
      await chrome.runtime.sendMessage({ cmd: 'continue' }).catch(() => {});
      s = await load();
      if (!s) return;
    }
    await runFromCurrentPage();
  }

  // Pause/stop write the state DIRECTLY to storage: the panel and the driver
  // react instantly, even if the background worker is dead or not answering
  // (previously everything depended on a live background and its errors were
  // silently swallowed). The message to the background is best-effort
  // (cancel in-flight downloads and so on).
  async function pauseRun() {
    const s = (await load()) || {};
    s.running = false;
    s.paused = true;
    s.state = 'paused';
    s.error = '';
    s.signal = (s.signal || 0) + 1;
    await save(s);
    await chrome.runtime.sendMessage({ cmd: 'pause' }).catch(() => {});
  }

  async function stopRun() {
    const s = (await load()) || {};
    s.running = false;
    s.paused = true;
    s.state = 'stopped';
    s.error = '';
    s.pendingStarted = {};
    s.retryQueue = [];
    s.batch = [];
    s.now = { downloading: [], waiting: [] };
    s.pendingCount = 0;
    s.signal = (s.signal || 0) + 1;
    await save(s);
    await chrome.runtime.sendMessage({ cmd: 'stop' }).catch(() => {});
  }

  async function resetRun() {
    // Local removal — works even if the background does not answer;
    // a message to the background is sent too (it cleans up alarm/downloads).
    await chrome.storage.local.remove(KEY).catch(() => {});
    await chrome.runtime.sendMessage({ cmd: 'reset' }).catch(() => {});
    render(null);
  }

  async function exportLog() {
    const r = await chrome.runtime.sendMessage({ cmd: 'exportLog' }).catch(() => ({}));
    render(await load());
    if (r && r.empty) showStatus('The log is empty — nothing to export');
    else showStatus('Log exported ✓');
  }

  // ------------------------------------------------------------- card marks

  function injectStyles() {
    if (document.getElementById('bbb-styles')) return;
    const st = document.createElement('style');
    st.id = 'bbb-styles';
    st.textContent = [
      '[class*="js-resourceListItem-"] { position: relative; }',
      '.bbb-tint-ok { box-shadow: inset 0 0 0 200px rgba(46,204,113,.20) !important; }',
      '.bbb-tint-fail { box-shadow: inset 0 0 0 200px rgba(241,196,15,.25) !important; }',
      '.bbb-cardmark { position: absolute; top: 6px; right: 6px; z-index: 5; padding: 2px 7px; border-radius: 6px; font: 700 13px/1.2 system-ui; pointer-events: none; animation: bbb-pop .25s ease; }',
      '.bbb-cardmark--ok { background: rgba(46,204,113,.85); color: #fff; }',
      '.bbb-cardmark--pending { background: rgba(46,204,113,.35); color: #0b6b37; }',
      '.bbb-cardmark--fail { background: rgba(241,196,15,.9); color: #5c4500; }',
      '@keyframes bbb-pop { from { transform: scale(.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }'
    ].join('\n');
    document.head.appendChild(st);
  }

  function setBadge(card, cls, text) {
    let b = card.querySelector('.bbb-cardmark');
    if (!b) {
      b = document.createElement('div');
      card.appendChild(b);
    }
    b.className = cls;
    b.textContent = text;
  }

  // show = the toggle; active = a run is going (or was stopped).
  function applyCardMarks(s, show, active) {
    injectStyles();
    document.querySelectorAll(SEL.cardItem).forEach((card) => {
      card.classList.remove('bbb-tint-ok', 'bbb-tint-fail');
      let b = card.querySelector('.bbb-cardmark');
      if (b) b.remove();
      if (!show) return;
      const a = card.querySelector(SEL.titleLink);
      const m = a && (a.getAttribute('href') || a.href || '').match(SEL.resourceHrefRe);
      const id = m && m[2];
      if (id && s && s.done && s.done[id]) {
        card.classList.add('bbb-tint-ok');
        setBadge(card, 'bbb-cardmark bbb-cardmark--ok', '✓');
      } else if (id && s && s.failed && s.failed[id]) {
        card.classList.add('bbb-tint-fail');
        setBadge(card, 'bbb-cardmark bbb-cardmark--fail', '✗');
      } else if (active) {
        if (id) {
          card.classList.add('bbb-tint-ok');
          setBadge(card, 'bbb-cardmark bbb-cardmark--pending', '…');
        } else {
          card.classList.add('bbb-tint-fail');
          setBadge(card, 'bbb-cardmark bbb-cardmark--fail', '?');
        }
      }
    });
  }

  // ------------------------------------------------------------------ UI

  let panel = null;
  let badge = null;
  let headEl = null;
  let headLabel = null;
  let statusEl = null;
  let errEl = null;
  let progressWrap = null;
  let progressBar = null;
  let progressLabel = null;
  let btnStart = null;
  let btnStop = null;
  let btnReset = null;
  let btnMarks = null;
  let skipBox = null;
  let skipText = null;
  let prefsCache = null;
  // Guard against several drivers running at once (button + popup + auto
  // resume): only one runFromCurrentPage at a time.
  let driving = false;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function showStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function statusLines(s) {
    if (!s) return ['No saved state.'];
    const done = Object.keys(s.done || {}).length;
    const err = Object.keys(s.failed || {}).length;
    const pending = Object.keys(s.pendingStarted || {}).length + (s.retryQueue || []).length;
    const total = s.total || 0;
    const left = total > 0 ? Math.max(0, total - done - err) : 0;
    const lines = [];
    let head = 'files: ok ' + done + ' · err ' + err;
    if (total > 0) head += ' · total ' + total + (left ? ' · left ' + left : '');
    if (pending) head += ' · in progress ' + pending;
    lines.push(head);
    const nw = (s && s.now) || {};
    if (nw.downloading && nw.downloading.length) lines.push('downloading: ' + nw.downloading.join(' · '));
    if (nw.waiting && nw.waiting.length) lines.push('waiting: ' + nw.waiting.join(' · '));
    if (s.error) lines.push('Error: ' + s.error);
    const tail = (s.log || []).slice(-1)[0];
    if (tail && !s.error) {
      lines.push((tail.status === 'ok' ? '✓ ' : '✗ ') + '#' + tail.id + ' ' + tail.title + (tail.error ? ' — ' + tail.error : ''));
    }
    return lines;
  }

  function render(s) {
    if (!panel) return;
    const prefs = prefsCache;
    const meta = s ? STATE_COLOR[s.state] : '#7f8c8d';
    const label = s ? (STATE_LABEL[s.state] || s.state) : 'idle';
    headLabel.innerHTML = '';
    const dot = el('span', '', '●');
    dot.setAttribute('style', 'color:' + (meta || '#7f8c8d'));
    headLabel.appendChild(dot);
    headLabel.appendChild(el('span', '', ' ' + label + (s && s.maxPage ? ' — pg ' + (s.page || 0) + '/' + s.maxPage : '')));

    statusEl.textContent = statusLines(s).join('\n');

    // Progress bar: handled (ok + err) out of the total collected files.
    if (progressWrap) {
      const doneCnt = Object.keys((s && s.done) || {}).length;
      const errCnt = Object.keys((s && s.failed) || {}).length;
      const total = (s && s.total) || 0;
      const pct = total > 0 ? Math.min(100, Math.round(((doneCnt + errCnt) / total) * 100)) : 0;
      progressBar.style.width = pct + '%';
      progressLabel.textContent = total > 0 ? (doneCnt + errCnt) + '/' + total + ' · ' + pct + '%' : '';
      progressWrap.style.display = total > 0 ? '' : 'none';
    }

    const running = !!(s && s.running && !s.paused);
    const stopped = !!s && !s.running && s.paused;

    errEl.style.display = 'none';
    if (s) {
      const errs = (s.log || []).filter((e) => e.status === 'error');
      if (errs.length > 0) {
        errEl.textContent =
          'Errors (' + errs.length + '):\n' +
          errs.slice(-30).reverse().map((e) => '#' + e.id + ' ' + e.title + (e.error ? ' — ' + e.error : '')).join('\n');
        errEl.style.display = 'block';
      }
    }

    btnStart.disabled = false;
    btnStop.disabled = false;
    btnStart.textContent = running ? '⏸ Pause' : stopped ? '▶ Resume' : 'Start';
    // Stop is shown only while actually scanning/downloading;
    // in Idle/paused/stopped it is hidden.
    const showStop = running && ['starting', 'scanning', 'downloading'].indexOf(s.state) >= 0;
    btnStop.style.display = showStop ? '' : 'none';
    btnReset.style.display = running ? 'none' : '';
    if (btnMarks) btnMarks.textContent = prefs.marks ? 'Marks: on' : 'Marks: off';

    applyCardMarks(s, prefs.marks, !!(s && (running || stopped)));
  }

  function ensurePanel() {
    if (panel) return;
    injectStyles();
    panel = el('div');
    panel.id = 'bbb-panel';
    panel.setAttribute('style', [
      'position:fixed',
      'right:12px',
      'bottom:12px',
      'z-index:2147483647',
      'width:min(340px,calc(100vw - 24px))',
      'background:#1b1f24',
      'color:#e8e8e8',
      'font:13px/1.45 system-ui',
      'border-radius:10px',
      'box-shadow:0 4px 16px rgba(0,0,0,.4)',
      'overflow:hidden',
      'display:none'
    ].join(';'));

    headEl = el('div');
    headEl.id = 'bbb-head';
    headEl.setAttribute('style', 'padding:8px 10px;background:#23282f;font-weight:600;display:flex;justify-content:space-between;align-items:center');
    headLabel = el('span');
    headLabel.setAttribute('style', 'margin-left:8px;flex:1');
    headEl.appendChild(headLabel);
    const hide = el('span', '', '—');
    hide.setAttribute('style', 'cursor:pointer;padding:0 6px;font-weight:700');
    hide.title = 'Collapse';
    hide.addEventListener('click', () => collapse());
    headEl.appendChild(hide);

    const body = el('div');
    body.setAttribute('style', 'padding:10px 10px 12px');

    statusEl = el('div');
    statusEl.id = 'bbb-status';
    statusEl.setAttribute('style', 'background:#12161b;border:1px solid #2b3138;border-radius:6px;padding:8px 10px;margin-bottom:8px;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow:auto');

    errEl = el('div');
    errEl.id = 'bbb-errors';
    errEl.setAttribute('style', 'background:#4a211c;border:1px solid #7a352c;border-radius:6px;padding:8px 10px;font-size:12px;max-height:150px;overflow:auto;display:none;white-space:pre-wrap;word-break:break-word;margin-bottom:8px');

    // Progress bar: handled / total.
    progressWrap = el('div');
    progressWrap.id = 'bbb-progress';
    progressWrap.setAttribute('style', 'display:none;background:#12161b;border:1px solid #2b3138;border-radius:6px;height:20px;margin-bottom:8px;position:relative;overflow:hidden');
    progressBar = el('div');
    progressBar.id = 'bbb-progress-bar';
    progressBar.setAttribute('style', 'width:0%;height:100%;background:linear-gradient(90deg,#27ae60,#2ecc71);transition:width .3s ease');
    progressLabel = el('span');
    progressLabel.id = 'bbb-progress-label';
    progressLabel.setAttribute('style', 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:700 11px/1 system-ui;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.65)');
    progressWrap.appendChild(progressBar);
    progressWrap.appendChild(progressLabel);

    const mk = (id, cls, flex, text) => {
      const b = el('button', '', text);
      b.id = id;
      b.setAttribute('style', 'flex:' + flex + ';padding:9px 4px;border:0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;color:#fff;background:' + cls);
      return b;
    };

    btnStart = mk('bbb-start', '#27ae60', 2, 'Start');
    btnStop = mk('bbb-stop', '#c0392b', 1, '■ Stop');
    btnReset = mk('bbb-reset', '#7f8c8d', 1, 'Reset');
    const btnExport = mk('bbb-export', '#2980b9', 1, 'Export');
    btnMarks = mk('bbb-marks', '#34495e', 1, 'Marks: on');
    const btnSkip = mk('bbb-skipbtn', '#34495e', 1, 'List…');

    btnStart.addEventListener('click', async () => {
      const st = await load();
      if (st && st.running && !st.paused) {
        await pauseRun();
        render(await load());
      } else {
        showStatus('Starting…');
        await startOrResume();
      }
    });
    btnStop.addEventListener('click', async () => {
      await stopRun();
      render(await load());
    });
    btnReset.addEventListener('click', () => resetRun());
    btnExport.addEventListener('click', () => exportLog());
    btnMarks.addEventListener('click', async () => {
      prefsCache.marks = !prefsCache.marks;
      await savePrefs(prefsCache);
      render(await load());
    });
    btnSkip.addEventListener('click', toggleSkipBox);

    const row1 = el('div');
    row1.setAttribute('style', 'display:flex;gap:8px;margin-bottom:8px');
    row1.appendChild(btnStart);
    row1.appendChild(btnStop);

    const row2 = el('div');
    row2.setAttribute('style', 'display:flex;gap:8px;margin-bottom:8px');
    row2.appendChild(btnReset);
    row2.appendChild(btnExport);

    const row3 = el('div');
    row3.setAttribute('style', 'display:flex;gap:8px;margin-bottom:8px');
    row3.appendChild(btnMarks);
    row3.appendChild(btnSkip);

    // Skip-list dialog
    skipBox = el('div');
    skipBox.id = 'bbb-skip';
    skipBox.setAttribute('style', 'display:none;background:#12161b;border:1px solid #2b3138;border-radius:6px;padding:8px 10px;margin-bottom:8px');
    const skipTitle = el('div', '', 'Already downloaded (id or title, one per line):');
    skipTitle.setAttribute('style', 'margin-bottom:6px;color:#aeb6bd');
    skipText = el('textarea');
    skipText.id = 'bbb-skip-text';
    skipText.setAttribute('style', 'width:100%;box-sizing:border-box;height:90px;background:#0d1217;color:#e8e8e8;border:1px solid #2b3138;border-radius:6px;padding:6px;font:12px/1.4 monospace');
    const skipRow = el('div');
    skipRow.setAttribute('style', 'display:flex;gap:8px;margin-top:6px');
    const bSave = mk('', '#27ae60', 1, 'Save');
    const bClear = mk('', '#c0392b', 1, 'Clear');
    const bClose = mk('', '#7f8c8d', 1, 'Close');
    bSave.addEventListener('click', async () => {
      prefsCache.skipLines = skipText.value;
      await savePrefs(prefsCache);
      await applySkipNow();
      toggleSkipBox(false);
      showStatus('List saved ✓');
    });
    bClear.addEventListener('click', async () => {
      skipText.value = '';
      prefsCache.skipLines = '';
      await savePrefs(prefsCache);
      await applySkipNow();
      showStatus('List cleared');
    });
    bClose.addEventListener('click', () => toggleSkipBox(false));
    skipRow.appendChild(bSave);
    skipRow.appendChild(bClear);
    skipRow.appendChild(bClose);
    skipBox.appendChild(skipTitle);
    skipBox.appendChild(skipText);
    skipBox.appendChild(skipRow);

    const hint = el('div', '', 'Marks: green = seen/downloaded ✓, yellow = error/not found ✗');
    hint.setAttribute('style', 'color:#7e8790;font-size:11px;margin-top:4px');

    body.appendChild(statusEl);
    body.appendChild(progressWrap);
    body.appendChild(errEl);
    body.appendChild(skipBox);
    body.appendChild(row1);
    body.appendChild(row2);
    body.appendChild(row3);
    body.appendChild(hint);
    panel.appendChild(headEl);
    panel.appendChild(body);
    document.body.appendChild(panel);

    badge = el('div', '', 'BBB');
    badge.id = 'bbb-badge';
    badge.setAttribute('style', [
      'position:fixed',
      'right:12px',
      'bottom:12px',
      'z-index:2147483647',
      'background:#1b1f24',
      'color:#e8e8e8',
      'font:12px/1.4 system-ui',
      'padding:8px 14px',
      'border-radius:20px',
      'box-shadow:0 2px 10px rgba(0,0,0,.35)',
      'cursor:pointer'
    ].join(';'));
    badge.addEventListener('click', () => expand());
    document.body.appendChild(badge);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        if (changes.bbbState) render(changes.bbbState.newValue);
        if (changes.bbbPrefs) {
          const v = changes.bbbPrefs.newValue || {};
          prefsCache = { marks: v.marks !== false, skipLines: v.skipLines || '' };
          renderSync();
        }
      }
    });
  }

  async function renderSync() {
    render(await load());
  }

  function toggleSkipBox(force) {
    if (!skipBox || !skipText) return;
    const show = force !== undefined ? force : skipBox.style.display === 'none';
    skipBox.style.display = show ? 'block' : 'none';
    if (show) skipText.value = prefsCache.skipLines || '';
  }

  function expand() {
    if (panel) panel.style.display = 'block';
    if (badge) badge.style.display = 'none';
  }

  function collapse() {
    if (panel) panel.style.display = 'none';
    if (badge) badge.style.display = 'block';
  }

  // --------------------------------------------------------------- wiring

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.cmd === 'beginRun') {
      startOrResume();
      sendResponse({ ok: true });
    }
    return true;
  });

  async function init() {
    prefsCache = await loadPrefs();
    ensurePanel();
    render(await load());
    // Auto-resume after a tab reload: re-scan from scratch (done/failed/
    // in-progress filter out what was handled — no duplicates).
    const s = await load();
    if (s && s.running && !s.paused && s.pageUrl && location.href === s.pageUrl) {
      setTimeout(() => runFromCurrentPage(), 1200 + CFG.PAGE_LOAD_DELAY_MS);
    }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
