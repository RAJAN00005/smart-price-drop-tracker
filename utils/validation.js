/**
 * Shared validation, sanitization and user-facing error messages.
 */
(function (root) {
  'use strict';

  var LIMITS = {
    MAX_PRODUCTS: 500,
    MAX_HISTORY: 2000,
    MAX_TITLE: 300,
    MAX_URL: 4096,
    MAX_IMAGE_URL: 2048,
    MAX_ERROR: 300,
    MAX_IMPORT_BYTES: 15 * 1024 * 1024,
    MAX_EXPORT_PRODUCTS: 1000,
    ALLOWED_FREQUENCIES: [6, 12, 24],
    MAX_CONCURRENT_CHECKS: 4
  };

  var ERROR_MESSAGES = {
    UNKNOWN: 'Something went wrong. Please try again.',
    UNSUPPORTED_PAGE: 'This page cannot be tracked. Open a product page on a shopping website.',
    NOT_HTTP_PAGE: 'Only regular shopping web pages can be tracked.',
    NO_PRODUCT: 'No supported product detected. Try refreshing the page or open a supported product page.',
    PRICE_NOT_FOUND: "We couldn't find a reliable price on this page. You can enter the price manually.",
    TITLE_NOT_FOUND: "We couldn't detect the product name. You can enter it manually.",
    INVALID_PRICE: 'Enter a valid price greater than zero.',
    INVALID_URL: 'That product link is not valid.',
    BLOCKED: 'This website blocked automated access. Your last saved price was kept.',
    CAPTCHA: 'A security check (CAPTCHA) is showing on the product page. Your last saved price was kept.',
    PERMISSION_REQUIRED: 'Site access is needed for automatic price checks. Manual updates still work.',
    PERMISSION_DENIED: 'Permission was not granted. Manual price updates are still available.',
    NETWORK: 'The product page could not be reached. Check your connection and try again.',
    LOW_CONFIDENCE: 'The detected price was not reliable enough to save automatically. Please confirm it manually.',
    DUPLICATE: 'This product is already being tracked.',
    STORAGE_ERROR: 'Chrome storage is unavailable right now. Please try again.',
    STORAGE_FULL: 'Chrome storage is full. Export a backup and remove products you no longer need.',
    INVALID_IMPORT: 'This backup file is not valid or contains unsupported data.',
    IMPORT_TOO_LARGE: 'This backup file is too large to import.',
    PRODUCT_NOT_FOUND: 'That tracked product no longer exists.',
    INVALID_SETTINGS: 'Some settings were invalid and were not saved.',
    CHECK_FAILED: 'The price check failed. Your last saved price was kept.',
    EXTRACTION_ERROR: 'The page could not be read. Your last saved price was kept.',
    INJECTION_FAILED: 'The page could not be read. Try refreshing it and try again.',
    SCRIPTING_BLOCKED: 'Chrome does not allow this page to be read. Try a normal product page.',
    ALARM_ERROR: 'Automatic checks could not be scheduled. Try again.',
    NOTIFICATION_ERROR: 'The price was saved, but a notification could not be shown.',
    VALIDATION_ERROR: 'Some of the information was invalid and was not saved.',
    PRODUCT_LIMIT: 'You have reached the maximum number of tracked products.',
    OUT_OF_STOCK: 'This product is currently out of stock.'
  };

  var VALID_FREQUENCIES = [6, 12, 24];
  var CHECK_STATUSES = ['ok', 'failed', 'permission-required', 'paused', 'idle'];
  var AVAILABILITIES = ['InStock', 'OutOfStock', 'PreOrder', 'BackOrder', 'Discontinued', 'Unknown'];
  var THEMES = ['system', 'light', 'dark'];
  var CURRENCY_DISPLAYS = ['symbol', 'code'];

  function AppError(code, message, details) {
    this.name = 'AppError';
    this.code = code || 'UNKNOWN';
    this.message = message || ERROR_MESSAGES[this.code] || ERROR_MESSAGES.UNKNOWN;
    this.details = details || null;
    if (Error.captureStackTrace) Error.captureStackTrace(this, AppError);
  }
  AppError.prototype = Object.create(Error.prototype);
  AppError.prototype.constructor = AppError;

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function cleanText(value, maxLength, options) {
    if (value === null || value === undefined) return '';
    var text = String(value)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
      .replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g, '');
    if (options && options.multiline) {
      text = text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ');
    } else {
      text = text.replace(/\s+/g, ' ');
    }
    text = text.trim();
    var limit = maxLength || LIMITS.MAX_TITLE;
    return text.length > limit ? text.slice(0, limit).trim() : text;
  }

  function asNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      var parser = root.SPT && root.SPT.PriceParser;
      if (parser) {
        var normalized = parser.normalizeNumber(value);
        if (normalized !== null) return normalized;
      }
      var cleaned = value.replace(/[^0-9.-]/g, '');
      if (!cleaned || cleaned === '-' || cleaned === '.') return null;
      var parsed = Number(cleaned);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function asPrice(value, options) {
    var opts = options || {};
    // A leading minus is a negative amount, never a valid price. normalizeNumber
    // strips signs, so reject it before numeric normalization can hide it.
    if (typeof value === 'string' && /^\s*-/.test(value)) return null;
    var number = asNumber(value);
    if (number === null || !Number.isFinite(number) || number <= 0) return null;
    if (number > 1000000000) return null;
    number = Math.round(number * 100) / 100;
    if (opts.min && number < opts.min) return null;
    return number;
  }

  function asTargetPrice(value) {
    if (value === null || value === undefined || value === '') return null;
    var price = asPrice(value);
    return price;
  }

  function asBoolean(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1) return true;
    if (value === 'false' || value === 0) return false;
    return fallback === undefined ? false : fallback;
  }

  function asIso(value, fallback) {
    var dateUtils = root.SPT && root.SPT.DateUtils;
    var iso = null;
    if (dateUtils) {
      iso = dateUtils.toIso(value);
    } else if (value !== null && value !== undefined && value !== '') {
      var ms = typeof value === 'number' ? value : Date.parse(String(value));
      if (Number.isFinite(ms)) iso = new Date(ms).toISOString();
    }
    return iso || fallback || null;
  }

  function asFrequency(value, fallback) {
    var number = Number(value);
    if (VALID_FREQUENCIES.indexOf(number) !== -1) return number;
    return fallback || 12;
  }

  function asCheckStatus(value, fallback) {
    return CHECK_STATUSES.indexOf(value) !== -1 ? value : (fallback || 'idle');
  }

  function asAvailability(value) {
    if (!value) return 'Unknown';
    var normalized = String(value);
    if (normalized.indexOf('schema.org/') !== -1) {
      var tail = normalized.split('/').pop();
      normalized = tail.charAt(0).toUpperCase() + tail.slice(1);
    }
    var lower = normalized.toLowerCase().replace(/[^a-z]/g, '');
    if (lower === 'instock' || lower === 'available' || lower === 'yes') return 'InStock';
    if (lower === 'outofstock' || lower === 'soldout' || lower === 'unavailable' || lower === 'no') return 'OutOfStock';
    if (lower === 'preorder' || lower === 'presale') return 'PreOrder';
    if (lower === 'backorder' || lower === 'backordered') return 'BackOrder';
    if (lower === 'discontinued') return 'Discontinued';
    return AVAILABILITIES.indexOf(normalized) !== -1 ? normalized : 'Unknown';
  }

  function normalizeCurrency(value, fallback) {
    var code = cleanText(value || '', 8).toUpperCase();
    return /^[A-Z]{3}$/.test(code) ? code : (fallback || 'INR');
  }

  function safeUrl(value, options) {
    var utils = root.SPT && root.SPT.UrlUtils;
    var opts = options || {};
    if (utils) {
      return opts.image ? utils.safeImageUrl(value) : utils.cleanUrl(value);
    }
    if (typeof value !== 'string') return '';
    return /^https?:\/\//i.test(value.trim()) ? value.trim().slice(0, opts.image ? LIMITS.MAX_IMAGE_URL : LIMITS.MAX_URL) : '';
  }

  function uid(prefix) {
    var random;
    try {
      random = crypto.randomUUID();
    } catch (_) {
      random = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
    return (prefix || 'p_') + random;
  }

  function asErrorInfo(error, fallbackCode) {
    var code = fallbackCode || 'UNKNOWN';
    var details = '';
    if (error && typeof error === 'object') {
      if (typeof error.code === 'string' && ERROR_MESSAGES[error.code]) code = error.code;
      details = error.details || error.detail || error.stack || error.message || '';
    } else if (typeof error === 'string') {
      details = error;
    }
    return {
      code: code,
      message: ERROR_MESSAGES[code] || ERROR_MESSAGES.UNKNOWN,
      detail: cleanText(details, 500),
      at: new Date().toISOString()
    };
  }

  function userMessage(error, fallbackCode) {
    if (!error) return ERROR_MESSAGES[fallbackCode || 'UNKNOWN'] || ERROR_MESSAGES.UNKNOWN;
    if (typeof error === 'string') return ERROR_MESSAGES[error] || error;
    if (ERROR_MESSAGES[error.code]) return ERROR_MESSAGES[error.code];
    return error.message && typeof error.message === 'string' && error.message.length <= 300
      ? error.message
      : ERROR_MESSAGES[fallbackCode || 'UNKNOWN'];
  }

  function sanitizeSettings(raw) {
    var value = isPlainObject(raw) ? raw : {};
    return {
      schemaVersion: 1,
      defaultFrequency: asFrequency(value.defaultFrequency, 12),
      notificationsEnabled: asBoolean(value.notificationsEnabled, true),
      priceDropNotifications: asBoolean(value.priceDropNotifications, true),
      targetNotifications: asBoolean(value.targetNotifications, true),
      theme: THEMES.indexOf(value.theme) !== -1 ? value.theme : 'system',
      currencyDisplay: CURRENCY_DISPLAYS.indexOf(value.currencyDisplay) !== -1 ? value.currencyDisplay : 'symbol',
      maxConcurrentChecks: Math.min(LIMITS.MAX_CONCURRENT_CHECKS, Math.max(1, Number(value.maxConcurrentChecks) || 2)),
      updatedAt: asIso(value.updatedAt, new Date().toISOString())
    };
  }

  function validateSettings(raw) {
    if (!isPlainObject(raw)) throw new AppError('INVALID_SETTINGS');
    return sanitizeSettings(raw);
  }

  function escapeCsv(value) {
    if (value === null || value === undefined) return '';
    var text = String(value);
    // Prevent spreadsheet formula injection for user-controlled text fields.
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    if (/[",\r\n]/.test(text)) text = '"' + text.replace(/"/g, '""') + '"';
    return text;
  }

  function formatBytes(bytes) {
    var number = Number(bytes);
    if (!Number.isFinite(number) || number < 0) return '0 B';
    if (number < 1024) return Math.round(number) + ' B';
    if (number < 1024 * 1024) return (number / 1024).toFixed(1) + ' KB';
    return (number / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function approxBytes(value) {
    try {
      return new TextEncoder().encode(JSON.stringify(value)).length;
    } catch (_) {
      return 0;
    }
  }

  root.SPT = root.SPT || {};
  root.SPT.Validation = {
    LIMITS: LIMITS,
    ERROR_MESSAGES: ERROR_MESSAGES,
    AppError: AppError,
    isPlainObject: isPlainObject,
    cleanText: cleanText,
    asNumber: asNumber,
    asPrice: asPrice,
    asTargetPrice: asTargetPrice,
    asBoolean: asBoolean,
    asIso: asIso,
    asFrequency: asFrequency,
    asCheckStatus: asCheckStatus,
    asAvailability: asAvailability,
    normalizeCurrency: normalizeCurrency,
    safeUrl: safeUrl,
    uid: uid,
    asErrorInfo: asErrorInfo,
    userMessage: userMessage,
    sanitizeSettings: sanitizeSettings,
    validateSettings: validateSettings,
    escapeCsv: escapeCsv,
    formatBytes: formatBytes,
    approxBytes: approxBytes,
    VALID_FREQUENCIES: VALID_FREQUENCIES,
    CHECK_STATUSES: CHECK_STATUSES,
    AVAILABILITIES: AVAILABILITIES,
    THEMES: THEMES,
    CURRENCY_DISPLAYS: CURRENCY_DISPLAYS
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
