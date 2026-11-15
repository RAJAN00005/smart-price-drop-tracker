import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import * as H from './helpers.mjs';

const results = { passed: 0, failed: 0, failures: [] };

async function test(name, fn) {
  process.stdout.write(`\n- ${name}\n`);
  try {
    await fn();
    results.passed++;
    process.stdout.write('  PASS\n');
  } catch (error) {
    results.failed++;
    results.failures.push({ name, error });
    process.stdout.write('  FAIL: ' + (error && error.message ? error.message : String(error)) + '\n');
    if (error && error.stack) {
      process.stdout.write(error.stack.split('\n').slice(1, 5).join('\n') + '\n');
    }
  }
}

function suiteFailure(suiteName, error) {
  results.failed++;
  results.failures.push({ name: suiteName + ' setup', error });
  process.stdout.write(`\n- ${suiteName} setup\n  FAIL: ${error && error.message ? error.message : String(error)}\n`);
}

/* ------------------------------------------------------------------------- */
/* Extraction engine against mock retailer pages                             */
/* ------------------------------------------------------------------------- */

async function extractionSuite() {
  process.stdout.write('\n=== Extraction engine (mock retailer pages) ===\n');
  let browser;
  let context;
  try {
    browser = await chromium.launch({ executablePath: H.findChromium(), headless: true });
    context = await H.createExtractionContext(browser);
  } catch (error) {
    suiteFailure('Extraction suite', error);
    if (browser) await browser.close().catch(() => {});
    return;
  }

  try {
    const retailers = [
      ['Amazon India', 'amazon', 'https://www.amazon.in/dp/B09Y2MYL5C', 'amazon', 'Sony WH-1000XM5 Wireless Headphones', 24990, 34990],
      ['Flipkart', 'flipkart', 'https://www.flipkart.com/noise-earbuds/p/itm123?pid=ABC123', 'flipkart', 'Noise Cancelling Earbuds', 79999, 99999],
      ['Myntra', 'myntra', 'https://www.myntra.com/shirts/mock/12345/buy', 'myntra', 'Linen Blend Shirt', 3599, 5999],
      ['AJIO', 'ajio', 'https://www.ajio.com/relaxed-fit-jeans/p/123456', 'ajio', 'Relaxed Fit Jeans', 2499, 4999],
      ['Croma', 'croma', 'https://www.croma.com/55-inch-tv/p/123456', 'croma', '55 inch 4K Smart TV', 89990, 109990],
      ['Reliance Digital', 'reliance', 'https://www.reliancedigital.in/product/fridge123', 'reliance', 'Side by Side Refrigerator', 42999, 54999],
      ['Tata CLiQ', 'tata-cliq', 'https://www.tatacliq.com/smart-watch/p/123456', 'tatacliq', 'Smart Watch', 15999, 19999],
      ['Meesho', 'meesho', 'https://www.meesho.com/cotton-kurta-set/p/abc123', 'meesho', 'Cotton Kurta Set', 599, 1299]
    ];

    for (const [label, fixture, url, storeId, title, price, originalPrice] of retailers) {
      await test(`${label} adapter extracts the selling price from ${fixture}.html`, async () => {
        const data = await H.extractPage(context, url);
        assert.equal(data.found, true);
        assert.equal(data.blocked, false);
        assert.equal(data.error, null);
        assert.equal(data.storeId, storeId);
        assert.equal(data.title, title);
        assert.equal(data.price, price);
        assert.equal(data.originalPrice, originalPrice);
        assert.equal(data.currency, 'INR');
        assert.equal(data.availability, 'InStock');
        assert.ok(data.confidence >= 0.9, `expected adapter confidence >= 0.9, got ${data.confidence}`);
        assert.equal(data.needsConfirmation, false);
        assert.match(data.source, /price selector/i);
      });
    }

    await test('Amazon live layout extracts the visible price when offscreen text is hidden', async () => {
      const data = await H.extractPage(context, 'https://www.amazon.in/dp/B0LIVELAYOUT');
      assert.equal(data.found, true);
      assert.equal(data.blocked, false);
      assert.equal(data.error, null);
      assert.equal(data.storeId, 'amazon');
      assert.equal(data.title, 'Sonam Quartz Luxury Gear Wall Clock');
      assert.equal(data.price, 1999);
      assert.equal(data.originalPrice, 2799);
      assert.equal(data.currency, 'INR');
      assert.equal(data.availability, 'InStock');
      assert.ok(data.confidence >= 0.9, `expected adapter confidence >= 0.9, got ${data.confidence}`);
      assert.equal(data.needsConfirmation, false);
      assert.match(data.source, /price selector/i);
    });

    await test('generic store fallback extracts a product', async () => {
      const data = await H.extractPage(context, 'https://shop.example.com/products/backpack');
      assert.equal(data.found, true);
      assert.equal(data.blocked, false);
      assert.equal(data.storeId, 'generic');
      assert.equal(data.title, 'Everyday Backpack');
      assert.equal(data.price, 4999);
      assert.equal(data.originalPrice, 6999);
      assert.equal(data.currency, 'INR');
      assert.equal(data.availability, 'InStock');
      assert.ok(data.confidence > 0.72, `generic confidence should be accepted, got ${data.confidence}`);
      assert.equal(data.needsConfirmation, false);
    });

    await test('discount trap ignores EMI, delivery and coupon amounts', async () => {
      const data = await H.extractPage(context, 'https://www.amazon.in/dp/B0DISCOUNT');
      assert.equal(data.found, true);
      assert.equal(data.price, 125999);
      assert.equal(data.originalPrice, 149999);
      assert.ok(![4999, 99, 500].includes(data.price), 'noise amount was selected as the price');
      for (const noise of [4999, 99, 500]) {
        assert.ok(!data.candidates.some((candidate) => candidate.price === noise),
          'noise amount leaked into candidates: ' + noise);
      }
    });

    await test('conflicting JSON-LD and adapter prices require confirmation', async () => {
      const data = await H.extractPage(context, 'https://www.amazon.in/dp/B0CONFLICT');
      assert.equal(data.found, true);
      assert.equal(data.price, 125999);
      assert.equal(data.needsConfirmation, true);
      assert.ok(data.conflicts.some((candidate) => candidate.price === 119999),
        'expected the JSON-LD 119999 conflict to be reported');
      assert.ok(data.candidates.some((candidate) => candidate.price === 125999));
      assert.ok(data.candidates.some((candidate) => candidate.price === 119999));
    });

    await test('CAPTCHA pages are reported as blocked without a price', async () => {
      const data = await H.extractPage(context, 'https://www.amazon.in/dp/B0CAPTCHA');
      assert.equal(data.found, false);
      assert.equal(data.blocked, true);
      assert.equal(data.price, null);
      assert.equal(data.confidence, 0);
      assert.equal(data.error.code, 'CAPTCHA');
      assert.equal(data.availability, 'Unknown');
    });

    await test('pages without a price report PRICE_NOT_FOUND', async () => {
      const data = await H.extractPage(context, 'https://www.amazon.in/dp/B0NOPRICE');
      assert.equal(data.found, false);
      assert.equal(data.blocked, false);
      assert.equal(data.price, null);
      assert.equal(data.error.code, 'PRICE_NOT_FOUND');
      assert.ok(data.issues.includes('PRICE_NOT_FOUND'));
    });

    await test('low-confidence whole-page price is marked for confirmation', async () => {
      const data = await H.extractPage(context, 'https://shop.example.com/products/mystery');
      assert.equal(data.found, true);
      assert.equal(data.price, 2499);
      assert.equal(data.needsConfirmation, true);
      assert.ok(data.confidence < 0.72, `expected confidence below threshold, got ${data.confidence}`);
      assert.ok(data.candidates.some((candidate) => candidate.price === 2499));
    });

    await test('out-of-stock availability is detected', async () => {
      const data = await H.extractPage(context, 'https://www.amazon.in/dp/B0OUT');
      assert.equal(data.found, true);
      assert.equal(data.price, 1299);
      assert.equal(data.availability, 'OutOfStock');
    });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------------- */
/* Dashboard, settings, backup and popup                                     */
/* ------------------------------------------------------------------------- */

async function dashboardSuite() {
  process.stdout.write('\n=== Dashboard, settings, backup and popup ===\n');
  const suite = H.makeSuiteDir('dashboard');
  let extension;
  let page;
  let productId = null;

  try {
    extension = await H.launchExtension(H.EXTENSION_DIR);
    page = await H.openDashboard(extension);
  } catch (error) {
    suiteFailure('Dashboard suite', error);
    if (extension) await extension.close();
    suite.cleanup();
    return;
  }

  try {
    await test('dashboard renders the empty state', async () => {
      assert.equal((await page.locator('#nav-product-count').innerText()).trim(), '0');
      const content = await page.locator('#page-content').innerText();
      assert.match(content, /Start watching your first price/);
      assert.equal(await page.locator('.product-card').count(), 0);
      assert.equal((await page.locator('.app-credit').innerText()).trim(), 'Developed by Raajan');
    });

    await test('add-product help modal opens and closes', async () => {
      await page.locator('[data-action="add-help"]').first().click();
      await H.waitForModalOpen(page);
      assert.equal((await page.locator('#modal-title').innerText()).trim(), 'Add a product');
      assert.match(await page.locator('#modal-body').innerText(), /toolbar icon/i);
      await page.locator('#modal-close').click();
      await H.waitForModalClosed(page);
    });

    await test('a tracked product appears on the overview', async () => {
      await page.route('https://images.example.com/product.svg', (route) => route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#3366ff"/></svg>'
      }));
      const response = await H.seedProduct(page, { image: 'https://images.example.com/product.svg' });
      assert.equal(response.ok, true, JSON.stringify(response.error));
      assert.equal(response.duplicate, false);
      productId = response.product.id;
      assert.match(productId, /^p_/);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#page-content .page');
      await page.waitForFunction(() => document.body.textContent.includes('Sony WH-1000XM5'));
      assert.equal((await page.locator('#nav-product-count').innerText()).trim(), '1');
      assert.match(await page.locator('#page-content').innerText(), /Sony WH-1000XM5/);
    });

    await test('products page search and reset filters work', async () => {
      assert.ok(productId, 'product was not seeded');
      await page.locator('[data-nav="products"]').click();
      await page.waitForSelector('#product-search');
      assert.equal((await page.locator('#toolbar-count').innerText()).trim(), '1 of 1');
      const cardText = await page.locator('.product-card').first().innerText();
      assert.match(cardText, /Sony WH-1000XM5/);
      assert.match(cardText, /24,990/);

      await page.waitForSelector('.product-card .product-thumb img');
      const thumbState = await page.locator('.product-card .product-thumb').first().evaluate((thumb) => {
        const img = thumb.querySelector('img');
        const rect = thumb.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          imageOnTop: hit === img
        };
      });
      assert.equal(thumbState.complete, true, 'product image did not finish loading');
      assert.ok(thumbState.naturalWidth > 0, 'product image failed to decode');
      assert.equal(thumbState.imageOnTop, true, 'orange fallback tile is covering the real product image');

      await page.locator('#product-search').fill('Sony');
      await page.waitForFunction(() => document.querySelector('#toolbar-count').textContent.trim() === '1 of 1');
      await page.locator('#product-search').fill('zzz');
      await page.waitForFunction(() => document.querySelector('#page-content').textContent.includes('No products match these filters'));
      assert.equal((await page.locator('#toolbar-count').innerText()).trim(), '0 of 1');
      await page.locator('[data-action="reset-filters"]').click();
      await page.waitForFunction(() => document.querySelectorAll('.product-card').length === 1);
    });

    await test('detail page renders history, chart ranges and target prices', async () => {
      assert.ok(productId, 'product was not seeded');
      for (const price of [23990, 22990]) {
        const response = await H.sendMessage(page, 'APPLY_MANUAL_PRICE', { id: productId, price });
        assert.equal(response.ok, true, JSON.stringify(response.error));
      }

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#page-content .page');
      await page.locator('[data-nav="products"]').click();
      await page.waitForSelector('.product-name');
      await page.locator('.product-name').first().click();
      await page.waitForSelector('.detail-price');
      assert.match(await page.locator('.detail-price').innerText(), /22,990/);
      await page.waitForSelector('#price-chart .chart-svg');
      assert.equal(await page.locator('.history-table tbody tr').count(), 3);

      for (const range of ['7d', '30d', '90d', 'all']) {
        await page.locator(`[data-action="chart-range"][data-range="${range}"]`).click();
        await page.waitForFunction((wanted) => {
          const button = document.querySelector(`[data-action="chart-range"][data-range="${wanted}"]`);
          return button && button.classList.contains('is-active') && button.getAttribute('aria-pressed') === 'true';
        }, range);
        assert.equal(await page.locator('#price-chart .chart-svg').count(), 1);
      }

      const targetForm = page.locator('form[data-form="target"]');
      await targetForm.locator('input[name="target"]').fill('20,000');
      await targetForm.locator('button[type="submit"]').click();
      await H.waitForToast(page, 'Target price saved.');
      await page.waitForFunction(() => {
        const input = document.querySelector('form[data-form="target"] input[name="target"]');
        return input && input.value === '20,000';
      });
      let product = await H.getProduct(page, productId);
      assert.equal(product.targetPrice, 20000);

      await page.locator('[data-action="clear-target"]').click();
      await H.waitForToast(page, 'Target price cleared.');
      product = await H.getProduct(page, productId);
      assert.equal(product.targetPrice, null);
    });

    await test('settings auto-save, notification gating and theme switching work', async () => {
      await page.locator('[data-nav="settings"]').click();
      await page.waitForSelector('#setting-default-frequency');
      assert.equal(await page.locator('#setting-default-frequency').inputValue(), '12');

      const master = page.locator('.switch:has([data-setting="notificationsEnabled"])');
      await master.click();
      await H.waitForSetting(page, 'notificationsEnabled', false);
      await page.waitForFunction(() => {
        const drop = document.querySelector('[data-setting="priceDropNotifications"]');
        const target = document.querySelector('[data-setting="targetNotifications"]');
        return !!drop && !!target && drop.disabled && target.disabled;
      });
      assert.equal(await page.locator('[data-setting="priceDropNotifications"]').isDisabled(), true);
      assert.equal(await page.locator('[data-setting="targetNotifications"]').isDisabled(), true);
      await page.waitForFunction(() => {
        const note = document.querySelector('#settings-save-note');
        return note && note.textContent.includes('Saved locally');
      });

      await master.click();
      await H.waitForSetting(page, 'notificationsEnabled', true);
      assert.equal(await page.locator('[data-setting="priceDropNotifications"]').isDisabled(), false);

      await page.locator('#setting-default-frequency').selectOption('6');
      await H.waitForSetting(page, 'defaultFrequency', 6);
      await page.locator('#setting-default-frequency').selectOption('12');
      await H.waitForSetting(page, 'defaultFrequency', 12);

      await page.locator('[data-action="set-theme"][data-theme="dark"]').click();
      await H.waitForSetting(page, 'theme', 'dark');
      await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
      await page.locator('[data-action="set-theme"][data-theme="system"]').click();
      await H.waitForSetting(page, 'theme', 'system');
      await page.waitForFunction(() => document.documentElement.getAttribute('data-theme-mode') === 'system');

      const siteText = await page.locator('.site-access-list').innerText();
      assert.match(siteText, /amazon\.in/i);
      assert.match(siteText, /Allow/);
    });

    await test('JSON and CSV exports contain the tracked product', async () => {
      assert.ok(productId, 'product was not seeded');
      const json = await H.downloadFile(page, '[data-action="export-json"]', suite.dir);
      assert.match(json.name, /^smart-price-tracker-backup-.*\.json$/);
      const payload = JSON.parse(json.text);
      assert.equal(payload.app, 'Smart Price Drop Tracker');
      assert.equal(payload.schemaVersion, 1);
      assert.equal(payload.products.length, 1);
      assert.equal(payload.products[0].id, productId);
      assert.ok(payload.settings);

      const csv = await H.downloadFile(page, '[data-action="export-csv"]', suite.dir);
      assert.match(csv.name, /^smart-price-tracker-products-.*\.csv$/);
      const csvText = csv.text.replace(/^\uFEFF/, '');
      const lines = csvText.split('\r\n');
      assert.ok(lines[0].startsWith('Product Name,Website,Current Price'));
      assert.ok(lines[1].includes('Sony WH-1000XM5'));
      assert.ok(lines[1].includes('22990'));
    });

    await test('backup merge skips duplicates and replace imports the backup', async () => {
      const json = await H.downloadFile(page, '[data-action="export-json"]', suite.dir);
      const input = page.locator('#import-file-input');

      await input.setInputFiles(json.filePath);
      await H.waitForModalOpen(page);
      assert.match(await page.locator('#modal-body').innerText(), /valid products/i);
      assert.match(await page.locator('#modal-body').innerText(), /skipped records/i);
      await page.locator('#modal-actions .btn-primary').click();
      await H.waitForToast(page, 'Imported 0 products.');
      await H.waitForToast(page, 'Skipped 1 duplicate or invalid record.');
      await H.waitForModalClosed(page);
      assert.equal(await page.evaluate(() => globalThis.SPT.StorageManager.countProducts()), 1);

      await input.setInputFiles(json.filePath);
      await H.waitForModalOpen(page);
      await page.locator('input[name="import-mode"][value="replace"]').check();
      await page.locator('#modal-actions .btn-primary').click();
      await H.waitForToast(page, 'Imported 1 product.');
      await H.waitForModalClosed(page);
      assert.equal(await page.evaluate(() => globalThis.SPT.StorageManager.countProducts()), 1);

      const products = await page.evaluate(() => globalThis.SPT.StorageManager.listProducts());
      assert.equal(products.length, 1);
      productId = products[0].id;
      assert.equal(products[0].currentPrice, 22990);
    });

    await test('invalid backups are rejected with a clear message', async () => {
      await H.closeModalIfOpen(page);
      const input = page.locator('#import-file-input');
      const malformed = path.join(suite.dir, 'malformed.json');
      fs.writeFileSync(malformed, '{ this is not json', 'utf8');
      await input.setInputFiles(malformed);
      await H.waitForToast(page, 'This file is not valid JSON.');
      assert.equal(await page.locator('#modal-root').isHidden(), true);

      const unsupported = path.join(suite.dir, 'unsupported.json');
      fs.writeFileSync(unsupported, JSON.stringify({ hello: 'world' }), 'utf8');
      await input.setInputFiles(unsupported);
      await H.waitForToast(page, 'This backup file is not valid or contains unsupported data.');
      assert.equal(await page.locator('#modal-root').isHidden(), true);
    });

    await test('popup explains that an unsupported page cannot be tracked', async () => {
      const popup = await H.openPopup(extension);
      try {
        await popup.waitForSelector('#unsupported-view:not([hidden])', { timeout: 15000 });
        const text = await popup.locator('#unsupported-view').innerText();
        assert.match(text, /can.t be tracked/i);
        assert.equal((await popup.locator('.footer-credit').innerText()).trim(), 'Developed by Raajan');
      } finally {
        await popup.close();
      }
    });

    await test('a product can be removed with confirmation', async () => {
      assert.ok(productId, 'product was not seeded');
      await H.closeModalIfOpen(page);
      await page.locator('[data-nav="products"]').click();
      await page.waitForSelector('.product-name');
      await page.locator('.product-name').first().click();
      await page.waitForSelector('.detail-price');
      await page.locator('[data-action="delete-product"]').first().click();
      await H.waitForModalOpen(page);
      assert.equal((await page.locator('#modal-title').innerText()).trim(), 'Remove product?');
      await page.locator('#modal-actions .btn-danger').click();
      await H.waitForToast(page, 'Product removed.');
      await H.waitForModalClosed(page);
      await page.waitForFunction(() => document.querySelector('#nav-product-count').textContent.trim() === '0');
      assert.equal(await page.evaluate(() => globalThis.SPT.StorageManager.countProducts()), 0);
    });

    await test('no uncaught extension page errors occurred', async () => {
      H.assertNoExtensionErrors(extension);
    });
  } finally {
    if (extension) await extension.close();
    suite.cleanup();
  }
}

/* ------------------------------------------------------------------------- */
/* Automatic monitoring with a test-only manifest copy                       */
/* ------------------------------------------------------------------------- */

async function monitoringSuite() {
  process.stdout.write('\n=== Automatic monitoring (test manifest with Amazon access) ===\n');
  const suite = H.makeSuiteDir('monitor');
  let extension;
  let page;
  let server;
  let productId = null;
  let productUrl = '';
  const localImage = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  const withLocalImages = (html) => html.replace(/https:\/\/m\.media-amazon\.com\/[^"]+/g, localImage);
  let amazonBody = withLocalImages(H.readFixture('amazon'));
  const priceBody = (price) => withLocalImages(H.readFixture('amazon'))
    .split('24990').join(String(price))
    .split('24,990').join(Number(price).toLocaleString('en-IN'));

  try {
    const testExtensionDir = await H.prepareTestExtension(suite.dir);
    const certificate = H.createTestCertificate(suite.dir);
    server = await H.startFixtureServer(certificate, () => amazonBody);
    productUrl = `https://www.amazon.in:${server.port}/dp/B09Y2MYL5C`;
    extension = await H.launchExtension(testExtensionDir, {
      extraArgs: [
        '--ignore-certificate-errors',
        '--host-resolver-rules=MAP www.amazon.in 127.0.0.1'
      ]
    });
    page = await H.openDashboard(extension);
  } catch (error) {
    suiteFailure('Monitoring suite', error);
    if (extension) await extension.close();
    if (server) await server.close();
    suite.cleanup();
    return;
  }

  try {
    await test('monitoring is scheduled with the test host permission', async () => {
      const response = await H.seedProduct(page, { url: productUrl, currentPrice: 26990 }, {
        monitoringEnabled: true,
        checkFrequency: 6
      });
      assert.equal(response.ok, true, JSON.stringify(response.error));
      assert.equal(response.scheduled, true, 'expected an alarm with the test host permission');
      productId = response.product.id;
      assert.ok(response.product.nextCheck, 'nextCheck should be scheduled');
      const alarms = await page.evaluate(() => chrome.alarms.getAll());
      assert.ok(alarms.some((alarm) => alarm.name === 'spt:check:' + productId));
    });

    await test('manual check updates the price and history without opening a tab', async () => {
      assert.ok(productId, 'product was not seeded');
      amazonBody = priceBody(24990);
      const response = await H.sendMessage(page, 'MANUAL_UPDATE', { id: productId });
      assert.equal(response.ok, true, JSON.stringify(response.error));
      assert.equal(response.report.price, 24990);
      assert.equal(response.report.isDrop, true);
      assert.equal(response.report.dropAmount, 2000);
      assert.equal(response.product.currentPrice, 24990);
      assert.equal(response.product.priceHistory.length, 2);
      assert.equal(response.product.priceHistory[1].source, 'manual');
      assert.equal(await page.evaluate(() => globalThis.SPT.StorageManager.getTempTabs().then((tabs) => tabs.length)), 0);
      assert.equal(extension.context.pages().filter((item) => item.url().includes('amazon.in')).length, 0);
    });

    await test('a second check records another price drop', async () => {
      assert.ok(productId, 'product was not seeded');
      amazonBody = priceBody(22990);
      const response = await H.sendMessage(page, 'MANUAL_UPDATE', { id: productId });
      assert.equal(response.ok, true, JSON.stringify(response.error));
      assert.equal(response.report.price, 22990);
      assert.equal(response.report.isDrop, true);
      assert.equal(response.report.dropAmount, 2000);
      assert.equal(response.product.currentPrice, 22990);
      assert.equal(response.product.priceHistory.length, 3);
    });

    await test('CAPTCHA, missing price and low confidence preserve the last valid price', async () => {
      assert.ok(productId, 'product was not seeded');

      amazonBody = withLocalImages(H.readFixture('captcha'));
      let response = await H.sendMessage(page, 'MANUAL_UPDATE', { id: productId });
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'CAPTCHA');
      let product = await H.getProduct(page, productId);
      assert.equal(product.currentPrice, 22990);
      assert.equal(product.priceHistory.length, 3);
      assert.equal(product.checkStatus, 'failed');
      assert.equal(product.lastError.code, 'CAPTCHA');
      assert.equal(product.consecutiveFailures, 1);

      amazonBody = withLocalImages(H.readFixture('no-price'));
      response = await H.sendMessage(page, 'MANUAL_UPDATE', { id: productId });
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'PRICE_NOT_FOUND');
      product = await H.getProduct(page, productId);
      assert.equal(product.currentPrice, 22990);
      assert.equal(product.priceHistory.length, 3);
      assert.equal(product.consecutiveFailures, 2);

      amazonBody = withLocalImages(H.readFixture('low-confidence'));
      response = await H.sendMessage(page, 'MANUAL_UPDATE', { id: productId });
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'LOW_CONFIDENCE');
      assert.ok((response.candidates || []).some((candidate) => candidate.price === 2499));
      product = await H.getProduct(page, productId);
      assert.equal(product.currentPrice, 22990);
      assert.equal(product.priceHistory.length, 3);
      assert.equal(product.consecutiveFailures, 3);

      amazonBody = priceBody(21990);
      response = await H.sendMessage(page, 'MANUAL_UPDATE', { id: productId });
      assert.equal(response.ok, true, JSON.stringify(response.error));
      product = await H.getProduct(page, productId);
      assert.equal(product.currentPrice, 21990);
      assert.equal(product.priceHistory.length, 4);
      assert.equal(product.checkStatus, 'ok');
      assert.equal(product.lastError, null);
      assert.equal(product.consecutiveFailures, 0);
    });

    await test('the automatic alarm path updates prices and schedules the next check', async () => {
      assert.ok(productId, 'product was not seeded');
      amazonBody = priceBody(20990);
      const worker = await extension.getWorker();
      const response = await worker.evaluate(async (id) => {
        return globalThis.SPT.PriceMonitor.checkProduct(id);
      }, productId);
      assert.equal(response.ok, true, JSON.stringify(response.error));
      assert.equal(response.report.price, 20990);
      assert.equal(response.product.currentPrice, 20990);
      assert.equal(response.product.priceHistory.length, 5);
      assert.equal(response.product.priceHistory[4].source, 'auto');
      assert.equal(response.scheduled, true);
      assert.ok(response.nextCheck);
      const alarms = await page.evaluate(() => chrome.alarms.getAll());
      assert.ok(alarms.some((alarm) => alarm.name === 'spt:check:' + productId));
      assert.equal(extension.context.pages().filter((item) => item.url().includes('amazon.in')).length, 0);
    });

    await test('automatic failures reschedule and preserve the price', async () => {
      assert.ok(productId, 'product was not seeded');
      amazonBody = withLocalImages(H.readFixture('captcha'));
      const worker = await extension.getWorker();
      const response = await worker.evaluate(async (id) => {
        return globalThis.SPT.PriceMonitor.checkProduct(id);
      }, productId);
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'CAPTCHA');
      const product = await H.getProduct(page, productId);
      assert.equal(product.currentPrice, 20990);
      assert.equal(product.priceHistory.length, 5);
      assert.equal(product.checkStatus, 'failed');
      assert.ok(product.nextCheck, 'automatic failures should schedule a retry');
      const alarms = await page.evaluate(() => chrome.alarms.getAll());
      assert.ok(alarms.some((alarm) => alarm.name === 'spt:check:' + productId));
      assert.equal(extension.context.pages().filter((item) => item.url().includes('amazon.in')).length, 0);
    });

    await test('the automatic path recovers on the next successful check', async () => {
      assert.ok(productId, 'product was not seeded');
      amazonBody = priceBody(19990);
      const worker = await extension.getWorker();
      const response = await worker.evaluate(async (id) => {
        return globalThis.SPT.PriceMonitor.checkProduct(id);
      }, productId);
      assert.equal(response.ok, true, JSON.stringify(response.error));
      assert.equal(response.product.currentPrice, 19990);
      assert.equal(response.product.priceHistory.length, 6);
      assert.equal(response.product.checkStatus, 'ok');
      assert.equal(response.product.consecutiveFailures, 0);
      assert.equal(response.product.lastError, null);
    });

    await test('no uncaught extension page errors occurred during monitoring', async () => {
      H.assertNoExtensionErrors(extension);
    });
  } finally {
    if (extension) await extension.close();
    if (server) await server.close();
    suite.cleanup();
  }
}

/* ------------------------------------------------------------------------- */

await extractionSuite();
await dashboardSuite();
await monitoringSuite();

process.stdout.write('\n=== Summary ===\n');
process.stdout.write(`Passed: ${results.passed}\n`);
process.stdout.write(`Failed: ${results.failed}\n`);
if (results.failures.length) {
  process.stdout.write('\nFailures:\n');
  for (const failure of results.failures) {
    process.stdout.write(`- ${failure.name}: ${failure.error && failure.error.message ? failure.error.message : String(failure.error)}\n`);
  }
  process.exitCode = 1;
}
