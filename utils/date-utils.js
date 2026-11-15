/**
 * Smart Price Drop Tracker — date & time helpers.
 * Loaded as a classic script in extension pages, the service worker and
 * injected extractor frames. Everything is exposed through globalThis.SPT.
 */
(function (root) {
  'use strict';

  var MINUTE = 60 * 1000;
  var HOUR = 60 * MINUTE;
  var DAY = 24 * HOUR;

  function parseDate(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value <= 0) return null;
      // Accept seconds, milliseconds and Chrome alarm timestamps.
      return value < 100000000000 ? Math.round(value * 1000) : Math.round(value);
    }
    if (typeof value === 'string') {
      var trimmed = value.trim();
      if (!trimmed) return null;
      if (/^\d{10,13}$/.test(trimmed)) {
        var numeric = Number(trimmed);
        return numeric < 100000000000 ? numeric * 1000 : numeric;
      }
      var ms = Date.parse(trimmed);
      return Number.isFinite(ms) ? ms : null;
    }
    return null;
  }

  function toIso(value) {
    var ms = parseDate(value);
    return ms === null ? null : new Date(ms).toISOString();
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function isValidDate(value) {
    return parseDate(value) !== null;
  }

  function formatDate(value, options) {
    var ms = parseDate(value);
    if (ms === null) return '—';
    var opts = options || {};
    try {
      return new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        year: opts.year === false ? undefined : 'numeric',
        hour: opts.time === false ? undefined : 'numeric',
        minute: opts.time === false ? undefined : '2-digit'
      }).format(new Date(ms));
    } catch (_) {
      return new Date(ms).toLocaleString('en-IN');
    }
  }

  function formatShortDate(value) {
    var ms = parseDate(value);
    if (ms === null) return '—';
    try {
      return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' }).format(new Date(ms));
    } catch (_) {
      return new Date(ms).toLocaleDateString('en-IN');
    }
  }

  function formatChartDate(value, withYear) {
    var ms = parseDate(value);
    if (ms === null) return '—';
    try {
      return new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        year: withYear ? '2-digit' : undefined
      }).format(new Date(ms));
    } catch (_) {
      return new Date(ms).toLocaleDateString('en-IN');
    }
  }

  function humanDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    if (ms < MINUTE) return 'less than a minute';
    if (ms < HOUR) {
      var minutes = Math.round(ms / MINUTE);
      return minutes + (minutes === 1 ? ' minute' : ' minutes');
    }
    if (ms < DAY) {
      var hours = Math.round(ms / HOUR);
      return hours + (hours === 1 ? ' hour' : ' hours');
    }
    var days = Math.round(ms / DAY);
    if (days < 30) return days + (days === 1 ? ' day' : ' days');
    var months = Math.round(days / 30);
    if (months < 12) return months + (months === 1 ? ' month' : ' months');
    var years = (days / 365).toFixed(1).replace(/\.0$/, '');
    return years + ' years';
  }

  function formatRelative(value) {
    var ms = parseDate(value);
    if (ms === null) return '—';
    var diff = ms - Date.now();
    var abs = Math.abs(diff);
    if (abs < 45000) return 'just now';
    var text = humanDuration(abs);
    return diff < 0 ? text + ' ago' : 'in ' + text;
  }

  function formatRelativeFuture(value) {
    var ms = parseDate(value);
    if (ms === null) return 'Not scheduled';
    return formatRelative(ms);
  }

  function startOfDay(value) {
    var ms = parseDate(value);
    if (ms === null) return null;
    var d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function addDays(value, days) {
    var ms = parseDate(value);
    if (ms === null) return null;
    return new Date(ms + days * DAY).toISOString();
  }

  function addHours(value, hours) {
    var ms = parseDate(value);
    if (ms === null) return null;
    return new Date(ms + hours * HOUR).toISOString();
  }

  function isOlderThan(value, ms) {
    var parsed = parseDate(value);
    return parsed !== null && Date.now() - parsed > ms;
  }

  function rangeToMs(range) {
    switch (range) {
      case '7d': return 7 * DAY;
      case '30d': return 30 * DAY;
      case '90d': return 90 * DAY;
      case 'all': return null;
      default: return 30 * DAY;
    }
  }

  function filterHistoryByRange(history, range, referenceTime) {
    var items = Array.isArray(history) ? history : [];
    var cutoffMs = rangeToMs(range);
    var now = Number.isFinite(referenceTime) ? referenceTime : Date.now();
    var result = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var ms = parseDate(item && item.date);
      if (ms === null) continue;
      if (cutoffMs !== null && ms < now - cutoffMs) continue;
      result.push({ price: Number(item.price), date: item.date, source: item.source || 'auto', _ms: ms });
    }
    result.sort(function (a, b) { return a._ms - b._ms; });
    return result;
  }

  function daysBetween(a, b) {
    var ams = parseDate(a);
    var bms = parseDate(b);
    if (ams === null || bms === null) return 0;
    return Math.round(Math.abs(bms - ams) / DAY);
  }

  var DateUtils = {
    MINUTE: MINUTE,
    HOUR: HOUR,
    DAY: DAY,
    parseDate: parseDate,
    toIso: toIso,
    nowIso: nowIso,
    isValidDate: isValidDate,
    formatDate: formatDate,
    formatShortDate: formatShortDate,
    formatChartDate: formatChartDate,
    formatRelative: formatRelative,
    formatRelativeFuture: formatRelativeFuture,
    humanDuration: humanDuration,
    startOfDay: startOfDay,
    addDays: addDays,
    addHours: addHours,
    isOlderThan: isOlderThan,
    rangeToMs: rangeToMs,
    filterHistoryByRange: filterHistoryByRange,
    daysBetween: daysBetween
  };

  root.SPT = root.SPT || {};
  root.SPT.DateUtils = DateUtils;
})(typeof globalThis !== 'undefined' ? globalThis : self);
