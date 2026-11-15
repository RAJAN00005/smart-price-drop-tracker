/**
 * Product schema, price-history rules, statistics and backup validation.
 * Pure logic only — no Chrome APIs in this file.
 */
(function (root) {
  'use strict';

  var V = root.SPT.Validation;
  var D = root.SPT.DateUtils;
  var P = root.SPT.PriceParser;
  var U = root.SPT.UrlUtils;
  var C = root.SPT.SiteCatalog;

  var SCHEMA_VERSION = 1;
  var PRODUCT_ID_RE = /^[A-Za-z0-9_-]{2,100}$/;

  var DEFAULT_SETTINGS = {
    schemaVersion: 1,
    defaultFrequency: 12,
    notificationsEnabled: true,
    priceDropNotifications: true,
    targetNotifications: true,
    theme: 'system',
    currencyDisplay: 'symbol',
    maxConcurrentChecks: 2
  };

  function defaultSettings() {
    return V.sanitizeSettings(DEFAULT_SETTINGS);
  }

  function invalid(code) {
    throw new V.AppError(code);
  }

  function sanitizeHistoryEntry(raw) {
    if (!V.isPlainObject(raw)) return null;
    var price = V.asPrice(raw.price);
    var date = V.asIso(raw.date);
    if (price === null || !date) return null;
    var source = ['auto', 'manual', 'initial', 'import', 'confirmed', 'popup', 'dashboard'].indexOf(raw.source) !== -1
      ? raw.source
      : 'auto';
    return { price: price, date: date, source: source };
  }

  function dedupeHistory(entries) {
    var out = [];
    var seen = new Set();
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var key = entry.date + '|' + entry.price;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
    return out;
  }

  function trimHistory(history, limit) {
    var max = limit || V.LIMITS.MAX_HISTORY;
    if (history.length <= max) return history;
    // Preserve the very first observation plus the most recent observations.
    // Recent data powers the 7/30/90-day charts and must never be truncated.
    var head = history.slice(0, 1);
    var tail = history.slice(-(max - 1));
    return head.concat(tail);
  }

  function sanitizeHistory(raw, currentPrice, seededDate) {
    var items = Array.isArray(raw) ? raw : [];
    var entries = [];
    for (var i = 0; i < items.length; i++) {
      var entry = sanitizeHistoryEntry(items[i]);
      if (entry) entries.push(entry);
    }
    entries.sort(function (a, b) {
      var am = D.parseDate(a.date);
      var bm = D.parseDate(b.date);
      return (am || 0) - (bm || 0);
    });
    entries = dedupeHistory(entries);
    if (entries.length === 0) {
      if (currentPrice === null) return [];
      entries.push({
        price: currentPrice,
        date: seededDate || D.nowIso(),
        source: 'initial'
      });
    }
    var last = entries[entries.length - 1];
    if (currentPrice !== null && last.price !== currentPrice) {
      entries.push({
        price: currentPrice,
        date: seededDate || last.date || D.nowIso(),
        source: 'import'
      });
    }
    return trimHistory(entries);
  }

  function statsFromHistory(history, fallbackPrice) {
    var items = Array.isArray(history) ? history : [];
    var total = 0;
    var count = 0;
    var lowest = null;
    var highest = null;
    var drops = 0;
    var previousChange = null;
    var current = Number.isFinite(Number(fallbackPrice)) ? Number(fallbackPrice) : null;
    for (var i = 0; i < items.length; i++) {
      var price = Number(items[i].price);
      if (!Number.isFinite(price) || price <= 0) continue;
      total += price;
      count++;
      if (lowest === null || price < lowest) lowest = price;
      if (highest === null || price > highest) highest = price;
      if (i > 0) {
        var prev = Number(items[i - 1].price);
        if (Number.isFinite(prev) && price < prev) drops++;
      }
    }
    for (var j = items.length - 1; j >= 0; j--) {
      var candidate = Number(items[j].price);
      if (current === null || candidate !== current) {
        previousChange = candidate;
        break;
      }
    }
    return {
      lowestPrice: lowest !== null ? P.round(lowest) : current,
      highestPrice: highest !== null ? P.round(highest) : current,
      averagePrice: count ? P.round(total / count) : current,
      totalDrops: drops,
      previousPrice: previousChange !== null && Number.isFinite(previousChange) ? P.round(previousChange) : null,
      points: count,
      firstPriceDate: count ? items[0].date : null,
      lastPriceDate: count ? items[items.length - 1].date : null
    };
  }

  function recomputeStats(product) {
    var stats = statsFromHistory(product.priceHistory, product.currentPrice);
    product.lowestPrice = stats.lowestPrice;
    product.highestPrice = stats.highestPrice;
    product.averagePrice = stats.averagePrice;
    product.totalDrops = stats.totalDrops;
    product.previousPrice = stats.previousPrice;
    return stats;
  }

  function validId(value) {
    return typeof value === 'string' && PRODUCT_ID_RE.test(value);
  }

  function sanitizeErrorInfo(raw) {
    if (!V.isPlainObject(raw) || !raw.code) return null;
    var info = V.asErrorInfo({ code: raw.code, details: raw.detail }, raw.code);
    info.at = V.asIso(raw.at, D.nowIso());
    return info;
  }

  function sanitizeExtractionInfo(raw) {
    if (!V.isPlainObject(raw)) return null;
    var candidates = [];
    if (Array.isArray(raw.candidates)) {
      for (var i = 0; i < raw.candidates.length && candidates.length < 6; i++) {
        var c = raw.candidates[i];
        if (!V.isPlainObject(c)) continue;
        var price = V.asPrice(c.price);
        if (price === null) continue;
        candidates.push({
          price: price,
          source: V.cleanText(c.source || '', 80),
          confidence: Number.isFinite(Number(c.confidence)) ? Math.min(1, Math.max(0, Number(c.confidence))) : 0,
          currency: V.normalizeCurrency(c.currency, 'INR')
        });
      }
    }
    return {
      source: V.cleanText(raw.source || '', 100),
      confidence: Number.isFinite(Number(raw.confidence)) ? Math.min(1, Math.max(0, Number(raw.confidence))) : 0,
      needsConfirmation: raw.needsConfirmation === true,
      at: V.asIso(raw.at, D.nowIso()),
      candidates: candidates
    };
  }

  /**
   * Normalizes any product-like object into the canonical stored shape.
   * Unknown fields are deliberately dropped.
   */
  function sanitizeProduct(raw, options) {
    var opts = options || {};
    if (!V.isPlainObject(raw)) invalid('VALIDATION_ERROR');

    var now = D.nowIso();
    var url = U.cleanUrl(raw.url || raw.productUrl);
    if (!url) invalid('INVALID_URL');

    var title = V.cleanText(raw.title || raw.name, V.LIMITS.MAX_TITLE);
    if (!title) invalid('TITLE_NOT_FOUND');

    var currentPrice = V.asPrice(raw.currentPrice !== undefined ? raw.currentPrice : raw.price);
    if (currentPrice === null) invalid('INVALID_PRICE');

    var detected = C.detect(url) || { id: 'generic', name: 'Online store', currency: 'INR' };
    var storeId = typeof raw.storeId === 'string' && raw.storeId ? raw.storeId : detected.id;
    var storeName = V.cleanText(raw.store || raw.storeName || detected.name, 120) || detected.name;
    var currency = V.normalizeCurrency(raw.currency, detected.currency || 'INR');

    var createdAt = V.asIso(raw.createdAt, null) || V.asIso(raw.lastChecked, null) || now;
    var lastChecked = V.asIso(raw.lastChecked, null);
    var lastCheckAttempt = V.asIso(raw.lastCheckAttempt, null) || lastChecked;
    var firstHistory = Array.isArray(raw.priceHistory) && raw.priceHistory.length ? V.asIso(raw.priceHistory[0].date, null) : null;
    var history = sanitizeHistory(raw.priceHistory || raw.price_history, currentPrice, lastChecked || createdAt || firstHistory || now);

    var targetPrice = V.asTargetPrice(raw.targetPrice);
    var originalPrice = V.asPrice(raw.originalPrice !== undefined ? raw.originalPrice : raw.mrp);
    if (originalPrice !== null && originalPrice <= currentPrice) originalPrice = null;

    var trackingEnabled = V.asBoolean(raw.trackingEnabled, true);
    var monitoringEnabled = V.asBoolean(raw.monitoringEnabled, true);
    var notificationsEnabled = V.asBoolean(raw.notificationsEnabled, true);
    var checkFrequency = V.asFrequency(raw.checkFrequency, opts.defaultFrequency || 12);
    var checkStatus = V.asCheckStatus(raw.checkStatus, trackingEnabled ? 'idle' : 'paused');
    if (!trackingEnabled) checkStatus = 'paused';

    var stats = statsFromHistory(history, currentPrice);
    var externalId = V.cleanText(raw.externalId || '', 120);
    var id = validId(raw.id) ? raw.id : V.uid('p_');

    var product = {
      schemaVersion: SCHEMA_VERSION,
      id: id,
      title: title,
      image: V.safeUrl(raw.image || '', { image: true }),
      url: url,
      normalizedUrl: U.normalizedProductUrl(url) || U.cleanUrl(url),
      externalId: externalId,
      store: storeName,
      storeId: storeId,
      currency: currency,
      currentPrice: currentPrice,
      previousPrice: stats.previousPrice,
      originalPrice: originalPrice,
      targetPrice: targetPrice,
      lowestPrice: stats.lowestPrice,
      highestPrice: stats.highestPrice,
      averagePrice: stats.averagePrice,
      totalDrops: stats.totalDrops,
      availability: V.asAvailability(raw.availability),
      trackingEnabled: trackingEnabled,
      monitoringEnabled: monitoringEnabled,
      notificationsEnabled: notificationsEnabled,
      checkFrequency: checkFrequency,
      lastChecked: lastChecked,
      lastCheckAttempt: lastCheckAttempt,
      nextCheck: trackingEnabled ? V.asIso(raw.nextCheck, null) : null,
      checkStatus: checkStatus,
      lastError: checkStatus === 'ok' ? null : sanitizeErrorInfo(raw.lastError),
      consecutiveFailures: Math.max(0, Math.min(10000, Number(raw.consecutiveFailures) || 0)),
      lastExtractionSource: V.cleanText(raw.lastExtractionSource || '', 100),
      lastConfidence: Number.isFinite(Number(raw.lastConfidence)) ? Math.min(1, Math.max(0, Number(raw.lastConfidence))) : 0,
      lastExtraction: sanitizeExtractionInfo(raw.lastExtraction),
      lastNotifiedPrice: V.asPrice(raw.lastNotifiedPrice),
      targetNotified: V.asBoolean(raw.targetNotified, false),
      lastTargetNotifiedAt: V.asIso(raw.lastTargetNotifiedAt, null),
      lastDropAt: V.asIso(raw.lastDropAt, null),
      lastPriceChangeAt: V.asIso(raw.lastPriceChangeAt, null),
      createdAt: createdAt,
      updatedAt: V.asIso(raw.updatedAt, now) || now,
      priceHistory: history
    };

    if (!trackingEnabled) product.nextCheck = null;
    if (product.lastExtraction === null) {
      product.lastExtraction = {
        source: product.lastExtractionSource || '',
        confidence: product.lastConfidence || 0,
        needsConfirmation: false,
        at: lastCheckAttempt || createdAt,
        candidates: []
      };
    }
    return product;
  }

  function validateProduct(raw, options) {
    return sanitizeProduct(raw, options);
  }

  function createProduct(draft, settings) {
    var value = V.isPlainObject(draft) ? draft : {};
    var now = D.nowIso();
    var currentPrice = V.asPrice(value.currentPrice);
    if (currentPrice === null) invalid('INVALID_PRICE');
    var date = V.asIso(value.detectedAt, now) || now;
    var source = value.source === 'manual' ? 'manual' : 'initial';
    var uid = V.uid('p_');
    return sanitizeProduct({
      id: uid,
      title: value.title,
      image: value.image,
      url: value.url,
      externalId: value.externalId,
      store: value.store,
      storeId: value.storeId,
      currency: value.currency,
      currentPrice: currentPrice,
      originalPrice: value.originalPrice,
      targetPrice: value.targetPrice,
      targetNotified: false,
      trackingEnabled: value.trackingEnabled !== false,
      monitoringEnabled: value.monitoringEnabled !== false,
      notificationsEnabled: value.notificationsEnabled !== false,
      checkFrequency: value.checkFrequency || (settings && settings.defaultFrequency) || 12,
      availability: value.availability,
      lastChecked: date,
      lastCheckAttempt: date,
      nextCheck: null,
      checkStatus: 'ok',
      consecutiveFailures: 0,
      lastExtractionSource: V.cleanText(value.extractionSource || source, 100),
      lastConfidence: Number.isFinite(Number(value.confidence)) ? Number(value.confidence) : (source === 'manual' ? 1 : 0.9),
      lastExtraction: {
        source: value.extractionSource || source,
        confidence: Number.isFinite(Number(value.confidence)) ? Number(value.confidence) : (source === 'manual' ? 1 : 0.9),
        needsConfirmation: false,
        at: date,
        candidates: value.candidates || []
      },
      priceHistory: [{ price: currentPrice, date: date, source: source }],
      createdAt: now,
      updatedAt: now
    }, { defaultFrequency: (settings && settings.defaultFrequency) || 12 });
  }

  function applyPriceUpdate(product, newPrice, options) {
    var opts = options || {};
    var price = V.asPrice(newPrice);
    if (price === null) invalid('INVALID_PRICE');
    if (!product || !Array.isArray(product.priceHistory) || product.priceHistory.length === 0) {
      invalid('VALIDATION_ERROR');
    }
    var now = V.asIso(opts.at, D.nowIso()) || D.nowIso();
    var previous = Number(product.currentPrice);
    var changed = price !== previous;
    var isDrop = price < previous;

    product.priceHistory.push({
      price: price,
      date: now,
      source: opts.source || 'auto'
    });
    product.priceHistory = trimHistory(product.priceHistory);

    product.currentPrice = price;
    if (opts.originalPrice !== undefined) {
      var original = V.asPrice(opts.originalPrice);
      if (original !== null && original > price) product.originalPrice = original;
    }
    if (product.originalPrice !== null && product.originalPrice <= price) product.originalPrice = null;
    if (opts.currency) product.currency = V.normalizeCurrency(opts.currency, product.currency);
    if (opts.availability) product.availability = V.asAvailability(opts.availability);

    var stats = recomputeStats(product);
    product.lastChecked = now;
    product.lastCheckAttempt = now;
    product.checkStatus = 'ok';
    product.lastError = null;
    product.consecutiveFailures = 0;
    product.updatedAt = now;
    if (changed) product.lastPriceChangeAt = now;
    if (isDrop) product.lastDropAt = now;

    if (product.targetPrice && product.currentPrice > product.targetPrice) {
      product.targetNotified = false;
    }
    var targetDue = !!product.targetPrice && product.currentPrice <= product.targetPrice && !product.targetNotified;

    if (opts.extraction) {
      var extraction = sanitizeExtractionInfo(opts.extraction);
      if (extraction) {
        product.lastExtraction = extraction;
        product.lastExtractionSource = extraction.source;
        product.lastConfidence = extraction.confidence;
      }
    }

    return {
      price: price,
      previousPrice: previous,
      previousDistinctPrice: stats.previousPrice,
      changed: changed,
      isDrop: isDrop,
      dropAmount: isDrop ? P.round(previous - price) : 0,
      dropPercent: isDrop && previous > 0 ? Math.round(((previous - price) / previous) * 10000) / 100 : 0,
      originalPrice: product.originalPrice,
      targetPrice: product.targetPrice,
      targetDue: targetDue,
      lowestPrice: product.lowestPrice,
      highestPrice: product.highestPrice,
      averagePrice: product.averagePrice,
      totalDrops: product.totalDrops,
      availability: product.availability,
      date: now,
      source: opts.source || 'auto'
    };
  }

  function markNotificationSent(product, report, target) {
    if (!product || !report) return;
    product.lastNotifiedPrice = report.price;
    if (target) {
      product.targetNotified = true;
      product.lastTargetNotifiedAt = D.nowIso();
    }
    product.updatedAt = D.nowIso();
  }

  function markCheckFailure(product, error, options) {
    var opts = options || {};
    var now = D.nowIso();
    var info = V.asErrorInfo(error, error && error.code ? error.code : 'CHECK_FAILED');
    product.lastCheckAttempt = now;
    product.checkStatus = info.code === 'PERMISSION_REQUIRED' || info.code === 'PERMISSION_DENIED'
      ? 'permission-required'
      : 'failed';
    product.lastError = info;
    product.consecutiveFailures = Math.min(10000, (Number(product.consecutiveFailures) || 0) + 1);
    product.updatedAt = now;
    if (opts.nextCheck !== undefined) product.nextCheck = V.asIso(opts.nextCheck, null);
    if (opts.extraction) {
      var extraction = sanitizeExtractionInfo(opts.extraction);
      if (extraction) {
        product.lastExtraction = extraction;
        product.lastExtractionSource = extraction.source;
        product.lastConfidence = extraction.confidence;
      }
    }
    return info;
  }

  function setNextCheck(product, value) {
    product.nextCheck = V.asIso(value, null);
    return product.nextCheck;
  }

  function setTracking(product, enabled, nextCheck) {
    product.trackingEnabled = !!enabled;
    product.checkStatus = enabled ? (product.lastError ? product.checkStatus : 'idle') : 'paused';
    if (!enabled) {
      product.nextCheck = null;
    } else if (nextCheck !== undefined) {
      product.nextCheck = V.asIso(nextCheck, null);
    }
    product.updatedAt = D.nowIso();
    return product;
  }

  function setTarget(product, targetPrice) {
    var target = V.asTargetPrice(targetPrice);
    if (!target && targetPrice !== null && targetPrice !== '' && targetPrice !== undefined) invalid('INVALID_PRICE');
    product.targetPrice = target;
    product.targetNotified = false;
    product.lastTargetNotifiedAt = null;
    product.updatedAt = D.nowIso();
    return product;
  }

  function summary(products) {
    var list = Array.isArray(products) ? products : [];
    var totalTracked = list.length;
    var drops = 0;
    var atLowest = 0;
    var active = 0;
    var permissionNeeded = 0;
    var potentialSavings = 0;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.totalDrops > 0) drops++;
      if (Number.isFinite(p.currentPrice) && Number.isFinite(p.lowestPrice) && p.currentPrice <= p.lowestPrice) atLowest++;
      if (p.trackingEnabled) active++;
      if (p.trackingEnabled && p.monitoringEnabled && p.checkStatus === 'permission-required') permissionNeeded++;
      if (Number.isFinite(p.currentPrice) && Number.isFinite(p.highestPrice) && p.highestPrice > p.currentPrice) {
        potentialSavings += p.highestPrice - p.currentPrice;
      }
    }
    return {
      totalTracked: totalTracked,
      productsWithDrops: drops,
      atLowest: atLowest,
      active: active,
      permissionNeeded: permissionNeeded,
      potentialSavings: P.round(potentialSavings) || 0
    };
  }

  function validateBackup(raw) {
    var data = raw;
    if (V.isPlainObject(data) && V.isPlainObject(data.data) && !Array.isArray(data.products)) {
      data = data.data;
    }
    if (!V.isPlainObject(data) || !Array.isArray(data.products)) invalid('INVALID_IMPORT');
    if (data.products.length > V.LIMITS.MAX_PRODUCTS * 2) invalid('IMPORT_TOO_LARGE');
    var products = [];
    var skipped = 0;
    var errors = [];
    for (var i = 0; i < data.products.length; i++) {
      try {
        var product = sanitizeProduct(data.products[i]);
        products.push(product);
      } catch (error) {
        skipped++;
        if (errors.length < 10) {
          errors.push(V.userMessage(error, 'INVALID_IMPORT'));
        }
      }
    }
    if (products.length === 0) invalid('INVALID_IMPORT');
    if (products.length > V.LIMITS.MAX_PRODUCTS) invalid('IMPORT_TOO_LARGE');
    var settings = null;
    if (data.settings) {
      try { settings = V.validateSettings(data.settings); } catch (_) { settings = null; }
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      products: products,
      settings: settings,
      exportedAt: V.asIso(data.exportedAt, null),
      skipped: skipped,
      errors: errors
    };
  }

  function exportPayload(products, settings) {
    var cleanProducts = [];
    var list = Array.isArray(products) ? products : [];
    for (var i = 0; i < list.length && cleanProducts.length < V.LIMITS.MAX_EXPORT_PRODUCTS; i++) {
      try { cleanProducts.push(sanitizeProduct(list[i])); } catch (_) { /* skip corrupt record */ }
    }
    var payload = {
      app: 'Smart Price Drop Tracker',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: D.nowIso(),
      settings: V.sanitizeSettings(settings || defaultSettings()),
      products: cleanProducts
    };
    return payload;
  }

  function toCsv(products) {
    var headers = [
      'Product Name', 'Website', 'Current Price', 'Currency', 'Previous Price',
      'Lowest Price', 'Highest Price', 'Average Price', 'Target Price',
      'Last Checked', 'Next Check', 'Availability', 'Tracking Status', 'URL'
    ];
    var rows = [headers.map(V.escapeCsv).join(',')];
    var list = Array.isArray(products) ? products : [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      rows.push([
        p.title,
        p.store,
        p.currentPrice,
        p.currency,
        p.previousPrice === null ? '' : p.previousPrice,
        p.lowestPrice,
        p.highestPrice,
        p.averagePrice,
        p.targetPrice === null ? '' : p.targetPrice,
        p.lastChecked || '',
        p.nextCheck || '',
        p.availability || 'Unknown',
        p.trackingEnabled ? (p.monitoringEnabled ? 'Active' : 'Manual only') : 'Paused',
        p.url
      ].map(V.escapeCsv).join(','));
    }
    return rows.join('\r\n');
  }

  function migrateLegacyProduct(raw) {
    if (!V.isPlainObject(raw)) return null;
    var copy = JSON.parse(JSON.stringify(raw));
    if (copy.current_price !== undefined && copy.currentPrice === undefined) copy.currentPrice = copy.current_price;
    if (copy.price_history && !copy.priceHistory) copy.priceHistory = copy.price_history;
    if (copy.storeName && !copy.store) copy.store = copy.storeName;
    if (copy.mrp !== undefined && copy.originalPrice === undefined) copy.originalPrice = copy.mrp;
    if (copy.last_checked && !copy.lastChecked) copy.lastChecked = copy.last_checked;
    if (copy.next_check && !copy.nextCheck) copy.nextCheck = copy.next_check;
    if (copy.target_price !== undefined && copy.targetPrice === undefined) copy.targetPrice = copy.target_price;
    if (copy.tracking_enabled !== undefined && copy.trackingEnabled === undefined) copy.trackingEnabled = copy.tracking_enabled;
    try { return sanitizeProduct(copy); } catch (_) { return null; }
  }

  root.SPT = root.SPT || {};
  root.SPT.DataModel = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    defaultSettings: defaultSettings,
    sanitizeHistoryEntry: sanitizeHistoryEntry,
    sanitizeHistory: sanitizeHistory,
    trimHistory: trimHistory,
    statsFromHistory: statsFromHistory,
    recomputeStats: recomputeStats,
    sanitizeProduct: sanitizeProduct,
    validateProduct: validateProduct,
    createProduct: createProduct,
    applyPriceUpdate: applyPriceUpdate,
    markNotificationSent: markNotificationSent,
    markCheckFailure: markCheckFailure,
    setNextCheck: setNextCheck,
    setTracking: setTracking,
    setTarget: setTarget,
    summary: summary,
    validateBackup: validateBackup,
    exportPayload: exportPayload,
    toCsv: toCsv,
    migrateLegacyProduct: migrateLegacyProduct
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
