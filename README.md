# BBB Free Auto-Downloader

A Chrome extension that grabs every free resource from a BuiltByBit Free category and downloads the files for you, in batches.

Works on desktop Chrome as well as mobile Chromium browsers (Kiwi and similar Android forks). On desktop there is also a popup, but the on-page panel is the main interface everywhere.

## What it does

- Opens a Free category page, then finds all resource cards across every page of that category (pagination is fetched, the tab never reloads).
- Downloads each file in small batches with delays, so it doesn't hammer the site.
- Marks cards right on the page: green = downloaded, yellow = failed.
- Skips anything already in the browser's download history and lets you maintain a skip list (ids or title keywords, one per line).
- Retries what failed: transient download errors get a few attempts with backoff, timed-out ones are re-queued automatically.
- Never downloads the same file twice: pause, stop, close the tab (it resumes on reload), even restart the browser; done and failed items are re-scanned but not re-downloaded.
- Shows progress in an on-page panel: status, what's downloading right now, a progress bar, and the list of errors. There is also a small popup for desktop.
- Exports the run log as a .txt file.

A download that turns out to be an .html file counts as a failure (that usually means the site asked you to download manually) and is not retried.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable Developer mode (top right)
3. Click **Load unpacked** and select this folder

On Android (Kiwi and similar browsers) the same steps work through the three-dot menu → Extensions → Developer mode.

## Use

1. Log in on builtbybit.com and open a Free category page.
2. Press **Start** in the panel on the page (or in the popup).
3. Leave the tab open. Pause/Stop/Resume/Reset are in the panel.

## Files

- `manifest.json`: MV3 manifest
- `config.js`: selectors and tuning constants (shared by all parts)
- `background.js`: service worker, downloads, retries, alarms, message handlers
- `content.js`: the on-page panel and the crawl driver
- `popup.html` / `popup.js`: desktop popup

Everything is plain JS: no build step, no dependencies.

## Disclaimer

This project is not affiliated with or endorsed by BuiltByBit. Use it at your own risk: automating the site is probably against its Terms of Service, and your BuiltByBit account is your responsibility, not the author's. Use the tool for personal use only and don't run it aggressively. Don't post copyrighted resources anywhere it violates their terms.

## License

[MIT](LICENSE)
