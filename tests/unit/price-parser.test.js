'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpt } = require('./helpers');

const SPT = createSpt();
const P = SPT.PriceParser;

test('normalizeNumber handles Indian and Western grouping', () => {
  assert.equal(P.normalizeNumber('₹1,25,999'), 125999);
  assert.equal(P.normalizeNumber('₹1,25,999.50'), 125999.5);
  assert.equal(P.normalizeNumber('₹24,990'), 24990);
  assert.equal(P.normalizeNumber('1,299.00'), 1299);
  assert.equal(P.normalizeNumber('1.299,00'), 1299);
  assert.equal(P.normalizeNumber('1,299'), 1299);
  assert.equal(P.normalizeNumber('1.299'), 1299);
  assert.equal(P.normalizeNumber('Rs. 899'), 899);
  assert.equal(P.normalizeNumber('$1,299'), 1299);
});

test('normalizeNumber rejects values without a usable number', () => {
  assert.equal(P.normalizeNumber(''), null);
  assert.equal(P.normalizeNumber(null), null);
  assert.equal(P.normalizeNumber('free'), null);
  assert.equal(P.normalizeNumber('₹'), null);
  assert.equal(P.normalizeNumber('1,23,45,67,890'), null);
});

test('parse reads currency-marked prices and defaults currency', () => {
  const parsed = P.parse('₹1,25,999');
  assert.equal(parsed.value, 125999);
  assert.equal(parsed.currency, 'INR');
  assert.equal(parsed.raw, '₹1,25,999');
  assert.equal(parsed.symbol, '₹');
  assert.equal(P.parse('INR 24,990').value, 24990);
  assert.equal(P.parse('Rs. 899').value, 899);
  assert.equal(P.parse('$1,299').currency, 'USD');
  assert.equal(P.parse('€1.299,00').value, 1299);
  assert.equal(P.parse('1,299', { allowBare: true }).value, 1299);
  assert.equal(P.parse('1,299', { allowBare: true, defaultCurrency: 'USD' }).currency, 'USD');
});

test('parse rejects bare text unless explicitly allowed', () => {
  assert.equal(P.parse('24990'), null);
  assert.equal(P.parse('24990', { allowBare: false }), null);
  assert.equal(P.parse('24990', { allowBare: true }).value, 24990);
  assert.equal(P.parse('50% off', { allowBare: true }), null);
});

test('parse rejects discounts, EMI, delivery and MRP context by default', () => {
  assert.equal(P.parse('MRP ₹1,499'), null);
  assert.equal(P.parse('You save ₹500'), null);
  assert.equal(P.parse('EMI from ₹1,499/month'), null);
  assert.equal(P.parse('Delivery fee ₹199'), null);
  assert.equal(P.parse('Coupon discount ₹1,500'), null);
  assert.equal(P.parse('₹1,499 (20% off)'), null);
  assert.equal(P.parse('MRP ₹1,499', { trustedContext: true }).value, 1499);
  assert.equal(P.parse('EMI from ₹1,499/month', { trustedContext: true }).value, 1499);
});

test('extractMentions returns distinct currency-marked prices with context', () => {
  const mentions = P.extractMentions('Deal price ₹1,299. MRP ₹1,999. EMI ₹499/month.');
  assert.equal(mentions.length, 3);
  assert.equal(mentions.map((entry) => entry.value).join(','), '1299,1999,499');
  assert.ok(mentions[0].context.includes('Deal price'));
  assert.ok(mentions[0].index >= 0);
});

test('extractMentions respects the candidate cap', () => {
  const mentions = P.extractMentions('₹10 ₹20 ₹30 ₹40', { maxCandidates: 2 });
  assert.equal(mentions.length, 2);
});

test('rejectionContext and isRecurringContext classify common noise', () => {
  assert.equal(P.rejectionContext('20% off today'), true);
  assert.equal(P.rejectionContext('Bank offer available'), true);
  assert.equal(P.rejectionContext('Selling price'), false);
  assert.equal(P.isRecurringContext('EMI of ₹999'), true);
  assert.equal(P.isRecurringContext('per month'), true);
  assert.equal(P.isRecurringContext('one-time price'), false);
});

test('formatting helpers produce readable Indian prices', () => {
  const formatted = P.formatPrice(125999, 'INR');
  assert.ok(formatted.includes('1,25,999'));
  assert.ok(formatted.includes('₹'));
  const coded = P.formatPrice(125999, 'INR', { currencyDisplay: 'code' });
  assert.ok(coded.includes('INR'));
  assert.ok(P.formatCompact(125999, 'INR').length > 0);
  assert.equal(P.formatPrice(Number.NaN, 'INR'), '—');
});

test('discount and change calculations are rounded', () => {
  assert.equal(P.discountPercent(1999, 1499), 25);
  assert.equal(P.discountPercent(1499, 1999), 0);
  assert.equal(P.discountPercent(0, 100), 0);
  assert.equal(P.percentChange(100, 90), -10);
  assert.equal(P.percentChange(100, 110), 10);
  assert.equal(P.percentChange(0, 110), 0);
});

test('plausibility bounds reject absurd prices', () => {
  assert.equal(P.isPlausible(1), true);
  assert.equal(P.isPlausible(0), false);
  assert.equal(P.isPlausible(-1), false);
  assert.equal(P.isPlausible(1000000001), false);
  assert.equal(P.isPlausible('100'), false);
});
