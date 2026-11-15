/**
 * Price parsing and formatting.
 *
 * Handles Indian and international grouping, currency symbols/codes,
 * decimals and common e-commerce noise. Price detection never trusts the
 * first number on a page by itself; this module only normalizes a string
 * that a strategy has already selected.
 */
(function (root) {
  'use strict';

  var MAX_PRICE = 1000000000;

  var SYMBOL_MAP = [
    { re: /₹/, currency: 'INR' },
    { re: /\bINR\b/i, currency: 'INR' },
    { re: /\bRs\.?(?=\s|\d|$)/i, currency: 'INR' },
    { re: /\bUSD\b/i, currency: 'USD' },
    { re: /\bUS\$\s*/, currency: 'USD' },
    { re: /\$/, currency: 'USD' },
    { re: /€/, currency: 'EUR' },
    { re: /\bEUR\b/i, currency: 'EUR' },
    { re: /£/, currency: 'GBP' },
    { re: /\bGBP\b/i, currency: 'GBP' },
    { re: /\bAED\b/i, currency: 'AED' },
    { re: /د\.إ/, currency: 'AED' },
    { re: /\bSGD\b/i, currency: 'SGD' },
    { re: /\bAUD\b/i, currency: 'AUD' },
    { re: /\bCAD\b/i, currency: 'CAD' },
    { re: /¥/, currency: 'JPY' },
    { re: /\bJPY\b/i, currency: 'JPY' }
  ];

  var CURRENCY_PATTERN = '(?:₹|\\bINR\\b|\\bRs\\.?|US\\$|\\$|€|\\bEUR\\b|£|\\bGBP\\b|\\bAED\\b|د\\.إ|\\bSGD\\b|\\bAUD\\b|\\bCAD\\b|¥|\\bJPY\\b)';
  var NUMBER_PATTERN = '\\d[\\d,.]{0,24}';
  var CURRENCY_FIRST_RE = new RegExp('(' + CURRENCY_PATTERN + ')\\s*(' + NUMBER_PATTERN + ')', 'gi');
  var CURRENCY_LAST_RE = new RegExp('(' + NUMBER_PATTERN + ')\\s*(' + CURRENCY_PATTERN + ')', 'gi');
  var BARE_NUMBER_RE = /(?:^|[^\d.,])(\d[\d,.]{0,20})(?![\d])/;

  /**
   * Global regexes carry mutable lastIndex state. `parse` can be called while
   * `extractMentions` is iterating, so each call gets its own regex instances.
   */
  function freshCurrencyRegexes() {
    return [
      new RegExp(CURRENCY_FIRST_RE.source, 'gi'),
      new RegExp(CURRENCY_LAST_RE.source, 'gi')
    ];
  }

  var SYMBOLS = {
    INR: '₹',
    USD: '$',
    EUR: '€',
    GBP: '£',
    AED: 'AED ',
    SGD: 'S$',
    AUD: 'A$',
    CAD: 'C$',
    JPY: '¥'
  };

  function cleanText(text) {
    if (text === null || text === undefined) return '';
    return String(text)
      .replace(/\u00A0/g, ' ')
      .replace(/\u2007/g, ' ')
      .replace(/\u202F/g, ' ')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function detectCurrency(text) {
    var value = cleanText(text);
    if (!value) return null;
    for (var i = 0; i < SYMBOL_MAP.length; i++) {
      if (SYMBOL_MAP[i].re.test(value)) return SYMBOL_MAP[i].currency;
    }
    return null;
  }

  function stripCurrency(text) {
    return cleanText(text)
      .replace(/₹|\bINR\b|\bRs\.?/gi, ' ')
      .replace(/US\$|\$/g, ' ')
      .replace(/€|\bEUR\b/g, ' ')
      .replace(/£|\bGBP\b/g, ' ')
      .replace(/\bAED\b|د\.إ/gi, ' ')
      .replace(/\bSGD\b|\bAUD\b|\bCAD\b/gi, ' ')
      .replace(/¥|\bJPY\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Converts a display amount into a Number.
   * Indian: "1,25,999.50" -> 125999.5
   * Western: "1,299.00" -> 1299
   */
  function normalizeNumber(raw) {
    if (raw === null || raw === undefined) return null;
    var value = cleanText(raw);
    if (!value) return null;
    value = stripCurrency(value);
    // Keep only the first number-like token (avoid "1299 1499").
    var tokenMatch = value.match(/\d[\d,.]*\d|\d/);
    if (!tokenMatch) return null;
    value = tokenMatch[0];
    if (!/\d/.test(value)) return null;
    if (!/^\d[\d,.]*$/.test(value)) return null;

    var lastComma = value.lastIndexOf(',');
    var lastDot = value.lastIndexOf('.');
    var normalized;

    if (lastComma !== -1 && lastDot !== -1) {
      if (lastComma > lastDot) {
        // 1.299,00 (European)
        normalized = value.replace(/\./g, '').replace(',', '.');
      } else {
        // 1,299.00 (Indian / Western)
        normalized = value.replace(/,/g, '');
      }
    } else if (lastComma !== -1) {
      var commaParts = value.split(',');
      if (commaParts.length > 2) {
        // 1,25,999 -> grouping
        normalized = value.replace(/,/g, '');
      } else {
        var afterComma = commaParts[1] || '';
        // A single comma followed by 1 or 2 digits is treated as a decimal
        // only when the integer part is not a normal 1-3 digit group.
        if (afterComma.length > 0 && afterComma.length <= 2 && commaParts[0].length > 3) {
          normalized = commaParts[0] + '.' + afterComma;
        } else {
          normalized = value.replace(/,/g, '');
        }
      }
    } else if (lastDot !== -1) {
      var dotParts = value.split('.');
      if (dotParts.length > 2) {
        // 1.299.000 -> grouping dots
        var tail = dotParts.pop();
        normalized = dotParts.join('') + (tail.length <= 2 ? '.' + tail : tail);
      } else {
        var afterDot = dotParts[1] || '';
        if (afterDot.length > 0 && afterDot.length <= 2) normalized = value;
        else if (afterDot.length === 3 && dotParts[0].length <= 3) normalized = dotParts.join('');
        else normalized = value.replace(/\./g, '');
      }
    } else {
      normalized = value;
    }

    if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
      // Trim extra decimal places instead of rejecting an otherwise valid price.
      normalized = normalized.replace(/^(\d+)(?:\.(\d{1,2})\d*)$/, '$1.$2');
    }
    if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;

    var number = Number(normalized);
    if (!Number.isFinite(number) || number < 0 || number > MAX_PRICE) return null;
    return Math.round(number * 100) / 100;
  }

  function rejectionContext(text) {
    var value = ' ' + cleanText(text).toLowerCase() + ' ';
    var blocked = [
      '%', 'percent off', ' off ', 'discount', 'you save', 'save ₹', 'save rs', 'save inr',
      'coupon', 'cashback', 'cash back', 'bank offer', 'exchange offer', 'delivery', 'shipping',
      'shipping fee', 'delivery fee', 'tax', 'emi', 'e.m.i', 'per month', '/month', 'per month',
      'monthly', 'a month', 'installment', 'instalment', 'down payment', 'booking amount',
      'gst', 'fee', 'charges', 'mrp', 'm.r.p', 'list price', 'was price', 'strike'
    ];
    for (var i = 0; i < blocked.length; i++) {
      if (value.indexOf(blocked[i]) !== -1) return true;
    }
    return false;
  }

  function isRecurringContext(text) {
    var value = ' ' + cleanText(text).toLowerCase() + ' ';
    return /(\bemi\b|e\.m\.i|\/\s*month|\bper month\b|\bmonthly\b|\ba month\b|installment|instalment)/i.test(value);
  }

  function parse(text, options) {
    var opts = options || {};
    var value = cleanText(text);
    if (!value || !/\d/.test(value)) return null;

    var currency = detectCurrency(value);
    var amountText = '';
    var rawMatch = '';
    var trusted = opts.trustedContext === true;

    if (currency) {
      var best = null;
      var regexes = freshCurrencyRegexes();
      for (var r = 0; r < regexes.length; r++) {
        var re = regexes[r];
        re.lastIndex = 0;
        var m = re.exec(value);
        if (m && (!best || m.index < best.index || (m.index === best.index && m[0].length < best.raw.length))) {
          best = { index: m.index, raw: m[0] };
        }
      }
      if (!best) return null;
      rawMatch = best.raw;
      amountText = stripCurrency(rawMatch);
      var matchCurrency = detectCurrency(rawMatch);
      if (matchCurrency) currency = matchCurrency;
    } else {
      if (!opts.allowBare) return null;
      // A bare number is only accepted from a trusted numeric field or a
      // dedicated price element. Percentages are never prices.
      if (/%/.test(value)) return null;
      var bare = value.match(/\d[\d,.]*\d|\d/);
      if (!bare) return null;
      amountText = bare[0];
      rawMatch = bare[0];
    }

    if (!currency) currency = opts.defaultCurrency || 'INR';
    var amount = normalizeNumber(amountText);
    if (amount === null || amount <= 0) return null;

    if (!trusted && opts.rejectRecurring !== false && isRecurringContext(value)) return null;
    if (!trusted && opts.rejectContext !== false && rejectionContext(value)) return null;

    return {
      value: amount,
      currency: currency,
      raw: cleanText(rawMatch),
      symbol: SYMBOLS[currency] || (currency || 'INR') + ' '
    };
  }

  /**
   * Returns every currency-marked price mention with the surrounding text.
   * Used by the generic fallback, never as the primary strategy.
   */
  function extractMentions(text, options) {
    var opts = options || {};
    var value = cleanText(text);
    if (!value) return [];
    var results = [];
    var seen = {};
    var regexes = freshCurrencyRegexes();
    for (var r = 0; r < regexes.length; r++) {
      var re = regexes[r];
      re.lastIndex = 0;
      var match;
      while ((match = re.exec(value)) !== null) {
        if (match[0].length > 40) continue;
        var parsed = parse(match[0], { defaultCurrency: opts.defaultCurrency || 'INR', rejectContext: false, allowBare: false });
        if (!parsed) continue;
        var key = parsed.value + '|' + parsed.currency;
        if (seen[key]) continue;
        seen[key] = true;
        var start = Math.max(0, match.index - 45);
        var end = Math.min(value.length, match.index + match[0].length + 45);
        results.push({
          value: parsed.value,
          currency: parsed.currency,
          raw: match[0],
          context: value.slice(start, end),
          index: match.index
        });
        if (results.length >= (opts.maxCandidates || 12)) return results;
      }
    }
    return results;
  }

  function isPlausible(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_PRICE;
  }

  function round(value) {
    if (!Number.isFinite(Number(value))) return null;
    return Math.round(Number(value) * 100) / 100;
  }

  function currencySymbol(currency) {
    return SYMBOLS[currency] || (currency || 'INR') + ' ';
  }

  function formatPrice(value, currency, options) {
    var opts = options || {};
    var amount = Number(value);
    var code = currency || 'INR';
    if (!Number.isFinite(amount)) return '—';
    var useCode = opts.currencyDisplay === 'code';
    try {
      return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: code,
        currencyDisplay: useCode ? 'code' : 'symbol',
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
      }).format(amount);
    } catch (_) {
      var rounded = Math.round(amount * 100) / 100;
      var formatted = new Intl.NumberFormat('en-IN', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
      }).format(rounded);
      return useCode ? code + ' ' + formatted : currencySymbol(code) + formatted;
    }
  }

  function formatCompact(value, currency) {
    var amount = Number(value);
    var code = currency || 'INR';
    if (!Number.isFinite(amount)) return '—';
    try {
      return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: code,
        currencyDisplay: 'narrowSymbol',
        notation: 'compact',
        maximumFractionDigits: 1,
        minimumFractionDigits: 0
      }).format(amount);
    } catch (_) {
      if (amount >= 10000000) return currencySymbol(code) + (amount / 10000000).toFixed(1).replace(/\.0$/, '') + 'Cr';
      if (amount >= 100000) return currencySymbol(code) + (amount / 100000).toFixed(1).replace(/\.0$/, '') + 'L';
      if (amount >= 1000) return currencySymbol(code) + (amount / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
      return formatPrice(amount, code);
    }
  }

  function discountPercent(original, current) {
    var o = Number(original);
    var c = Number(current);
    if (!Number.isFinite(o) || !Number.isFinite(c) || o <= 0 || c <= 0 || c >= o) return 0;
    return Math.round(((o - c) / o) * 100);
  }

  function percentChange(previous, current) {
    var p = Number(previous);
    var c = Number(current);
    if (!Number.isFinite(p) || !Number.isFinite(c) || p <= 0) return 0;
    return Math.round(((c - p) / p) * 10000) / 100;
  }

  root.SPT = root.SPT || {};
  root.SPT.PriceParser = {
    MAX_PRICE: MAX_PRICE,
    cleanText: cleanText,
    detectCurrency: detectCurrency,
    normalizeNumber: normalizeNumber,
    parse: parse,
    extractMentions: extractMentions,
    rejectionContext: rejectionContext,
    isRecurringContext: isRecurringContext,
    isPlausible: isPlausible,
    round: round,
    currencySymbol: currencySymbol,
    formatPrice: formatPrice,
    formatCompact: formatCompact,
    discountPercent: discountPercent,
    percentChange: percentChange
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
