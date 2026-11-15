'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpt } = require('./helpers');

const SPT = createSpt();
const D = SPT.DateUtils;

test('parseDate accepts ISO strings, milliseconds and seconds', () => {
  assert.equal(D.parseDate('2026-01-01T00:00:00.000Z'), Date.UTC(2026, 0, 1));
  assert.equal(D.parseDate(Date.UTC(2026, 0, 1)), Date.UTC(2026, 0, 1));
  assert.equal(D.parseDate(Math.floor(Date.UTC(2026, 0, 1) / 1000)), Date.UTC(2026, 0, 1));
  assert.equal(D.parseDate(''), null);
  assert.equal(D.parseDate('not a date'), null);
  assert.equal(D.parseDate(0), null);
});

test('toIso and nowIso return canonical timestamps', () => {
  assert.equal(D.toIso('2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.000Z');
  assert.equal(D.toIso('nope'), null);
  assert.match(D.nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('date arithmetic is stable', () => {
  const base = '2026-01-01T00:00:00.000Z';
  assert.equal(D.addDays(base, 7), '2026-01-08T00:00:00.000Z');
  assert.equal(D.addHours(base, 12), '2026-01-01T12:00:00.000Z');
  assert.equal(D.daysBetween(base, '2026-01-08T00:00:00.000Z'), 7);
  assert.equal(D.daysBetween(base, 'nope'), 0);
  assert.equal(D.isOlderThan('2020-01-01T00:00:00.000Z', D.DAY), true);
  assert.equal(D.isOlderThan(D.nowIso(), D.DAY), false);
});

test('filterHistoryByRange keeps only observations inside the range', () => {
  const reference = Date.UTC(2026, 5, 1);
  const history = [
    { price: 100, date: new Date(reference - 5 * D.DAY).toISOString(), source: 'auto' },
    { price: 90, date: new Date(reference - 40 * D.DAY).toISOString(), source: 'auto' },
    { price: 80, date: new Date(reference - 100 * D.DAY).toISOString(), source: 'auto' },
    { price: 70, date: 'bad date', source: 'auto' }
  ];
  assert.equal(D.filterHistoryByRange(history, '7d', reference).map((entry) => entry.price).join(','), '100');
  assert.equal(D.filterHistoryByRange(history, '30d', reference).map((entry) => entry.price).join(','), '100');
  assert.equal(D.filterHistoryByRange(history, '90d', reference).map((entry) => entry.price).join(','), '90,100');
  assert.equal(D.filterHistoryByRange(history, 'all', reference).map((entry) => entry.price).join(','), '80,90,100');
  assert.equal(D.filterHistoryByRange(history, '30d', reference)[0]._ms, reference - 5 * D.DAY);
});

test('human durations and relative dates are readable', () => {
  assert.equal(D.humanDuration(30 * 1000), 'less than a minute');
  assert.equal(D.humanDuration(60 * 1000), '1 minute');
  assert.equal(D.humanDuration(2 * D.HOUR), '2 hours');
  assert.equal(D.humanDuration(3 * D.DAY), '3 days');
  assert.equal(D.humanDuration(60 * D.DAY), '2 months');
  assert.match(D.formatRelative(new Date(Date.now() - 2 * D.DAY).toISOString()), /ago$/);
  assert.match(D.formatRelativeFuture(new Date(Date.now() + 2 * D.DAY).toISOString()), /^in /);
  assert.equal(D.formatRelativeFuture(null), 'Not scheduled');
});

test('display formatters never throw on invalid input', () => {
  assert.equal(D.formatDate(null), '—');
  assert.equal(D.formatShortDate(null), '—');
  assert.equal(D.formatChartDate(null), '—');
  assert.notEqual(D.formatDate('2026-01-01T00:00:00.000Z'), '—');
});
