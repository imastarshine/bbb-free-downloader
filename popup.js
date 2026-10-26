const $ = (s) => document.querySelector(s);

let currentTab = null;

function loadState() {
  return chrome.storage.local.get('bbbState').then((d) => d.bbbState || null);
}

function stateLine(s) {
  if (!s) return 'No saved state.';
  const label =
    { starting: 'Starting', navigating: 'Navigating', scanning: 'Scanning', downloading: 'Downloading', 'waiting-advance': 'Moving on', stopped: 'Stopped', done: 'Done', error: 'Error', idle: 'Idle' }[s.state] ||
    s.state;
  const doneCount = Object.keys(s.done || {}).length;
  const errCount = Object.keys(s.failed || {}).length;
  let txt = 'Status: ' + label;
  if (s.error) txt += '\nError: ' + s.error;
  if (s.running || s.state === 'stopped' || s.state === 'done') {
    txt += '\nPage: ' + (s.page || 0) + '/' + (s.maxPage || '?');
    txt += '\nDownloaded: ' + doneCount + '   Errors: ' + errCount;
    if (s.maxPage && s.page >= s.maxPage) txt += '\nThis is the last page of the category.';
  }
  return txt;
}

function renderStatus(s) {
  $('#status').textContent = stateLine(s);
  const errs = (s ? s.log || [] : []).filter((e) => e.status === 'error');
  const errBox = $('#errors');
  if (errs.length > 0) {
    const list = errs
      .slice(-25)
      .reverse()
      .map((e) => '#' + e.id + ' ' + e.title + (e.error ? ' — ' + e.error : ''))
      .join('\n');
    errBox.textContent = 'Errors (' + errs.length + '):\n' + list;
    errBox.style.display = 'block';
  } else {
    errBox.style.display = 'none';
  }
}

function send(cmd) {
  return chrome.runtime.sendMessage({ cmd }).catch((e) => console.error(e));
}

function isResourceTab(url) {
  return url && url.includes('builtbybit.com') && url.includes('/resources/');
}

function init() {
  Promise.all([loadState(), chrome.tabs.query({ active: true, currentWindow: true })])
    .then(([st, tabs]) => {
      currentTab = tabs && tabs[0] ? tabs[0] : null;
      renderStatus(st);
      $('#start').disabled = !currentTab || !isResourceTab(currentTab.url);
      if (!$('#start').disabled && st && st.running) $('#start').disabled = true;
      $('#stop').disabled = !st || !st.running;
      $('#stop').style.display = st && st.running ? '' : 'none';
      $('#start').textContent = st && st.running ? 'Running…' : st && !st.running && st.paused ? 'Resume' : 'Start / Resume';
    });

  $('#start').addEventListener('click', () => {
    if (!currentTab || !isResourceTab(currentTab.url)) {
      $('#status').textContent = 'Open a category page on builtbybit.com first.';
      return;
    }
    chrome.runtime
      .sendMessage({ cmd: 'start', tabId: currentTab.id, url: currentTab.url })
      .then(() => setTimeout(init, 500));
  });

  $('#stop').addEventListener('click', () => send('stop').then(() => setTimeout(init, 400)));
  $('#reset').addEventListener('click', () => {
    send('reset').then(() => setTimeout(init, 300));
  });

  $('#export').addEventListener('click', async () => {
    const st = await loadState();
    const logs = (st && st.log) || [];
    if (logs.length === 0) {
      $('#status').textContent = 'Nothing to export yet — the log is empty.';
      return;
    }
    const lines = logs.map((e) => [e.status, e.filename, e.dlUrl, e.error].join('\t'));
    const text = lines.join('\n');
    const url = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    chrome.downloads.download({ url: url, filename: 'bbb_log_' + stamp + '.txt', saveAs: true });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.bbbState) {
      renderStatus(changes.bbbState.newValue);
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
