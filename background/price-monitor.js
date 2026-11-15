/**
 * Automatic and manual price checking.
 *
 * Checks fetch and parse the product page in an offscreen document, so no
 * browser tabs are created. The read-only extractor runs against the parsed
 * HTML, then history/statistics are updated and the next check is scheduled.
 * A small queue bounds concurrency.
 */
(function (root) {
  'use strict';

  var V = root.SPT.Validation;
  var D = root.SPT.DateUtils;
  var DM = root.SPT.DataModel;
  var Storage = root.SPT.StorageManager;
  var Alarm = root.SPT.AlarmManager;
  var Notifications = root.SPT.NotificationManager;
  var Client = root.SPT.ExtractionClient;

  var OFFSCREEN_TIMEOUT_MS = 30000;
  var KEEPALIVE_MS = 20000;

  var queue = [];
  var pending = new Map();
  var active = 0;
  var pumping = false;
  var keepAliveTimer = null;

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function keepAliveTick() {
    try {
      chrome.runtime.getPlatformInfo(function () { /* resets the service worker idle timer */ });
    } catch (_) { /* ignore */ }
  }

  function startKeepAlive() {
    if (keepAliveTimer) return;
    keepAliveTick();
    keepAliveTimer = setInterval(keepAliveTick, KEEPALIVE_MS);
  }

  function stopKeepAlive() {
    if (!keepAliveTimer) return;
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  function withTimeout(promise, ms, code) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new V.AppError(code || 'EXTRACTION_ERROR'));
      }, ms);
      promise.then(function (value) {
        clearTimeout(timer);
        resolve(value);
      }, function (error) {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  var offscreenCreating = null;

  async function ensureOffscreenDocument() {
    if (!chrome.offscreen || typeof chrome.offscreen.createDocument !== 'function') {
      throw new V.AppError('EXTRACTION_ERROR', null, 'Offscreen price checks are not supported by this browser.');
    }
    var exists = false;
    try {
      exists = typeof chrome.offscreen.hasDocument === 'function' ? await chrome.offscreen.hasDocument() : false;
    } catch (_) { exists = false; }
    if (exists) return;
    if (!offscreenCreating) {
      offscreenCreating = chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: 'Fetch and parse product pages for scheduled price checks without opening browser tabs.'
      }).catch(function (error) {
        // Another context may have created it between the hasDocument check
        // and createDocument. That is harmless.
        if (!/already|single offscreen/i.test(String(error && error.message || error))) throw error;
      }).finally(function () { offscreenCreating = null; });
    }
    await offscreenCreating;
  }

  async function sendOffscreen(url) {
    var lastError = null;
    for (var attempt = 0; attempt < 6; attempt++) {
      try {
        var response = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_EXTRACT', url: url });
        if (response) return response;
      } catch (error) {
        lastError = error;
      }
      await sleep(150);
    }
    throw new V.AppError('EXTRACTION_ERROR', null,
      lastError && lastError.message ? String(lastError.message) : 'The offscreen price reader did not respond.');
  }

  async function extractFromOffscreen(product) {
    await ensureOffscreenDocument();
    var response = await sendOffscreen(product.url);
    if (!response.ok) {
      var code = response.error && response.error.code ? response.error.code : 'NETWORK';
      var message = response.error && response.error.message ? response.error.message : null;
      throw new V.AppError(code, message);
    }
    var data = response.data;
    if (!data) throw new V.AppError('EXTRACTION_ERROR');
    if (data.blocked) throw new V.AppError(data.error && data.error.code ? data.error.code : 'BLOCKED');
    if (!data.found || !data.price) throw new V.AppError('PRICE_NOT_FOUND');
    if (data.needsConfirmation) return { lowConfidence: true, data: data };
    return { lowConfidence: false, data: data };
  }

  function extractionInfo(data) {
    if (!data) return null;
    return {
      source: V.cleanText(data.source || '', 100),
      confidence: Number.isFinite(Number(data.confidence)) ? Number(data.confidence) : 0,
      needsConfirmation: !!data.needsConfirmation,
      at: D.nowIso(),
      candidates: Array.isArray(data.candidates) ? data.candidates.slice(0, 6) : []
    };
  }

  function nextCheckDate(product, permitted) {
    if (!product.trackingEnabled || !product.monitoringEnabled || !permitted) return null;
    return new Date(Date.now() + Alarm.frequencyMs(product)).toISOString();
  }

  async function scheduleAlarmFor(product) {
    var result;
    try {
      result = await Alarm.createFor(product);
    } catch (error) {
      return { scheduled: false, reason: 'alarm-error', error: V.asErrorInfo(error, 'ALARM_ERROR') };
    }
    if (!result.scheduled && result.reason === 'permission' && product.nextCheck) {
      try {
        var cleared = await Storage.updateProduct(product.id, function (p) {
          p.nextCheck = null;
          p.checkStatus = 'permission-required';
          if (!p.lastError) {
            p.lastError = {
              code: 'PERMISSION_REQUIRED',
              message: V.ERROR_MESSAGES.PERMISSION_REQUIRED,
              detail: '',
              at: D.nowIso()
            };
          }
          return true;
        });
        product = cleared.product;
      } catch (_) { /* ignore */ }
    }
    return { scheduled: result.scheduled, reason: result.reason, product: product, error: result.error };
  }

  async function markFailure(productId, error, options) {
    var opts = options || {};
    var source = opts.source || 'alarm';
    var isAuto = source === 'alarm';
    var info = V.asErrorInfo(error, error && error.code ? error.code : 'CHECK_FAILED');
    var update;
    try {
      update = await Storage.updateProduct(productId, function (product) {
        if (isAuto && (!product.trackingEnabled || !product.monitoringEnabled)) {
          product.nextCheck = null;
          return { skipped: true };
        }
        var scheduling = isAuto && info.code !== 'PERMISSION_REQUIRED' && info.code !== 'PERMISSION_DENIED';
        var next = isAuto
          ? (scheduling ? new Date(Date.now() + Alarm.frequencyMs(product)).toISOString() : null)
          : undefined;
        if (isAuto) product.nextCheck = next;
        var failure = DM.markCheckFailure(product, info, {
          nextCheck: isAuto ? next : undefined,
          extraction: opts.extraction || null
        });
        if (isAuto && next) product.nextCheck = next;
        return { failure: failure, skipped: false };
      });
    } catch (updateError) {
      return {
        ok: false,
        error: V.asErrorInfo(updateError, 'STORAGE_ERROR'),
        product: null,
        candidates: opts.data && opts.data.candidates ? opts.data.candidates : []
      };
    }

    if (update.result && update.result.skipped) {
      try { await Alarm.clearFor(productId); } catch (_) { /* ignore */ }
      return { ok: false, skipped: true, reason: 'paused', product: update.product };
    }

    if (isAuto) {
      if (update.product && update.product.nextCheck) {
        await scheduleAlarmFor(update.product);
      } else {
        try { await Alarm.clearFor(productId); } catch (_) { /* ignore */ }
      }
    }
    return {
      ok: false,
      error: info,
      product: update.product,
      extraction: opts.extraction || null,
      candidates: opts.data && opts.data.candidates ? opts.data.candidates : [],
      needsPermission: info.code === 'PERMISSION_REQUIRED' || info.code === 'PERMISSION_DENIED'
    };
  }

  async function notifyAndMark(product, report) {
    var notification;
    var finalProduct = product;
    var warnings = [];
    try {
      notification = await Notifications.notifyPriceChange(product, report);
    } catch (error) {
      notification = { shown: false, reason: 'exception', error: V.asErrorInfo(error, 'NOTIFICATION_ERROR') };
    }
    if (notification && notification.shown) {
      try {
        var updated = await Storage.updateProduct(product.id, function (p) {
          DM.markNotificationSent(p, report, notification.target);
        });
        finalProduct = updated.product;
      } catch (error) {
        warnings.push('The price was saved, but notification state could not be stored.');
        console.warn('[SPT] Could not persist notification state', error);
      }
    } else if (notification && notification.error) {
      warnings.push(V.ERROR_MESSAGES.NOTIFICATION_ERROR);
    }
    return { notification: notification, product: finalProduct, warnings: warnings };
  }

  async function runCheck(productId, source) {
    var product;
    try {
      product = await Storage.getProduct(productId);
    } catch (error) {
      return { ok: false, error: V.asErrorInfo(error, 'STORAGE_ERROR') };
    }
    if (!product) return { ok: false, error: V.asErrorInfo(new V.AppError('PRODUCT_NOT_FOUND')), product: null };

    var isAuto = source === 'alarm';
    if (isAuto && (!product.trackingEnabled || !product.monitoringEnabled)) {
      try {
        await Storage.updateProduct(productId, function (p) { p.nextCheck = null; });
        await Alarm.clearFor(productId);
      } catch (_) { /* ignore */ }
      return { ok: false, skipped: true, reason: 'paused', product: product };
    }

    var permitted = false;
    try { permitted = await Client.hasSitePermission(product.url); } catch (_) { permitted = false; }
    if (!permitted) {
      if (isAuto) {
        return markFailure(productId, new V.AppError('PERMISSION_REQUIRED'), { source: source });
      }
      return {
        ok: false,
        needsPermission: true,
        error: V.asErrorInfo(new V.AppError('PERMISSION_REQUIRED'), 'PERMISSION_REQUIRED'),
        product: product
      };
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return markFailure(productId, new V.AppError('NETWORK'), { source: source });
    }

    var extracted = null;
    var failure = null;
    try {
      extracted = await withTimeout(extractFromOffscreen(product), OFFSCREEN_TIMEOUT_MS, 'EXTRACTION_ERROR');
    } catch (error) {
      failure = error;
    }

    if (failure || !extracted) {
      var failureInfo = V.asErrorInfo(failure, failure && failure.code ? failure.code : 'CHECK_FAILED');
      return markFailure(productId, failureInfo, { source: source });
    }

    var data = extracted.data;
    var extraction = extractionInfo(data);

    if (extracted.lowConfidence) {
      return markFailure(productId, new V.AppError('LOW_CONFIDENCE'), {
        source: source,
        extraction: extraction,
        data: data
      });
    }

    var update;
    try {
      update = await Storage.updateProduct(productId, async function (current) {
        if (isAuto && (!current.trackingEnabled || !current.monitoringEnabled)) {
          current.nextCheck = null;
          return { skipped: true };
        }
        var refreshPermission = await Client.hasSitePermission(current.url);
        var next = nextCheckDate(current, refreshPermission);
        var report = DM.applyPriceUpdate(current, data.price, {
          source: isAuto ? 'auto' : 'manual',
          at: D.nowIso(),
          originalPrice: data.originalPrice,
          currency: data.currency,
          availability: data.availability,
          extraction: extraction
        });
        current.nextCheck = next;
        return { report: report, skipped: false };
      });
    } catch (error) {
      return {
        ok: false,
        error: V.asErrorInfo(error, 'STORAGE_ERROR'),
        candidates: data.candidates || []
      };
    }

    if (update.result && update.result.skipped) {
      try { await Alarm.clearFor(productId); } catch (_) { /* ignore */ }
      return { ok: false, skipped: true, reason: 'paused', product: update.product };
    }

    var report = update.result.report;
    var notified = await notifyAndMark(update.product, report);
    var finalProduct = notified.product;
    var alarm = await scheduleAlarmFor(finalProduct);
    if (alarm.product) finalProduct = alarm.product;

    return {
      ok: true,
      product: finalProduct,
      report: report,
      extraction: extraction,
      notification: notified.notification,
      warnings: notified.warnings,
      scheduled: alarm.scheduled,
      nextCheck: finalProduct.nextCheck,
      candidates: data.candidates || []
    };
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      var settings;
      try { settings = await Storage.getSettings(); } catch (_) { settings = { maxConcurrentChecks: 2 }; }
      var max = clamp(Number(settings.maxConcurrentChecks) || 2, 1, 4);
      while (active < max && queue.length) {
        var entry = queue.shift();
        active++;
        startKeepAlive();
        Promise.resolve(runCheck(entry.productId, entry.source))
          .then(function (result) { entry.resolve(result); }, function (error) {
            entry.resolve({ ok: false, error: V.asErrorInfo(error, 'CHECK_FAILED') });
          })
          .then(function () {
            active--;
            pending.delete(entry.productId);
            if (queue.length === 0 && active === 0) stopKeepAlive();
            setTimeout(pump, 0);
          });
      }
      if (queue.length === 0 && active === 0) stopKeepAlive();
    } finally {
      pumping = false;
    }
  }

  function enqueue(productId, options) {
    if (!productId) return Promise.reject(new V.AppError('PRODUCT_NOT_FOUND'));
    if (pending.has(productId)) return pending.get(productId).promise;
    var opts = options || {};
    var entry = {
      productId: productId,
      source: opts.source === 'alarm' ? 'alarm' : 'manual',
      resolve: null,
      reject: null,
      promise: null
    };
    entry.promise = new Promise(function (resolve, reject) {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    pending.set(productId, entry);
    queue.push(entry);
    startKeepAlive();
    setTimeout(pump, 0);
    return entry.promise;
  }

  /**
   * Saves a user-confirmed/manual price without opening a page. History is
   * appended, statistics recalculated, and notifications use the same
   * duplicate prevention rules.
   */
  async function recordManualPrice(productId, payload) {
    var data = payload || {};
    var price = V.asPrice(data.price);
    if (price === null) throw new V.AppError('INVALID_PRICE');
    var source = data.source === 'confirmed' ? 'confirmed' : 'manual';
    var product = await Storage.getProduct(productId);
    if (!product) throw new V.AppError('PRODUCT_NOT_FOUND');

    // Let an in-flight check for this product settle first.
    if (pending.has(productId)) {
      try { await pending.get(productId).promise; } catch (_) { /* ignore */ }
    }

    var permitted = false;
    try { permitted = await Client.hasSitePermission(product.url); } catch (_) { permitted = false; }

    var update;
    try {
      update = await Storage.updateProduct(productId, function (current) {
        var report = DM.applyPriceUpdate(current, price, {
          source: source,
          at: D.nowIso(),
          originalPrice: data.originalPrice,
          currency: current.currency,
          availability: current.availability,
          extraction: {
            source: V.cleanText(data.extractionSource || 'Manual price confirmation', 100),
            confidence: 1,
            needsConfirmation: false,
            at: D.nowIso(),
            candidates: []
          }
        });
        current.nextCheck = nextCheckDate(current, permitted);
        return report;
      });
    } catch (error) {
      throw new V.AppError(error && error.code ? error.code : 'STORAGE_ERROR', error && error.message, error && error.detail);
    }

    var notified = await notifyAndMark(update.product, update.result);
    var finalProduct = notified.product;
    var alarm = await scheduleAlarmFor(finalProduct);
    if (alarm.product) finalProduct = alarm.product;
    return {
      ok: true,
      product: finalProduct,
      report: update.result,
      notification: notified.notification,
      warnings: notified.warnings,
      scheduled: alarm.scheduled,
      nextCheck: finalProduct.nextCheck
    };
  }

  /** Removes temporary tabs left behind by older extension versions. */
  async function cleanupTempTabs() {
    var tabs = [];
    try { tabs = await Storage.getTempTabs(); } catch (_) { tabs = []; }
    for (var i = 0; i < tabs.length; i++) {
      var entry = tabs[i];
      if (!entry || !entry.tabId) continue;
      try { await chrome.tabs.remove(entry.tabId); } catch (_) { /* already gone */ }
    }
    try { await Storage.clearTempTabs(); } catch (_) { /* ignore */ }
  }

  function status() {
    return {
      active: active,
      queued: queue.length,
      pendingProducts: Array.from(pending.keys())
    };
  }

  root.SPT = root.SPT || {};
  root.SPT.PriceMonitor = {
    checkProduct: function (productId) { return enqueue(productId, { source: 'alarm' }); },
    manualUpdate: function (productId) { return enqueue(productId, { source: 'manual' }); },
    recordManualPrice: recordManualPrice,
    cleanupTempTabs: cleanupTempTabs,
    status: status
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
