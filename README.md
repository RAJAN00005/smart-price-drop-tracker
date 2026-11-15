# Smart Price Drop Tracker

A local-only Manifest V3 Chrome extension for tracking product prices on Indian online stores. It detects the selling price on a product page, stores a price history in your browser, checks prices automatically on a schedule you choose, and notifies you when a price drops or reaches a target.

There is no account, backend, cloud sync, analytics, external API, or remotely hosted code. Everything runs inside the extension and `chrome.storage.local` on your device.

> **Honest testing note:** all eight retailer adapters are implemented and covered by **locally served mock HTML tests**. The Amazon India adapter was also manually checked against two live product pages (a wall clock and a pair of sandals) on 15 November 2026. The other seven adapters have **not** been tested against live production websites. Retailer markup changes often, so treat adapter support as best-effort. When detection fails, the popup's manual add/update flow still works. See [Limitations](#limitations).

---

## Contents

- [Features](#features)
- [Supported stores](#supported-stores)
- [Installation](#installation)
- [Using the extension](#using-the-extension)
- [How price detection works](#how-price-detection-works)
- [Automatic checks and notifications](#automatic-checks-and-notifications)
- [Permissions](#permissions)
- [Privacy and data](#privacy-and-data)
- [Backup, export and import](#backup-export-and-import)
- [Project structure](#project-structure)
- [Running the tests](#running-the-tests)
- [Development](#development)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Publishing to the Chrome Web Store](#publishing-to-the-chrome-web-store)

---

## Features

### Price detection

- Adapters for eight Indian retailers plus a generic extraction engine for other stores.
- Extracts title, product image, selling price, MRP/original price, currency, availability and canonical URL.
- Parses Indian price formats such as `₹1,25,999`, `Rs. 1,25,999`, `INR 125999` and `1,25,999.00`.
- Prefers the actual selling price over MRP, EMI instalments, coupon discounts, delivery charges, exchange offers and "save ₹X" labels.
- Cross-checks site-specific selectors, JSON-LD (`Product`/`Offer`), meta tags, microdata and visible DOM text.
- Scores every result with a confidence value. Results below the confirmation threshold are never saved automatically; the popup asks you to confirm or edit the price instead.
- Detects CAPTCHA/block pages and reports them as blocked rather than guessing a price.
- Detects out-of-stock and unavailable products.
- Preserves the last valid price and history entry when a check fails.

### Tracking

- Track products from the popup on the current tab.
- Manual "add this page" fallback when a site is unsupported or detection fails.
- Manual price updates from the popup and dashboard.
- Optional target price with target-reached notifications.
- Per-product monitoring on/off, tracking pause, check frequency (6, 12 or 24 hours) and default frequency (12 hours).
- Search, filter (all, active, paused, has drops, at lowest, needs attention) and sort in the dashboard.
- Up to 500 tracked products; up to 2,000 history entries per product (the oldest observation is preserved when trimming).

### Dashboard

- Overview with total products, active monitors, total savings, products at their lowest price, recent drops and attention items.
- Products list with search, filters, sort and quick actions.
- Product detail page with:
  - current, previous, original, lowest, highest and average prices;
  - total drops, target price, availability, store and last/next check status;
  - native SVG history chart with 7-day, 30-day, 90-day and all-time ranges;
  - full price history table;
  - target price form, frequency selector, monitoring toggle, manual price entry and delete.
- Settings page with default frequency, notification toggles, theme (light/dark/system), site access management, storage usage and backup tools.
- Light and dark themes, responsive layout, keyboard-accessible controls, focus-trapped modals and reduced-motion support.

### Data and privacy

- All products and settings live in `chrome.storage.local`.
- Automatic checks fetch and parse pages in an offscreen document. No browser tabs are opened. Legacy temporary-tab IDs from older versions are cleaned up on startup.
- JSON backup export, CSV export, validated JSON import (merge or replace).
- Import validates the file size, schema, product fields, prices, URLs, history and settings before writing anything.
- Site permissions are never included in backups.
- No network requests to the developer or any third party. Product images are loaded from the retailer's own image servers when the dashboard/popup displays them.

---

## Supported stores

| Store | Adapter | Detection tested against |
| --- | --- | --- |
| Amazon India (`amazon.in`) | Yes | Local mock page + two live product pages (manual check) |
| Flipkart (`flipkart.com`) | Yes | Local mock page only |
| Myntra (`myntra.com`) | Yes | Local mock page only |
| AJIO (`ajio.com`) | Yes | Local mock page only |
| Croma (`croma.com`) | Yes | Local mock page only |
| Reliance Digital (`reliancedigital.in`) | Yes | Local mock page only |
| Tata CLiQ (`tatacliq.com`) | Yes | Local mock page only |
| Meesho (`meesho.com`) | Yes | Local mock page only |
| Any other `http(s)` store | Generic engine | Local mock page only |

The adapters use stable-looking selectors and structured data, but live pages can differ because of A/B tests, regional layouts, login state, personalisation or markup changes. The Amazon adapter was manually checked against two live desktop product pages; the other adapters are mock-tested only. If an adapter misses a price, use **Wrong price? Edit it** in the popup or the manual form on the dashboard.

---

## Installation

The extension is not yet published in the Chrome Web Store. Load it unpacked:

1. Download or clone this folder. The extension root is the `smart-price-tracker` folder (the one containing `manifest.json`).
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the `smart-price-tracker` folder.
5. Pin **Smart Price Drop Tracker** from the extensions menu if you want quick access.
6. Open a product page on a supported store, click the extension icon, and track the product.

Microsoft Edge works the same way via `edge://extensions` → **Developer mode** → **Load unpacked**.

**Requirements**

- Chrome 116 or newer (Manifest V3, `chrome.offscreen`, `chrome.storage.session`, `scripting.executeScript`).
- No build step, package install or bundler is required to use the extension.
- Node.js and npm are only needed to run the automated tests and regenerate icons.

**Updating**

After changing extension files, return to `chrome://extensions` and click the reload icon on the extension card. Open tabs may need a refresh before the popup can read them again.

---

## Using the extension

### Track a product from the popup

1. Open a product detail page (not a search results page).
2. Click the toolbar icon.
3. The popup shows the detected store, title, image, selling price, MRP and a confidence chip.
4. If the price is ambiguous or low-confidence, a warning appears with the candidate prices. Edit the price if needed.
5. Optionally enter a target price.
6. Leave **Automatic price checks** on if you want scheduled checks. Chrome will ask for permission for that store's origin the first time.
7. Click **Track Price**.

The popup also shows an **Already tracking** view with the saved price, target, lowest price, last check and next check, plus buttons to open the product detail page or update the price manually.

### Add a page manually

If the page cannot be detected (unsupported layout, CAPTCHA, missing price), choose **Add manually** in the popup. Enter the product name, current price and optional target. Manual products keep their last entered price until you update them or a permitted automatic check succeeds.

### Use the dashboard

Click **Open dashboard** in the popup, use the extension's **Options** entry, or open `chrome-extension://<extension-id>/dashboard/dashboard.html`. The dashboard has three hash routes:

- `#overview` — summary cards and recent activity.
- `#products` — searchable/filterable product list.
- `#product=<id>` — product detail, chart and history.
- `#settings` — preferences, site access and backup tools.

---

## How price detection works

The extraction engine has two entry points:

- **Popup:** runs on demand in the current tab's isolated world via `chrome.scripting.executeScript`. It is never installed as an always-on content script.
- **Automatic checks:** the background worker fetches the product HTML in an offscreen document, parses it with `DOMParser`, and runs the same extraction engine against the parsed page. No tab is created and nothing is injected into your browsing tabs.

The extension does not read pages until you open the popup or a scheduled check runs.

For each page the engine:

1. Identifies the store from the hostname.
2. Runs the store adapter, JSON-LD, meta tag, microdata and generic DOM strategies.
3. Rejects amounts that look like EMI, delivery, discounts, coupons or unrelated savings.
4. Normalises prices and currency.
5. Merges candidates and computes a confidence score.
6. Flags conflicts (for example, an adapter price that differs from JSON-LD) and low confidence for user confirmation.
7. Returns the product data, candidates, conflicts, availability and any error code.

Confidence is roughly:

| Source | Typical confidence |
| --- | --- |
| Store-specific price selector | ~0.96 |
| JSON-LD offer | ~0.91 |
| Meta tags | ~0.84–0.90 |
| Generic DOM selectors | ~0.60–0.86 |
| Whole-page fallback | ~0.40–0.60 |

The confirmation threshold is **0.72**. A result below it, or one with conflicting candidates, is shown for review and is **not** saved automatically.

Failures are explicit. The extension uses error codes such as `PRICE_NOT_FOUND`, `LOW_CONFIDENCE`, `CAPTCHA`, `BLOCKED`, `PERMISSION_REQUIRED`, `NETWORK`, `TIMEOUT` and `INJECTION_FAILED`. On failure, the product keeps its last valid price and history, records the check status and error, and (for automatic checks) schedules a retry.

The extension does **not** attempt to bypass CAPTCHAs, logins, paywalls or bot protection. If a store blocks automated visits, automatic checks for that store will keep failing until you check manually or disable monitoring.

---

## Automatic checks and notifications

- Each monitored product gets its own one-shot `chrome.alarms` alarm (`spt:check:<productId>`). A six-hour maintenance alarm repairs missing or stale schedules.
- Frequencies are 6, 12 or 24 hours; the default is 12.
- Checks run in an offscreen document that fetches and parses the page. No tabs are opened, focused or closed.
- A small queue limits concurrent checks (default 2, configurable up to 4).
- The service worker uses a keepalive interval while a check is running to reduce MV3 worker suspension mid-check.
- Failed checks preserve the last valid price and schedule a later retry.
- Notifications are deduplicated by the last notified price so the same price does not alert repeatedly.
- A combined notification is used when a product reaches its target and also drops in price.
- Clicking a notification opens the product page. The notification action button opens the product URL.
- Chrome must be running for alarms to fire. Alarms can be delayed by Chrome/OS power management; the next alarm continues the schedule.

Automatic checks require an optional host permission for the exact store origin. The popup/dashboard requests it from a user gesture with `chrome.permissions.request`, and you can remove it later in **Settings → Site access**. Without permission, tracking and manual updates still work; automatic checks stay off.

---

## Permissions

| Permission | Why it is used |
| --- | --- |
| `storage` | Save products, settings and legacy cleanup state locally. |
| `alarms` | Schedule per-product checks and maintenance. |
| `notifications` | Show price-drop and target alerts. |
| `activeTab` | Read the current tab after you click the extension icon. |
| `scripting` | Inject the extraction engine into the current tab after you click the extension icon. |
| `offscreen` | Fetch and parse product HTML for scheduled checks without opening a tab. |
| Optional host permissions (`https://*/*`, `http://*/*`) | Request access to one exact store origin only when you enable automatic checks. Nothing is granted at install time. |

There are no content scripts, no `<all_urls>` install-time host access, no `webRequest`, no remote code and no developer-operated server. The only extension-initiated requests are to the product pages you choose to monitor and the retailer image URLs shown in the UI.

---

## Privacy and data

- **Local only.** Products, price history, settings and check status are stored in `chrome.storage.local`. They are not synced to your Google account and are not sent anywhere.
- **Offscreen checks.** Scheduled checks run in an extension-owned offscreen document. It fetches the product page you asked to monitor and passes the HTML to the local parser; the HTML is not stored.
- **Images.** Product image URLs point at retailer CDNs. Displaying an image makes a normal browser request to that retailer, just like visiting the page.
- **No tracking.** There is no analytics, telemetry, advertising, account system or third-party service.
- **Deletion.** Removing a product deletes its stored record and history. Removing the extension deletes all extension storage. Use the JSON export first if you want a backup.
- **Backups.** Exported JSON/CSV files are written wherever your browser saves downloads. Treat them as personal data; they contain product names, URLs, prices and settings, but never site permissions.

---

## Backup, export and import

From **Settings → Data** (or the dashboard toolbar icons):

- **Export JSON** — a versioned backup containing products, full price history and settings.
- **Export CSV** — a spreadsheet-friendly product list (current price, original price, target, lowest, highest, average, drops, store, URL, dates, status).
- **Import backup** — choose a JSON backup, preview the validation summary, then pick:
  - **Merge** — adds valid products, skips records whose normalised URL already exists, keeps existing products and settings.
  - **Replace** — replaces all products with the backup's products and restores backup settings.
- Invalid JSON, unsupported schemas, oversized files and records with bad prices/URLs are rejected before anything is written.

Imported product IDs are regenerated to avoid collisions. Import does not restore host permissions; enable automatic checks again per store if needed.

---

## Project structure

```
smart-price-tracker/
├── manifest.json
├── background/
│   ├── service-worker.js        # MV3 entry point, message API, lifecycle listeners
│   ├── alarm-manager.js         # per-product alarms, maintenance, next-check math
│   ├── notification-manager.js  # price-drop/target notifications, dedupe, clicks
│   └── price-monitor.js         # check queue, offscreen fetch, failure handling
├── offscreen/
│   ├── offscreen.html           # hidden document host for background checks
│   └── offscreen.js             # fetch + DOMParser + extraction worker
├── extractors/
│   ├── extraction-client.js     # on-demand injection and site-permission helpers
│   ├── extractor-core.js        # shared candidate scoring and structured-data parsing
│   ├── generic-extractor.js     # JSON-LD/meta/microdata/DOM fallback
│   ├── amazon-extractor.js
│   ├── flipkart-extractor.js
│   ├── myntra-extractor.js
│   ├── ajio-extractor.js
│   ├── croma-extractor.js
│   ├── reliance-extractor.js
│   ├── tata-cliq-extractor.js
│   ├── meesho-extractor.js
│   └── extractor-registry.js
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js                 # detect, confirm, track, update, manual add
├── dashboard/
│   ├── dashboard.html
│   ├── dashboard.css
│   └── dashboard.js             # overview, products, detail, chart, settings, import/export
├── storage/
│   ├── data-model.js            # schema, history, statistics, backup/CSV validation
│   └── storage-manager.js       # one-key-per-product storage + mutation mutex
├── utils/
│   ├── date-utils.js
│   ├── price-parser.js          # Indian price parsing/formatting
│   ├── url-normalizer.js        # URL cleaning, store detection helpers
│   ├── validation.js            # input/error/settings validation and limits
│   ├── site-catalog.js          # retailer catalog and host matching
│   └── theme-init.js            # pre-paint theme application
├── assets/
│   ├── icon.svg
│   └── icons/                   # 16/32/48/128 PNG icons
├── tests/
│   ├── unit/                    # Node test runner suites
│   ├── e2e/                     # Playwright E2E harness
│   └── fixtures/                # mock retailer and edge-case HTML pages
├── store/
│   ├── PUBLISHING.md            # step-by-step Chrome Web Store release guide
│   ├── LISTING.md               # store listing copy and screenshot order
│   ├── privacy-site/index.html  # privacy policy ready for GitHub Pages
│   └── screenshots/             # five 1280x800 store screenshots
├── tools/
│   └── generate-icons.mjs
├── package.json
└── README.md
```

Shared browser code uses classic IIFE scripts that expose `globalThis.SPT`. The service worker loads them with `importScripts`; extension pages use `<script defer>`; the extraction engine is injected as a file list followed by a small runner function.

---

## Running the tests

The automated tests use mock pages and controlled data. They do not visit live retailers.

### Prerequisites

- Node.js 20+ (developed with Node 24).
- npm.
- For E2E: Playwright Chromium and its system dependencies.

```bash
npm install
npx playwright-core install chromium
```

### Unit tests

```bash
npm test
```

Runs the Node built-in test runner against `tests/unit/*.test.js`:

- price parsing and formatting, including Indian grouping and noise rejection;
- date/history range filtering;
- URL normalisation and store matching;
- validation, limits, settings sanitisation and negative-price rejection;
- product schema, history trimming, statistics, backup validation and CSV escaping;
- site catalog and extractor selection.

Current result: **60 passed, 0 failed**.

### End-to-end tests

```bash
npm run test:e2e
```

The E2E harness launches a real Chromium with the unpacked extension and covers:

- **Extraction (16 tests):** all eight retailer adapters, an Amazon live-layout regression fixture based on the current desktop DOM (visible `.priceToPay` plus opacity-hidden offscreen text, served locally), generic fallback, discount/EMI traps, conflicting JSON-LD vs adapter prices, CAPTCHA, missing price, low confidence and out-of-stock.
- **Dashboard, settings, backup and popup (12 tests):** empty state, help modal, tracking overview, product search/reset, product image rendering above the fallback tile, detail chart ranges/history/target, settings auto-save/notification gating/theme, JSON and CSV export, merge/replace import, invalid backup rejection, popup unsupported state, product deletion and page-error checks.
- **Automatic monitoring (8 tests):** alarm scheduling, manual check with price drop/history and no tab creation, repeated drops, CAPTCHA/missing-price/low-confidence preservation and recovery, automatic alarm path, failure rescheduling, automatic recovery and page-error checks.

Current result: **36 passed, 0 failed**.

**E2E notes**

- The monitoring suite uses a test-only copy of the manifest with `host_permissions: ["https://www.amazon.in/*"]`. The shipped `manifest.json` does not grant install-time host access.
- It serves mock Amazon pages from a local HTTPS server with a runtime-generated self-signed certificate and maps `www.amazon.in` to `127.0.0.1` via Chrome flags. This is required because the offscreen document fetches the page outside any Playwright-managed tab, so Playwright routes cannot intercept it.
- Certificate generation currently uses Windows PowerShell (`New-SelfSignedCertificate`), so the monitoring suite is Windows-specific. The extraction and dashboard suites are platform-independent. On macOS/Linux you can supply an equivalent certificate or skip the monitoring suite.
- Set `SPT_CHROMIUM` to an explicit Chrome/Chromium executable if Playwright's bundled browser is not found.
- Test profiles and certificates are created in the OS temp directory and removed after each suite.

---

## Development

### No build step

Edit the files and reload the extension at `chrome://extensions`. The manifest points directly at source files.

### Add or update a retailer adapter

1. Add the store to `utils/site-catalog.js` (`id`, `name`, `hostSuffixes`, currency, accent, initials).
2. Create `extractors/<store>-extractor.js` exposing `globalThis.SPT.Extractors.<id>` with a `detect`/`extract` implementation consistent with the existing adapters.
3. Add the file to `extractors/extraction-client.js` (`FILES` array).
4. Add it to the extraction file list in `tests/e2e/helpers.mjs` (`EXTRACTION_FILES`).
5. Add a mock fixture under `tests/fixtures/` and an E2E case.
6. Reload the extension and test against both the mock fixture and a real page. Do not weaken the confidence/confirmation rules to make an unreliable selector pass.

### Regenerate icons

```bash
npm run icons
```

This regenerates the PNG icons from `assets/icon.svg` using only Node's built-in modules.

### Coding conventions

- ES6+ but no bundler; browser scripts are classic IIFEs under `globalThis.SPT`.
- No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` or `new Function` in extension code. Dynamic UI is built with DOM APIs and `textContent`.
- All storage mutations go through the background message API, which serialises writes with a promise mutex.
- New user-visible strings should be plain text and sanitised/limited before storage or display.
- Keep host permissions optional and scoped to exact origins.

---

## Limitations

- **Adapters are mostly mock-tested.** Amazon India was manually checked against two live product pages; the other seven adapters are mock-tested only. Retailer markup, bot protection and regional layouts change, so detection can still fail on live pages.
- **No CAPTCHA/login/paywall bypass.** Blocked pages are reported, not circumvented.
- **Chrome must be open.** Alarms do not run when the browser is closed, and Chrome may delay alarms under power-saving or heavy load.
- **Optional host permissions are required** for automatic checks. Without them, products can still be tracked and updated manually.
- **Generic extraction is best-effort.** Heavily client-rendered pages, variant pricing, member-only prices and location-dependent prices may be ambiguous; the extension asks for confirmation instead of saving a guess.
- **Price history is capped** at 2,000 entries per product. The oldest observation is retained.
- **No cross-device sync.** Storage is local to the browser profile. Use JSON export/import to move data manually.
- **Images come from retailer CDNs**, so broken/blocked images are possible; the UI falls back to an initials tile.
- **CSV is an export only.** There is no CSV import.
- **Backup import does not restore site permissions.**
- **Notification delivery depends on OS/browser settings.** Focus Assist, Do Not Disturb or disabled Chrome notifications can suppress alerts.
- **Not yet published or reviewed by the Chrome Web Store.** Until it is listed, load unpacked and use at your own discretion.
- **No warranty.** This is a personal utility; verify prices on the retailer's page before making purchase decisions.

---

## Troubleshooting

**"This page can't be tracked" in the popup**

- Make sure you are on a product detail page over `http(s)`, not a browser-internal page (`chrome://`, `edge://`, the Chrome Web Store, a PDF viewer or a blank tab).
- Wait for the page to finish loading, then click **Try again**.
- Use **Add manually** if the layout is unsupported.

**Automatic checks are not running**

- Open **Settings → Site access** and allow the exact store origin.
- Confirm the product's monitoring toggle is on and its frequency is set.
- Chrome must be open; check `chrome://extensions` for service-worker errors.
- Check the product detail page for the last check status and error message.

**A price looks wrong**

- Use **Wrong price? Edit it** in the popup or the manual price form on the product detail page.
- Conflicting or low-confidence detections are intentionally not saved automatically.
- Report/ignore retailer-specific noise such as EMI text; the adapters already filter common cases, but layouts vary.

**No notifications**

- Check **Settings → Notifications** (master toggle plus price-drop and target toggles).
- Check the OS notification settings for Chrome.
- Notifications are deduplicated by price; a product that has not dropped below the last notified price will not alert again.

**Import says the backup is invalid**

- Use a JSON backup exported by this extension.
- Do not edit the schema version or product fields manually.
- The file must be under 15 MB and contain valid products/settings.

**Chrome shows "Manifest file is missing or unreadable"**

- Select the folder that directly contains `manifest.json` (the `smart-price-tracker` folder), not its parent.

---

## Publishing to the Chrome Web Store

The extension is not published yet. The `store/` folder contains everything needed for a Chrome Web Store release:

- `store/PUBLISHING.md` — step-by-step developer account, privacy policy hosting, ZIP build, listing, privacy disclosures and review instructions.
- `store/LISTING.md` — ready-to-paste name, short description, detailed description and screenshot order.
- `store/privacy-site/index.html` — standalone privacy policy page, ready to host on GitHub Pages or any HTTPS host.
- `store/screenshots/` — five 1280 × 800 PNG screenshots.

Before publishing, run `npm test` and `npm run test:e2e`, reload the unpacked extension, and verify that a scheduled check updates a price without opening a tab.

---

## Disclaimer

Smart Price Drop Tracker is an independent utility and is not affiliated with Amazon, Flipkart, Myntra, AJIO, Croma, Reliance Digital, Tata CLiQ, Meesho or any other retailer. Retailer names and trademarks belong to their respective owners. Use the extension in line with each site's terms and do not use it to place excessive load on retailer servers.

---

Developed by Raajan.
