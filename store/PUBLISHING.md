# Publishing Smart Price Drop Tracker

This is the step-by-step Chrome Web Store release guide for this extension. It assumes you are
publishing the extension as **Smart Price Drop Tracker** under the developer name **Raajan**.

The Chrome Web Store charges a **one-time US$5 developer registration fee**. Publishing is free
after that. Review usually takes a few days, but can take longer for new developers.

---

## 0. What is already prepared

- `manifest.json` — Manifest V3, version `1.0.0`, no install-time host access.
- `store/screenshots/` — five 1280 × 800 PNG screenshots.
- `store/privacy-site/index.html` — a standalone privacy policy page ready to host.
- `store/LISTING.md` — name, short description, detailed description and screenshot order.
- `store/PUBLISHING.md` — this guide.
- Tests: **60 unit passed, 0 failed** and **36 E2E passed, 0 failed**.

The extension ZIP must contain only the runtime files. Do **not** upload the repository folder as-is:
`tests/`, `node_modules/`, `tools/`, `store/`, `README.md`, `package.json` and `package-lock.json`
are not needed in the store package.

---

## 1. Do a final local check

Before uploading, load the current folder unpacked and verify:

1. Open `brave://extensions` or `chrome://extensions`, enable **Developer mode**, and reload the
   extension.
2. Open a product page, click the extension icon, and track it.
3. Click **Check now** on the product detail page. Confirm the price updates.
4. Enable automatic checks and wait for one scheduled check (or temporarily set a 6-hour frequency).
   Confirm **no new tab opens** and the price updates in the dashboard.
5. Confirm the dashboard footer and popup footer both say **Developed by Raajan**.
6. Confirm real product images appear, not only the orange initials tile.
7. Open **Settings → Site access** and confirm you can remove a store permission.
8. Export a JSON backup and import it again in a test profile if you want to verify backups.

If you changed any extension file, reload the extension before testing.

---

## 2. Host the privacy policy

**Already done.** The policy is live at:

```
https://rajan00005.github.io/smart-price-drop-tracker/
```

It is served from `docs/index.html` on the `main` branch via GitHub Pages
(**Settings → Pages → Deploy from a branch → main / docs**). Use that exact URL in the
Chrome Web Store **Privacy policy URL** field.

To update the text, edit `store/privacy-site/index.html`, copy it to `docs/index.html`, commit,
and push. Pages redeploys automatically.

> If you prefer a different host, any public HTTPS host works: Cloudflare Pages, Netlify,
> GitLab Pages, or your own website. The page has no external dependencies, so a single HTML file
> is enough.

---

## 3. Build the ZIP package

Run this in PowerShell from the extension folder. It stages only the runtime files and creates
`store/smart-price-drop-tracker-1.0.0.zip`.

```powershell
$root = "C:\Users\LENOVO\OneDrive\Documents\VYBE APP\smart-price-tracker"
$stage = Join-Path $env:TEMP "spt-store-stage"
$zip = Join-Path $root "store\smart-price-drop-tracker-1.0.0.zip"

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage | Out-Null

Copy-Item (Join-Path $root "manifest.json") $stage
foreach ($dir in "background", "offscreen", "extractors", "popup", "dashboard", "storage", "utils", "assets") {
  Copy-Item (Join-Path $root $dir) $stage -Recurse
}

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal
Write-Host "Created $zip"
```

Verify the ZIP before uploading:

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
$archive.Entries | Select-Object -ExpandProperty FullName
$archive.Dispose()
```

The first entry must be `manifest.json`, and the archive must not contain `tests/`,
`node_modules/`, `tools/`, `store/`, `README.md` or `package.json`.

You can also test the ZIP itself: extract it to a new folder, load that folder unpacked, and track
one product. If it works there, it will work after installation from the store.

---

## 4. Create the Chrome Web Store developer account

1. Go to <https://chrome.google.com/webstore/devconsole>.
2. Sign in with the Google account you want to use permanently for this extension.
3. Accept the developer agreement and pay the **one-time US$5 registration fee**.
4. Verify your contact email.
5. Turn on **2-Step Verification** for the Google account. Google requires it for publishing.
6. Complete the developer profile. The **developer name** is what users see; use **Raajan** if that
   is the name you want on the listing.

Keep this Google account secure. It controls every extension you publish.

---

## 5. Create the store item and upload the ZIP

1. In the Developer Dashboard, click **New item**.
2. Upload `store/smart-price-drop-tracker-1.0.0.zip`.
3. Wait for the upload to finish. If the manifest is invalid, the dashboard shows the exact error.
4. Open the new item. You will see tabs such as **Store listing**, **Privacy practices**,
   **Distribution** and **Test instructions**.

---

## 6. Fill in the store listing

Open **Store listing** and use the copy in `store/LISTING.md`.

### Required fields

- **Name:** `Smart Price Drop Tracker`
- **Short description:** copy the 132-character line from `store/LISTING.md`.
- **Detailed description:** copy the long description from `store/LISTING.md`.
- **Category:** `Shopping`
- **Language:** `English`
- **Store icon:** `assets/icons/icon128.png` (128 × 128 PNG)
- **Screenshots:** upload the five files from `store/screenshots/` in this order:
  1. `01-overview.png`
  2. `02-products.png`
  3. `03-product-detail.png`
  4. `04-settings.png`
  5. `05-overview-dark.png`

### URLs

- **Privacy policy:** the GitHub Pages URL from step 2.
- **Support URL:** a public page where users can report problems. A GitHub repository’s **Issues**
  page is a good choice, for example `https://github.com/YOUR-USERNAME/smart-price-tracker/issues`.
  If you do not want to publish the source, create a small public support page with a contact
  method instead.
- **Homepage URL:** optional. Use your project page or GitHub repository if you have one.

### Graphic assets

The 128 × 128 icon is required. A 440 × 280 promotional tile is optional and only needed if you
want the listing to be eligible for featured placement. The prepared screenshots are enough for
a normal listing.

---

## 7. Complete Privacy practices

Open **Privacy practices**. Answer every question. The extension handles user data locally, so it
must still disclose that handling even though nothing is sent to the developer.

### Single purpose

Use this text:

```
Smart Price Drop Tracker lets a user track the prices of products they explicitly choose, stores a local price history, and shows price-drop or target-price notifications.
```

### Remote code

Select **No, I am not using remote code**.

All JavaScript is packaged in the extension. There is no `eval`, no `new Function`, no remote
script, no remotely hosted module and no dynamic code loading.

### Data collection disclosure

The extension handles these categories. Select them and use the explanations below.

**Website content**

```
Product page content is read only for a product the user explicitly adds. It is parsed locally to extract the product title, image, selling price, MRP and availability. Only the extracted fields are stored in chrome.storage.local. The page HTML is not stored and is never sent to the developer or any third party.
```

**Web history**

```
The extension stores only the product page URLs and titles that the user explicitly adds to the watchlist, plus the timestamps of price checks. It does not read or store the user's general browsing history.
```

Do **not** select personally identifiable information, health, financial/payment, authentication,
personal communications, location or user activity unless the final build actually handles them.

For each selected category:

- **Is this data sold?** No.
- **Is this data transferred to third parties?** No.
- **Is this data used for advertising, profiling or creditworthiness?** No.
- **Is this data used for a purpose unrelated to the single purpose?** No.
- **Human access:** No, except as required by law or with specific user consent for support.

### Permission justifications

Copy these into the permission justification fields:

**storage**

```
Saves the user's tracked products, price history, target prices, settings and check status locally in chrome.storage.local. No data is sent to the developer.
```

**alarms**

```
Schedules the price checks the user chooses (every 6, 12 or 24 hours) and a maintenance alarm that repairs missing schedules. Alarms run only while the browser is open.
```

**notifications**

```
Shows local price-drop and target-reached notifications. Notifications are generated on the device; there is no push server.
```

**activeTab**

```
Lets the popup read the current product page only after the user clicks the extension icon, so it can detect the product the user wants to track.
```

**scripting**

```
Runs the extension's bundled, read-only extraction script in the current tab after the user clicks the extension icon. There is no always-on content script and no injection into pages the user did not open the popup on.
```

**offscreen**

```
Fetches and parses a monitored product page in a hidden offscreen document so scheduled price checks can run without opening a browser tab. The parsed data is processed locally.
```

**Optional host permissions (`https://*/*`, `http://*/*`)**

```
The extension supports any http(s) product page the user chooses to track. It requests access only to the exact origin of the product being monitored, and only when the user enables automatic checks. Nothing is granted at install time. The broad optional patterns are required because the extension cannot know in advance which store the user will track; the runtime request is narrowed to the exact origin.
```

### Privacy policy

Paste the public URL from step 2.

### Certification

Check the boxes confirming that the disclosures are accurate and that the extension complies with
the Chrome Web Store User Data Policy. Do not submit if the privacy policy URL, the dashboard
disclosures and the actual behaviour disagree.

---

## 8. Set distribution

Open **Distribution**.

- **Visibility:** Public.
- **Regions:** all regions, or the regions you want to support.
- **Pricing:** Free.
- **Mature content:** No.

If the dashboard offers **Deferred publishing** or a staged rollout, you can leave it off for the
first release and publish to everyone after approval.

---

## 9. Add test instructions for the reviewer

The dashboard may ask for test instructions. This extension has no login, so the reviewer can test
it immediately. Use something like:

```
No account or test credentials are needed.

1. Install the extension and open any product page on https://www.amazon.in.
2. Click the toolbar icon. The popup should show the product title, image and price.
3. Click "Track Price". Open the dashboard and confirm the product appears.
4. On the product detail page, click "Check now". The price should update without opening a new tab.
5. Enable automatic checks. The browser asks for permission for the exact amazon.in origin. Allow it.
6. Open Settings > Site access to review or remove the permission.

Automatic checks use a hidden offscreen document, not a visible tab. If Amazon shows a CAPTCHA or
bot page, the extension reports it and keeps the last valid price; this is expected and is not a
bypass attempt.
```

If the store asks for a test account, state that no account is required.

---

## 10. Submit for review

1. Re-check the **Store listing**, **Privacy practices** and **Distribution** tabs for missing
   fields.
2. Click **Submit for review**.
3. The item status changes to **Pending review**.
4. Watch the developer email and the dashboard for reviewer questions. Reply quickly and precisely.
5. After approval, the status changes to **Published** and the listing gets a public URL.

Review time varies. New developers and extensions that request host permissions often get a manual
review, which can take several days.

---

## 11. After publishing

1. Open the public listing in a private window and install the extension from the store.
2. Track one product, run a manual check, and wait for one automatic check.
3. Confirm the installed version shows **Developed by Raajan** in the dashboard and popup.
4. Add the store link to your README or project page.
5. Keep the support URL monitored so reviewer and user messages do not go unanswered.

### Publishing an update

1. Increase `version` in `manifest.json` (for example `1.0.1`).
2. Run `npm.cmd test` and `npm.cmd run test:e2e`.
3. Rebuild the ZIP with the PowerShell command in step 3.
4. In the Developer Dashboard, open the item and click **Upload new package**.
5. Add release notes describing what changed.
6. Submit for review. Updates can be reviewed faster than the first release, but permission changes
   or new data handling can trigger a full review.

Do not change the extension ID. The ID is tied to the store item; keeping the same item preserves
your users and reviews.

---

## 12. Common review problems and fixes

**“Broad host permissions”**

The manifest has broad *optional* patterns but requests exact origins at runtime. Point the reviewer
to the optional-permission justification above and to **Settings → Site access**. Do not add
install-time host permissions to make testing easier.

**“Privacy policy does not match behaviour”**

Make sure the policy mentions website content, product URLs, local storage, offscreen fetching and
the fact that no data is sent to the developer. The prepared policy covers these. If you add
analytics, accounts, cloud sync or a backend later, update the policy and the dashboard disclosures
before shipping.

**“Remote code”**

The extension has no remote code. If a reviewer asks, point to `manifest.json` (no `content_security_policy`
overrides for remote scripts), the absence of `eval`/`new Function`, and the fact that all scripts
are packaged files.

**“Why does it need `offscreen`?”**

Scheduled checks fetch and parse product pages without opening tabs. The offscreen document is the
MV3-supported way to use `DOMParser` outside the service worker. The justification above explains
this.

**“Why does it read Amazon pages?”**

Only product pages the user explicitly adds are fetched, and only after the user grants the exact
origin permission. The popup uses `activeTab` only after the user clicks the icon.

**“The extension did not detect a price”**

Retailer layouts change. Ask the reviewer to try the included Amazon test flow, or to use the
manual price entry. Do not weaken the confidence threshold or save low-confidence prices just to
make a test pass.

---

## 13. Release checklist

- [ ] Final local test passed (track, manual check, automatic check, no tabs, notification).
- [ ] Privacy policy hosted over HTTPS and opens in a private window.
- [ ] ZIP contains `manifest.json` at the root and no test/tool files.
- [ ] Version in `manifest.json` is the version you intend to publish.
- [ ] Store listing copy, icon and five screenshots uploaded.
- [ ] Single purpose, remote-code answer and data disclosures completed.
- [ ] Permission justifications completed.
- [ ] Privacy policy URL entered.
- [ ] Distribution set to Public and Free.
- [ ] Test instructions added.
- [ ] Submitted for review.

---

Developed by Raajan.
