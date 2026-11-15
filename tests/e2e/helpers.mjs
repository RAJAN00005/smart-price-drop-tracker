import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
export const EXTENSION_DIR = path.resolve(E2E_DIR, '..', '..');
export const FIXTURES_DIR = path.join(EXTENSION_DIR, 'tests', 'fixtures');

export const EXTRACTION_FILES = [
  'utils/date-utils.js',
  'utils/price-parser.js',
  'utils/url-normalizer.js',
  'utils/validation.js',
  'utils/site-catalog.js',
  'extractors/extractor-core.js',
  'extractors/generic-extractor.js',
  'extractors/amazon-extractor.js',
  'extractors/flipkart-extractor.js',
  'extractors/myntra-extractor.js',
  'extractors/ajio-extractor.js',
  'extractors/croma-extractor.js',
  'extractors/reliance-extractor.js',
  'extractors/tata-cliq-extractor.js',
  'extractors/meesho-extractor.js',
  'extractors/extractor-registry.js'
];

export const EXTENSION_COPY_ENTRIES = [
  'manifest.json',
  'background',
  'utils',
  'storage',
  'extractors',
  'offscreen',
  'popup',
  'dashboard',
  'assets'
];

export function findChromium() {
  const candidates = [];
  if (process.env.SPT_CHROMIUM && fs.existsSync(process.env.SPT_CHROMIUM)) {
    candidates.push(process.env.SPT_CHROMIUM);
  }
  try {
    const bundled = chromium.executablePath();
    if (bundled && fs.existsSync(bundled)) candidates.push(bundled);
  } catch (_) { /* ignore */ }

  const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (fs.existsSync(root)) {
    const dirs = fs.readdirSync(root)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const dir of dirs) {
      const exe = path.join(root, dir, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe)) candidates.push(exe);
    }
  }

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error('Could not find a Playwright Chromium build. Run "npx playwright install chromium" or set SPT_CHROMIUM.');
  }
  return found;
}

export function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name + '.html'), 'utf8');
}

export function fixtureRoutes() {
  return [
    {
      origin: 'https://www.amazon.in',
      map: {
        '/dp/B09Y2MYL5C': 'amazon',
        '/dp/B0LIVELAYOUT': 'amazon-live-layout',
        '/dp/B0DISCOUNT': 'discount-trap',
        '/dp/B0CONFLICT': 'conflicting',
        '/dp/B0CAPTCHA': 'captcha',
        '/dp/B0NOPRICE': 'no-price',
        '/dp/B0OUT': 'out-of-stock'
      }
    },
    {
      origin: 'https://www.flipkart.com',
      map: { '/noise-earbuds/p/itm123': 'flipkart' }
    },
    {
      origin: 'https://www.myntra.com',
      map: { '/shirts/mock/12345/buy': 'myntra' }
    },
    {
      origin: 'https://www.ajio.com',
      map: { '/relaxed-fit-jeans/p/123456': 'ajio' }
    },
    {
      origin: 'https://www.croma.com',
      map: { '/55-inch-tv/p/123456': 'croma' }
    },
    {
      origin: 'https://www.reliancedigital.in',
      map: { '/product/fridge123': 'reliance' }
    },
    {
      origin: 'https://www.tatacliq.com',
      map: { '/smart-watch/p/123456': 'tata-cliq' }
    },
    {
      origin: 'https://www.meesho.com',
      map: { '/cotton-kurta-set/p/abc123': 'meesho' }
    },
    {
      origin: 'https://shop.example.com',
      map: {
        '/products/backpack': 'generic',
        '/products/mystery': 'low-confidence'
      }
    }
  ];
}

export async function createExtractionContext(browser) {
  const context = await browser.newContext();
  for (const file of EXTRACTION_FILES) {
    await context.addInitScript({ path: path.join(EXTENSION_DIR, file) });
  }

  // Catch-all first: specific origin routes are registered later and win.
  await context.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.abort();
    return route.fulfill({
      status: 404,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>Not found</title>'
    });
  });

  for (const entry of fixtureRoutes()) {
    await context.route(entry.origin + '/**', async (route) => {
      const url = new URL(route.request().url());
      const fixture = entry.map[url.pathname];
      if (!fixture) {
        return route.fulfill({
          status: 404,
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><title>Not found</title>'
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: readFixture(fixture)
      });
    });
  }
  return context;
}

export async function extractPage(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    return await page.evaluate(() => {
      if (!globalThis.SPT || !globalThis.SPT.ExtractionEngine) {
        throw new Error('Extraction engine was not injected');
      }
      return globalThis.SPT.ExtractionEngine.extract(document, location.href);
    });
  } finally {
    await page.close();
  }
}

function removeDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
  } catch (_) { /* best effort */ }
}

export async function launchExtension(extensionDir, options = {}) {
  const executablePath = options.executablePath || findChromium();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spt-e2e-profile-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: true,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(options.extraArgs || [])
    ]
  });

  let worker = context.serviceWorkers()[0];
  if (!worker) {
    try {
      worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    } catch (error) {
      await context.close().catch(() => {});
      removeDir(userDataDir);
      throw new Error('The extension service worker did not start. ' + error.message);
    }
  }
  const id = new URL(worker.url()).host;
  return {
    context,
    worker,
    id,
    userDataDir,
    errors: [],
    async getWorker() {
      const current = context.serviceWorkers().find((item) => item.url().includes('/background/service-worker.js'));
      if (current) return current;
      return context.waitForEvent('serviceworker', { timeout: 15000 });
    },
    async close() {
      await context.close().catch(() => {});
      removeDir(userDataDir);
    }
  };
}

export async function openDashboard(extension, options = {}) {
  const page = await extension.context.newPage();
  page.setDefaultTimeout(options.timeout || 15000);
  page.on('pageerror', (error) => extension.errors.push('dashboard: ' + String(error)));
  await page.goto(`chrome-extension://${extension.id}/dashboard/dashboard.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 20000
  });
  await page.waitForSelector('#page-content .page', { timeout: 20000 });
  return page;
}

export async function openPopup(extension) {
  const page = await extension.context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => extension.errors.push('popup: ' + String(error)));
  await page.goto(`chrome-extension://${extension.id}/popup/popup.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 20000
  });
  return page;
}

export function sendMessage(page, type, payload = {}) {
  return page.evaluate(({ type: messageType, payload: extra }) => new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ type: messageType }, extra), (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve({ ok: false, error: { code: 'RUNTIME_ERROR', message: error.message } });
        return;
      }
      resolve(response);
    });
  }), { type, payload });
}

export async function getProduct(page, id) {
  const response = await sendMessage(page, 'GET_PRODUCT', { id });
  assert.equal(response.ok, true, 'GET_PRODUCT failed: ' + JSON.stringify(response.error));
  return response.product;
}

export async function getSettings(page) {
  return page.evaluate(() => globalThis.SPT.StorageManager.getSettings());
}

export async function waitForSetting(page, key, expected, timeout = 8000) {
  await page.waitForFunction(({ key: settingKey, expected: value }) => new Promise((resolve) => {
    chrome.storage.local.get('spt:settings', (data) => {
      const settings = data['spt:settings'] || {};
      resolve(settings[settingKey] === value);
    });
  }), { key, expected }, { timeout });
}

export function seedProduct(page, overrides = {}, options = {}) {
  const product = Object.assign({
    title: 'Sony WH-1000XM5 Wireless Headphones',
    url: 'https://www.amazon.in/dp/B09Y2MYL5C',
    image: '',
    store: 'Amazon India',
    storeId: 'amazon',
    currency: 'INR',
    currentPrice: 24990,
    originalPrice: 34990,
    availability: 'InStock'
  }, overrides);
  return sendMessage(page, 'TRACK_PRODUCT', Object.assign({
    product,
    checkFrequency: 12,
    monitoringEnabled: false,
    trackingEnabled: true,
    notificationsEnabled: false
  }, options));
}

export async function waitForToast(page, text, timeout = 8000) {
  await page.waitForFunction((expected) => {
    return Array.from(document.querySelectorAll('.toast'))
      .some((toast) => toast.textContent.includes(expected));
  }, text, { timeout });
}

export async function toastTexts(page) {
  return page.locator('.toast').allInnerTexts();
}

export async function waitForModalOpen(page, timeout = 8000) {
  await page.waitForFunction(() => {
    const root = document.getElementById('modal-root');
    return root && !root.hidden;
  }, null, { timeout });
}

export async function waitForModalClosed(page, timeout = 8000) {
  await page.waitForFunction(() => {
    const root = document.getElementById('modal-root');
    return root && root.hidden;
  }, null, { timeout });
}

export async function closeModalIfOpen(page) {
  const open = await page.evaluate(() => {
    const root = document.getElementById('modal-root');
    return !!root && !root.hidden;
  });
  if (!open) return;
  const close = page.locator('#modal-close');
  if (await close.isVisible()) await close.click();
  await waitForModalClosed(page);
}

export function createTestCertificate(targetDir) {
  const pfxPath = path.join(targetDir, 'fixture-cert.pfx');
  const escaped = pfxPath.replace(/'/g, "''");
  const script = [
    "$pwd = ConvertTo-SecureString -String 'spt-test' -Force -AsPlainText;",
    "$cert = New-SelfSignedCertificate -DnsName 'www.amazon.in' -CertStoreLocation 'Cert:\\CurrentUser\\My' -NotAfter (Get-Date).AddDays(2) -KeyExportPolicy Exportable;",
    `Export-PfxCertificate -Cert $cert -FilePath '${escaped}' -Password $pwd | Out-Null;`,
    'Remove-Item -Path "Cert:\\CurrentUser\\My\\$($cert.Thumbprint)" -Force;'
  ].join(' ');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
  return pfxPath;
}

export async function startFixtureServer(pfxPath, bodyProvider) {
  const server = https.createServer({
    pfx: fs.readFileSync(pfxPath),
    passphrase: 'spt-test'
  }, (request, response) => {
    const accept = String(request.headers.accept || '');
    if (request.method !== 'GET' || !accept.includes('text/html')) {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(bodyProvider());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

export async function downloadFile(page, selector, targetDir) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.locator(selector).first().click()
  ]);
  const filePath = path.join(targetDir, Date.now() + '-' + download.suggestedFilename());
  await download.saveAs(filePath);
  return {
    filePath,
    name: download.suggestedFilename(),
    text: fs.readFileSync(filePath, 'utf8')
  };
}

export async function prepareTestExtension(targetDir) {
  const destination = path.join(targetDir, 'extension-test-copy');
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of EXTENSION_COPY_ENTRIES) {
    const source = path.join(EXTENSION_DIR, entry);
    const target = path.join(destination, entry);
    fs.cpSync(source, target, { recursive: true });
  }
  const manifestPath = path.join(destination, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['https://www.amazon.in/*'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return destination;
}

export function makeSuiteDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spt-e2e-' + name + '-'));
  return {
    dir,
    cleanup() { removeDir(dir); }
  };
}

export function assertNoExtensionErrors(extension) {
  assert.deepEqual(extension.errors, [], 'Unexpected extension page errors: ' + extension.errors.join('\n'));
}
