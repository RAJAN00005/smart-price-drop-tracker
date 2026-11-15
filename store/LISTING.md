# Chrome Web Store listing copy

Use the text below in the Chrome Web Store Developer Dashboard. Fields have character limits;
the copy here is written to fit them.

## Name

```
Smart Price Drop Tracker
```

## Short description (max 132 characters)

```
Track product prices privately on your device. See price history, set targets and get alerts when prices drop.
```

## Detailed description

```
Smart Price Drop Tracker is a local-only shopping companion for Indian online stores. It keeps a price history for the products you choose, checks them on a schedule, and notifies you when the price drops or reaches your target.

WHY PEOPLE USE IT
• See the real selling price instead of MRP, EMI, coupon or delivery amounts.
• Keep a price history chart with 7-day, 30-day, 90-day and all-time views.
• Set a target price and get a local notification when it is reached.
• Check prices automatically in the background without opening browser tabs.
• Search, filter and sort your watchlist in a full dashboard.
• Export a JSON backup or CSV file whenever you want.

PRIVATE BY DESIGN
• No account, sign-up or cloud sync.
• No developer server, analytics, telemetry or advertising.
• Products, price history and settings stay in chrome.storage.local on your device.
• Site access is optional and requested one exact store origin at a time.
• Nothing is granted at install time except the permissions needed for the popup and local storage.
• No remotely hosted code.

HOW IT WORKS
Open a product page and click the extension icon. The popup detects the title, image, selling price and MRP, then lets you set an optional target price. If you enable automatic checks, the extension asks for access to that store's origin and schedules a check every 6, 12 or 24 hours. Automatic checks fetch and parse the page in a hidden offscreen document, so no tabs are opened. If a page is blocked by a CAPTCHA or bot protection, the extension reports it and keeps your last valid price.

SUPPORTED STORES
Amazon India, Flipkart, Myntra, AJIO, Croma, Reliance Digital, Tata CLiQ and Meesho have dedicated adapters. Other http(s) product pages use a generic extractor. Retailer layouts change often, so detection is best-effort. Amazon India was manually checked against two live product pages; the other adapters are tested against mock pages only. You can always edit a price manually or add a product manually if detection fails.

IMPORTANT
• Chrome must be running for scheduled checks. Alarms may be delayed by power management.
• Price history is capped at 2,000 entries per product; the oldest observation is kept.
• Images are loaded from retailer image servers and may be blocked by the retailer or your network.
• This extension does not bypass logins, paywalls or CAPTCHAs.
• Verify the final price on the retailer's page before buying.

Developed by Raajan.
```

## Category

```
Shopping
```

## Language

```
English
```

## Additional fields

- **Official URL / homepage:** <https://github.com/RAJAN00005/smart-price-drop-tracker>
- **Support URL:** <https://github.com/RAJAN00005/smart-price-drop-tracker/issues>
- **Privacy policy URL:** <https://rajan00005.github.io/smart-price-drop-tracker/>

## Screenshots

Upload these files from `store/screenshots/` in this order:

1. `01-overview.png` — dashboard overview with savings, metrics and recent drops.
2. `02-products.png` — tracked products with prices, targets and history sparklines.
3. `03-product-detail.png` — product detail with chart, target and monitoring controls.
4. `04-settings.png` — monitoring, notifications, theme and backup settings.
5. `05-overview-dark.png` — dark theme overview.

All are 1280 × 800 PNG. The Chrome Web Store accepts 1280 × 800 or 640 × 400 screenshots.

## Store icon

Use the existing `assets/icons/icon128.png` (128 × 128 PNG).

## Promotional tile (optional)

Not included. The store only requires one screenshot and the 128 × 128 icon. A 440 × 280
promotional tile can be added later if you want the listing to be eligible for featured placement.
