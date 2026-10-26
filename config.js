(function (global) {
  global.BBB_CONFIG = {
    // Chrome keeps up to ~19 simultaneous downloads, so a batch of 8 is safe.
    // A small delay between batches (anti-bot + Kiwi).
    BATCH_SIZE: 8,
    BATCH_DELAY_MS: 1500,
    PAGE_LOAD_DELAY_MS: 700,
    // Pause between fetch() requests for catalog pages (fetch instead of full
    // tab loads — roughly twice as fast).
    PAGE_FETCH_DELAY_MS: 700,
    DOWNLOAD_TIMEOUT_MS: 120000,
    STUCK_ALARM_PERIOD_MIN: 1,
    MAX_PAGE_GUARD: 2000,
    // Transient download failures (USER_CANCELED, interrupted, throttled)
    // are retried automatically with the delays below. HTML-result downloads
    // are NOT retried (they are deterministic: "download manually").
    RETRY_ATTEMPTS: 3,
    RETRY_DELAYS_MS: [2000, 5000, 12000],
    // Filename collisions: Android/Kiwi cancels the download (USER_CANCELED)
    // if a file with that name already exists and does not uniquify on its
    // own. So we re-download under a free "base (N)ext" name ourselves:
    // how many tries per file, and with which delay.
    UNIQUIFY_MAX_TRIES: 3,
    UNIQUIFY_RETRY_DELAY_MS: 3000,
    PENDING_POLL_MS: 1000,
    // Timeout for the INITIALIZATION of a single downloads.download call
    // (on Kiwi it sometimes hangs forever). Once expired we stop waiting
    // and re-queue the file; a late resolution (if it ever arrives) still
    // registers the download separately.
    DOWNLOAD_INIT_TIMEOUT_MS: 8000,
    // Timeout for one fetch() of a catalog page: on Kiwi fetch can hang
    // forever — without a timeout the driver would freeze in scanning with
    // no chance to pause/stop. On expiry the page counts as "not loaded".
    FETCH_PAGE_TIMEOUT_MS: 25000,
    // The driver waits at most this long for a batch; stuck items are
    // force-closed with the 'expire' command and the run moves on
    // (the background re-queues them with backoff).
    BATCH_TIMEOUT_MS: 45000,
    EXPIRE_SETTLE_MS: 2500,
    SELECTORS: {
      cardItem: '[class*="js-resourceListItem-"]',
      titleLink: '.structItem-title a',
      resourceHrefRe: /\/resources\/([a-z0-9-]+)\.(\d+)\/?/,
      pageNavMain: '.pageNav-main',
      pageNavPage: '.pageNav-page',
      pageNavSpan: 'span[onclick]',
      loggedInAttr: 'data-logged-in'
    }
  };
})(typeof self !== 'undefined' ? self : window);
