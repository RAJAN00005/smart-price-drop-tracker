'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpt } = require('./helpers');

const SPT = createSpt();
const DM = SPT.DataModel;
const D = SPT.DateUtils;
const V = SPT.Validation;

const SETTINGS = V.sanitizeSettings({ defaultFrequency: 12 });

function productInput(overrides) {
  return Object.assign({
    title: 'Sony WH-1000XM5 Wireless Headphones',
    url: 'https://www.amazon.in/dp/B09Y2MYL5C?tag=tracking',
    image: 'https://m.media-amazon.com/images/I/mock.jpg',
    store: 'Amazon India',
    storeId: 'amazon',
    currency: 'INR',
    currentPrice: 24990,
    originalPrice: 34990,
    availability: 'InStock'
  }, overrides || {});
}

function fixedHistory() {
  return [
    { price: 29990, date: '2026-01-01T00:00:00.000Z', source: 'initial' },
    { price: 27990, date: '2026-01-10T00:00:00.000Z', source: 'auto' },
    { price: 24990, date: '2026-01-20T00:00:00.000Z', source: 'auto' }
  ];
}

test('sanitizeProduct produces a canonical, safe product record', () => {
  const product = DM.sanitizeProduct(productInput({
    targetPrice: 22000,
    priceHistory: fixedHistory(),
    createdAt: '2026-01-01T00:00:00.000Z',
    lastChecked: '2026-01-20T00:00:00.000Z'
  }));
  assert.match(product.id, /^p_/);
  assert.equal(product.title, 'Sony WH-1000XM5 Wireless Headphones');
  assert.equal(product.url, 'https://www.amazon.in/dp/B09Y2MYL5C');
  assert.equal(product.normalizedUrl, 'https://amazon.in/dp/B09Y2MYL5C');
  assert.equal(product.storeId, 'amazon');
  assert.equal(product.store, 'Amazon India');
  assert.equal(product.currentPrice, 24990);
  assert.equal(product.originalPrice, 34990);
  assert.equal(product.targetPrice, 22000);
  assert.equal(product.lowestPrice, 24990);
  assert.equal(product.highestPrice, 29990);
  assert.equal(product.averagePrice, 27656.67);
  assert.equal(product.totalDrops, 2);
  assert.equal(product.previousPrice, 27990);
  assert.equal(product.availability, 'InStock');
  assert.equal(product.trackingEnabled, true);
  assert.equal(product.monitoringEnabled, true);
  assert.equal(product.checkFrequency, 12);
  assert.equal(product.checkStatus, 'idle');
  assert.equal(product.priceHistory.length, 3);
  assert.equal(product.lastExtraction.source, '');
  assert.ok(product.lastExtraction.at);
});

test('sanitizeProduct drops unknown fields and unsafe values', () => {
  const product = DM.sanitizeProduct(productInput({
    image: 'javascript:alert(1)',
    originalPrice: 100,
    targetPrice: 0,
    availability: 'https://schema.org/OutOfStock',
    unknownField: 'must not survive'
  }));
  assert.equal(product.image, '');
  assert.equal(product.originalPrice, null);
  assert.equal(product.targetPrice, null);
  assert.equal(product.availability, 'OutOfStock');
  assert.equal(Object.prototype.hasOwnProperty.call(product, 'unknownField'), false);
});

test('sanitizeProduct rejects invalid products with specific error codes', () => {
  assert.throws(() => DM.sanitizeProduct(productInput({ url: 'javascript:alert(1)' })), (error) => error.code === 'INVALID_URL');
  assert.throws(() => DM.sanitizeProduct(productInput({ title: '' })), (error) => error.code === 'TITLE_NOT_FOUND');
  assert.throws(() => DM.sanitizeProduct(productInput({ currentPrice: 0 })), (error) => error.code === 'INVALID_PRICE');
  assert.throws(() => DM.sanitizeProduct(null), (error) => error.code === 'VALIDATION_ERROR');
});

test('createProduct seeds history and extraction metadata', () => {
  const product = DM.createProduct(productInput({
    targetPrice: 20000,
    confidence: 0.96,
    extractionSource: 'Amazon price selector'
  }), SETTINGS);
  assert.match(product.id, /^p_/);
  assert.equal(product.currentPrice, 24990);
  assert.equal(product.priceHistory.length, 1);
  assert.equal(product.priceHistory[0].source, 'initial');
  assert.equal(product.lastChecked, product.priceHistory[0].date);
  assert.equal(product.checkStatus, 'ok');
  assert.equal(product.lastConfidence, 0.96);
  assert.equal(product.lastExtraction.source, 'Amazon price selector');
  assert.equal(product.checkFrequency, 12);
  assert.throws(() => DM.createProduct({ title: 'No price', url: 'https://example.com/x' }, SETTINGS), (error) => error.code === 'INVALID_PRICE');
});

test('applyPriceUpdate records drops, targets and statistics', () => {
  const product = DM.createProduct(productInput({ currentPrice: 1200, targetPrice: 1000 }), SETTINGS);
  product.priceHistory[0].date = '2026-01-01T00:00:00.000Z';
  product.lastChecked = '2026-01-01T00:00:00.000Z';
  const at = '2026-01-02T00:00:00.000Z';
  const report = DM.applyPriceUpdate(product, 900, { source: 'auto', at: at });
  assert.equal(report.price, 900);
  assert.equal(report.previousPrice, 1200);
  assert.equal(report.changed, true);
  assert.equal(report.isDrop, true);
  assert.equal(report.dropAmount, 300);
  assert.equal(report.dropPercent, 25);
  assert.equal(report.targetDue, true);
  assert.equal(report.lowestPrice, 900);
  assert.equal(report.highestPrice, 1200);
  assert.equal(report.averagePrice, 1050);
  assert.equal(product.currentPrice, 900);
  assert.equal(product.priceHistory.length, 2);
  assert.equal(product.lastDropAt, at);
  assert.equal(product.lastPriceChangeAt, at);
  assert.equal(product.checkStatus, 'ok');
  assert.equal(product.lastError, null);
  assert.equal(product.consecutiveFailures, 0);
});

test('applyPriceUpdate handles same-price confirmations and original price rules', () => {
  const product = DM.createProduct(productInput({ currentPrice: 24990, originalPrice: 34990 }), SETTINGS);
  const report = DM.applyPriceUpdate(product, 24990, { source: 'manual', originalPrice: 34990 });
  assert.equal(report.changed, false);
  assert.equal(report.isDrop, false);
  assert.equal(report.dropAmount, 0);
  assert.equal(product.originalPrice, 34990);
  assert.equal(product.priceHistory.length, 2);
  assert.equal(product.priceHistory[1].source, 'manual');

  product.originalPrice = 20000;
  DM.applyPriceUpdate(product, 24990, { source: 'manual' });
  assert.equal(product.originalPrice, null);
});

test('applyPriceUpdate resets target notification state when price rises above target', () => {
  const product = DM.createProduct(productInput({ currentPrice: 900, targetPrice: 1000 }), SETTINGS);
  product.targetNotified = true;
  const report = DM.applyPriceUpdate(product, 1100, { source: 'auto' });
  assert.equal(report.targetDue, false);
  assert.equal(product.targetNotified, false);
});

test('markCheckFailure preserves the last valid price', () => {
  const product = DM.createProduct(productInput({ currentPrice: 24990 }), SETTINGS);
  const before = product.priceHistory.length;
  const info = DM.markCheckFailure(product, { code: 'CAPTCHA' }, { nextCheck: '2026-01-03T00:00:00.000Z' });
  assert.equal(info.code, 'CAPTCHA');
  assert.equal(product.currentPrice, 24990);
  assert.equal(product.priceHistory.length, before);
  assert.equal(product.checkStatus, 'failed');
  assert.equal(product.lastError.code, 'CAPTCHA');
  assert.equal(product.consecutiveFailures, 1);
  assert.equal(product.nextCheck, '2026-01-03T00:00:00.000Z');

  DM.markCheckFailure(product, { code: 'PERMISSION_REQUIRED' });
  assert.equal(product.checkStatus, 'permission-required');
  assert.equal(product.consecutiveFailures, 2);
});

test('markNotificationSent records deduplication state', () => {
  const product = DM.createProduct(productInput({ currentPrice: 900, targetPrice: 1000 }), SETTINGS);
  DM.markNotificationSent(product, { price: 900 }, true);
  assert.equal(product.lastNotifiedPrice, 900);
  assert.equal(product.targetNotified, true);
  assert.ok(product.lastTargetNotifiedAt);
});

test('tracking and target helpers validate and update state', () => {
  const product = DM.createProduct(productInput({ currentPrice: 24990 }), SETTINGS);
  DM.setTracking(product, false);
  assert.equal(product.trackingEnabled, false);
  assert.equal(product.checkStatus, 'paused');
  assert.equal(product.nextCheck, null);

  DM.setTracking(product, true, '2026-01-03T00:00:00.000Z');
  assert.equal(product.trackingEnabled, true);
  assert.equal(product.nextCheck, '2026-01-03T00:00:00.000Z');

  DM.setTarget(product, '₹22,000');
  assert.equal(product.targetPrice, 22000);
  assert.equal(product.targetNotified, false);
  assert.throws(() => DM.setTarget(product, 'not a price'), (error) => error.code === 'INVALID_PRICE');
  DM.setTarget(product, null);
  assert.equal(product.targetPrice, null);
});

test('history sanitization sorts, deduplicates and appends the current price', () => {
  const history = DM.sanitizeHistory([
    { price: 100, date: '2026-01-01T00:00:00.000Z', source: 'initial' },
    { price: 90, date: '2026-01-02T00:00:00.000Z', source: 'auto' },
    { price: 90, date: '2026-01-02T00:00:00.000Z', source: 'auto' },
    { price: 'bad', date: '2026-01-02T00:00:00.000Z', source: 'auto' }
  ], 80, '2026-01-03T00:00:00.000Z');
  assert.equal(history.map((entry) => entry.price).join(','), '100,90,80');
  assert.equal(history[2].source, 'import');
});

test('trimHistory preserves the first observation and recent data', () => {
  const history = [];
  for (let i = 1; i <= 2001; i++) {
    history.push({ price: i, date: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(), source: 'auto' });
  }
  const trimmed = DM.trimHistory(history, 2000);
  assert.equal(trimmed.length, 2000);
  assert.equal(trimmed[0].price, 1);
  assert.equal(trimmed[trimmed.length - 1].price, 2001);
});

test('statsFromHistory reports lowest, highest, average, drops and previous distinct price', () => {
  const stats = DM.statsFromHistory([
    { price: 100, date: '2026-01-01T00:00:00.000Z' },
    { price: 90, date: '2026-01-02T00:00:00.000Z' },
    { price: 80, date: '2026-01-03T00:00:00.000Z' }
  ], 80);
  assert.equal(stats.lowestPrice, 80);
  assert.equal(stats.highestPrice, 100);
  assert.equal(stats.averagePrice, 90);
  assert.equal(stats.totalDrops, 2);
  assert.equal(stats.previousPrice, 90);
  assert.equal(stats.points, 3);
  assert.equal(stats.firstPriceDate, '2026-01-01T00:00:00.000Z');
  assert.equal(stats.lastPriceDate, '2026-01-03T00:00:00.000Z');
});

test('summary aggregates dashboard metrics', () => {
  const p1 = DM.createProduct(productInput({ currentPrice: 900, originalPrice: 1200 }), SETTINGS);
  p1.lowestPrice = 900;
  p1.highestPrice = 1200;
  p1.totalDrops = 1;
  const p2 = DM.createProduct(productInput({
    title: 'Refrigerator',
    url: 'https://www.reliancedigital.in/product/fridge123',
    store: 'Reliance Digital',
    storeId: 'reliance',
    currentPrice: 5000
  }), SETTINGS);
  p2.lowestPrice = 5000;
  p2.highestPrice = 6000;
  p2.totalDrops = 0;
  p1.checkStatus = 'permission-required';
  const summary = DM.summary([p1, p2]);
  assert.equal(summary.totalTracked, 2);
  assert.equal(summary.productsWithDrops, 1);
  assert.equal(summary.atLowest, 2);
  assert.equal(summary.active, 2);
  assert.equal(summary.permissionNeeded, 1);
  assert.equal(summary.potentialSavings, 1300);
});

test('validateBackup accepts wrapped data and skips invalid records', () => {
  const valid = DM.createProduct(productInput(), SETTINGS);
  const payload = {
    data: {
      products: [
        valid,
        { title: 'Broken product' }
      ],
      settings: { defaultFrequency: 6, notificationsEnabled: false }
    }
  };
  const backup = DM.validateBackup(payload);
  assert.equal(backup.products.length, 1);
  assert.equal(backup.skipped, 1);
  assert.equal(backup.errors.length, 1);
  assert.equal(backup.settings.defaultFrequency, 6);
  assert.equal(backup.settings.notificationsEnabled, false);
  assert.equal(backup.products[0].title, valid.title);
});

test('validateBackup rejects empty and malformed backups', () => {
  assert.throws(() => DM.validateBackup({ products: [] }), (error) => error.code === 'INVALID_IMPORT');
  assert.throws(() => DM.validateBackup({}), (error) => error.code === 'INVALID_IMPORT');
  assert.throws(() => DM.validateBackup(null), (error) => error.code === 'INVALID_IMPORT');
});

test('exportPayload contains app metadata, settings and sanitized products', () => {
  const product = DM.createProduct(productInput(), SETTINGS);
  const payload = DM.exportPayload([product], SETTINGS);
  assert.equal(payload.app, 'Smart Price Drop Tracker');
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.products.length, 1);
  assert.equal(payload.products[0].title, product.title);
  assert.equal(payload.settings.defaultFrequency, 12);
  assert.ok(payload.exportedAt);
});

test('toCsv escapes user text and produces a stable header', () => {
  const product = DM.createProduct(productInput({ title: '=SUM(A1:A2)' }), SETTINGS);
  product.store = 'Amazon, India';
  const csv = DM.toCsv([product]);
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('Product Name,Website,Current Price'));
  assert.ok(lines[1].startsWith("'=SUM(A1:A2),\"Amazon, India\",24990"));
  assert.ok(lines[1].includes('https://www.amazon.in/dp/B09Y2MYL5C'));
});

test('migrateLegacyProduct maps snake_case fields', () => {
  const migrated = DM.migrateLegacyProduct({
    title: 'Legacy product',
    url: 'https://www.flipkart.com/item/p/itm123?pid=ABC123',
    current_price: 4999,
    mrp: 6999,
    price_history: [
      { price: 6999, date: '2026-01-01T00:00:00.000Z', source: 'initial' },
      { price: 4999, date: '2026-01-02T00:00:00.000Z', source: 'auto' }
    ],
    last_checked: '2026-01-02T00:00:00.000Z',
    next_check: '2026-01-03T00:00:00.000Z',
    target_price: 4500,
    tracking_enabled: true
  });
  assert.equal(migrated.currentPrice, 4999);
  assert.equal(migrated.originalPrice, 6999);
  assert.equal(migrated.targetPrice, 4500);
  assert.equal(migrated.priceHistory.length, 2);
  assert.equal(migrated.nextCheck, '2026-01-03T00:00:00.000Z');
  assert.equal(DM.migrateLegacyProduct(null), null);
  assert.equal(DM.migrateLegacyProduct({ title: 'broken' }), null);
});
