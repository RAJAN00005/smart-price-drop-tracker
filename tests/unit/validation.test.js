'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpt } = require('./helpers');

const SPT = createSpt();
const V = SPT.Validation;

test('cleanText removes control characters and collapses whitespace', () => {
  assert.equal(V.cleanText('  Sony\u0000  headphones  '), 'Sony headphones');
  assert.equal(V.cleanText('Line one\nLine two', 100, { multiline: true }), 'Line one\nLine two');
  assert.equal(V.cleanText('A'.repeat(20), 10), 'A'.repeat(10));
  assert.equal(V.cleanText(null), '');
});

test('asPrice accepts formatted Indian amounts and rejects invalid values', () => {
  assert.equal(V.asPrice('₹1,25,999'), 125999);
  assert.equal(V.asPrice('Rs. 1,499.50'), 1499.5);
  assert.equal(V.asPrice(24990), 24990);
  assert.equal(V.asPrice('0'), null);
  assert.equal(V.asPrice('-10'), null);
  assert.equal(V.asPrice('abc'), null);
  assert.equal(V.asPrice(null), null);
  assert.equal(V.asPrice(100, { min: 500 }), null);
});

test('asTargetPrice treats an empty target as no target', () => {
  assert.equal(V.asTargetPrice(''), null);
  assert.equal(V.asTargetPrice(null), null);
  assert.equal(V.asTargetPrice('₹1,000'), 1000);
  assert.equal(V.asTargetPrice('0'), null);
});

test('boolean, date, frequency and availability normalizers are strict', () => {
  assert.equal(V.asBoolean('true', false), true);
  assert.equal(V.asBoolean('false', true), false);
  assert.equal(V.asBoolean('yes', true), true);
  assert.equal(V.asFrequency('6'), 6);
  assert.equal(V.asFrequency(24), 24);
  assert.equal(V.asFrequency(5), 12);
  assert.equal(V.asFrequency(5, 24), 24);
  assert.equal(V.asAvailability('https://schema.org/InStock'), 'InStock');
  assert.equal(V.asAvailability('sold out'), 'OutOfStock');
  assert.equal(V.asAvailability('pre-order'), 'PreOrder');
  assert.equal(V.asAvailability('something else'), 'Unknown');
  assert.equal(V.asCheckStatus('failed'), 'failed');
  assert.equal(V.asCheckStatus('bogus'), 'idle');
});

test('currency and URL sanitizers are defensive', () => {
  assert.equal(V.normalizeCurrency('inr'), 'INR');
  assert.equal(V.normalizeCurrency('usd'), 'USD');
  assert.equal(V.normalizeCurrency('x', 'INR'), 'INR');
  assert.equal(V.safeUrl('https://example.com/product#x'), 'https://example.com/product');
  assert.equal(V.safeUrl('javascript:alert(1)'), '');
  assert.equal(V.safeUrl('https://cdn.example.com/a.jpg', { image: true }), 'https://cdn.example.com/a.jpg');
  assert.equal(V.safeUrl('javascript:alert(1)', { image: true }), '');
});

test('sanitizeSettings clamps and repairs every setting', () => {
  const settings = V.sanitizeSettings({
    defaultFrequency: 6,
    notificationsEnabled: false,
    priceDropNotifications: false,
    targetNotifications: true,
    theme: 'neon',
    currencyDisplay: 'code',
    maxConcurrentChecks: 99
  });
  assert.equal(settings.defaultFrequency, 6);
  assert.equal(settings.notificationsEnabled, false);
  assert.equal(settings.priceDropNotifications, false);
  assert.equal(settings.targetNotifications, true);
  assert.equal(settings.theme, 'system');
  assert.equal(settings.currencyDisplay, 'code');
  assert.equal(settings.maxConcurrentChecks, 4);
  assert.equal(settings.schemaVersion, 1);
  assert.ok(settings.updatedAt);
});

test('validateSettings rejects non-objects', () => {
  assert.throws(() => V.validateSettings(null), (error) => error.code === 'INVALID_SETTINGS');
  assert.throws(() => V.validateSettings([]), (error) => error.code === 'INVALID_SETTINGS');
});

test('escapeCsv protects against spreadsheet formula injection', () => {
  assert.equal(V.escapeCsv('=SUM(A1:A2)'), "'=SUM(A1:A2)");
  assert.equal(V.escapeCsv('+91 99999 99999'), "'+91 99999 99999");
  assert.equal(V.escapeCsv('-10'), "'-10");
  assert.equal(V.escapeCsv('a,b'), '"a,b"');
  assert.equal(V.escapeCsv('say "hello"'), '"say ""hello"""');
  assert.equal(V.escapeCsv(null), '');
});

test('error helpers always expose a safe user message', () => {
  const info = V.asErrorInfo({ code: 'CAPTCHA' });
  assert.equal(info.code, 'CAPTCHA');
  assert.equal(info.message, V.ERROR_MESSAGES.CAPTCHA);
  assert.ok(info.at);
  assert.equal(V.userMessage('PRICE_NOT_FOUND'), V.ERROR_MESSAGES.PRICE_NOT_FOUND);
  assert.equal(V.userMessage({ code: 'BLOCKED' }), V.ERROR_MESSAGES.BLOCKED);
  assert.equal(V.userMessage(null, 'UNKNOWN'), V.ERROR_MESSAGES.UNKNOWN);
});

test('formatBytes and approxBytes report storage sizes', () => {
  assert.equal(V.formatBytes(0), '0 B');
  assert.equal(V.formatBytes(1024), '1.0 KB');
  assert.equal(V.formatBytes(1024 * 1024), '1.00 MB');
  assert.ok(V.approxBytes({ a: 1 }) > 0);
});

test('uid produces a valid product identifier', () => {
  const id = V.uid('p_');
  assert.match(id, /^p_[A-Za-z0-9_-]{2,100}$/);
  assert.notEqual(V.uid('p_'), V.uid('p_'));
});
