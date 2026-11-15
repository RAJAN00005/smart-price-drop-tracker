/**
 * Manifest V3 service worker: lifecycle, alarm/notification listeners and the
 * trusted message API used by the popup and dashboard.
 */
(function () {
  'use strict';

  importScripts(
    chrome.runtime.getURL('utils/date-utils.js'),
    chrome.runtime.getURL('utils/price-parser.js'),
    chrome.runtime.getURL('utils/url-normalizer.js'),
    chrome.runtime.getURL('utils/validation.js'),
    chrome.runtime.getURL('utils/site-catalog.js'),
    chrome.runtime.getURL('storage/data-model.js'),
    chrome.runtime.getURL('storage/storage-manager.js'),
    chrome.runtime.getURL('extractors/extraction-client.js'),
    chrome.runtime.getURL('background/alarm-manager.js'),
    chrome.runtime.getURL('background/notification-manager.js'),
    chrome.runtime.getURL('background/price-monitor.js')
  );

  var V = self.SPT.Validation;
  var D = self.SPT.DateUtils;
  var U = self.SPT.UrlUtils;
  var Storage = self.SPT.StorageManager;
  var Alarm = self.SPT.AlarmManager;
  var Notifications = self.SPT.NotificationManager;
  var Monitor = self.SPT.PriceMonitor;
  var Client = self.SPT.ExtractionClient;
  var DataModel = self.SPT.DataModel;

  var bootPromise = (async function boot() {
    await Storage.init();
    try { await Monitor.cleanupTempTabs(); } catch (error) { console.warn('[SPT] Temp tab cleanup failed', error); }
  })();
  bootPromise.catch(function (error) {
    console.error('[SPT] Initialization failed', error);
  });

  async function fullInitialize() {
    await bootPromise;
    try {
      await Alarm.rebuildAll();
    } catch (error) {
      console.warn('[SPT] Alarm rebuild failed', error);
    }
  }

  function validSender(sender) {
    return !!sender && sender.id === chrome.runtime.id;
  }

  function ok(data) {
    return Object.assign({ ok: true }, data || {});
  }

  function fail(error, fallback) {
    var info = V.asErrorInfo(error, fallback || (error && error.code) || 'UNKNOWN');
    return {
      ok: false,
      error: { code: info.code, message: info.message }
    };
  }

  function requireId(message) {
    if (!message || typeof message.id !== 'string' || !message.id) throw new V.AppError('PRODUCT_NOT_FOUND');
    return message.id;
  }

  async function withProductScheduling(productId, options) {
    var scheduled = await Alarm.scheduleProductById(productId, options);
    return scheduled;
  }

  async function trackProduct(message) {
    var draft = message.product || message.draft;
    if (!draft || typeof draft !== 'object') throw new V.AppError('VALIDATION_ERROR');
    var settings = await Storage.getSettings();
    var targetProvided = message.targetPrice !== undefined && message.targetPrice !== null && message.targetPrice !== '';
    var targetPrice = targetProvided ? V.asTargetPrice(message.targetPrice) : null;
    if (targetProvided && targetPrice === null) throw new V.AppError('INVALID_PRICE');

    var frequency = message.checkFrequency !== undefined
      ? V.asFrequency(message.checkFrequency, settings.defaultFrequency)
      : settings.defaultFrequency;
    if (message.checkFrequency !== undefined && V.VALID_FREQUENCIES.indexOf(Number(message.checkFrequency)) === -1) {
      throw new V.AppError('INVALID_SETTINGS');
    }

    var productDraft = {
      title: draft.title,
      image: draft.image,
      url: draft.url,
      externalId: draft.externalId || U.externalIdFor(draft.url, draft.storeId || ''),
      store: draft.store,
      storeId: draft.storeId,
      currency: draft.currency,
      currentPrice: draft.currentPrice,
      originalPrice: draft.originalPrice,
      targetPrice: targetPrice,
      availability: draft.availability,
      trackingEnabled: message.trackingEnabled !== false,
      monitoringEnabled: message.monitoringEnabled !== false,
      notificationsEnabled: message.notificationsEnabled !== false,
      checkFrequency: frequency,
      confidence: draft.confidence,
      extractionSource: draft.extractionSource || draft.source || (message.manual ? 'Manual entry' : 'Page extraction'),
      candidates: Array.isArray(draft.candidates) ? draft.candidates.slice(0, 6) : [],
      source: message.manual ? 'manual' : 'initial'
    };

    var added = await Storage.addProduct(productDraft);
    if (added.duplicate) {
      return ok({
        duplicate: true,
        product: added.product,
        scheduled: false,
        warning: ''
      });
    }

    var scheduled = await withProductScheduling(added.product.id, { fromNow: true });
    var finalProduct = scheduled.product || await Storage.getProduct(added.product.id);
    var warning = '';
    if (finalProduct.monitoringEnabled && finalProduct.trackingEnabled && !scheduled.scheduled) {
      if (scheduled.reason === 'permission') warning = V.ERROR_MESSAGES.PERMISSION_REQUIRED;
      else if (scheduled.reason === 'alarm-error') warning = V.ERROR_MESSAGES.ALARM_ERROR;
    }
    return ok({
      duplicate: false,
      product: finalProduct,
      scheduled: !!scheduled.scheduled,
      nextCheck: finalProduct.nextCheck,
      warning: warning
    });
  }

  async function setTracking(message) {
    var id = requireId(message);
    var enabled = message.enabled === true;
    var update = await Storage.updateProduct(id, function (product) {
      product.trackingEnabled = enabled;
      product.checkStatus = enabled ? 'idle' : 'paused';
      if (enabled) product.lastError = null;
      if (!enabled) product.nextCheck = null;
      product.updatedAt = D.nowIso();
    });
    if (!enabled) {
      await Alarm.clearFor(id);
      return ok({ product: update.product });
    }
    var scheduled = await withProductScheduling(id, { fromNow: true });
    return ok({
      product: scheduled.product || update.product,
      scheduled: !!scheduled.scheduled,
      reason: scheduled.reason || '',
      warning: scheduled.reason === 'permission' ? V.ERROR_MESSAGES.PERMISSION_REQUIRED : ''
    });
  }

  async function setMonitoring(message) {
    var id = requireId(message);
    var enabled = message.enabled === true;
    var current = await Storage.getProduct(id);
    if (!current) throw new V.AppError('PRODUCT_NOT_FOUND');
    var permitted = enabled ? await Client.hasSitePermission(current.url) : false;

    var update = await Storage.updateProduct(id, function (product) {
      product.monitoringEnabled = enabled;
      if (!enabled) {
        product.nextCheck = null;
        if (product.checkStatus === 'permission-required') product.checkStatus = product.trackingEnabled ? 'idle' : 'paused';
        if (product.lastError && product.lastError.code === 'PERMISSION_REQUIRED') product.lastError = null;
      }
      product.updatedAt = D.nowIso();
    });

    if (!enabled) {
      await Alarm.clearFor(id);
      return ok({ product: update.product, scheduled: false, needsPermission: false });
    }

    if (!permitted) {
      var marked = await Storage.updateProduct(id, function (product) {
        product.nextCheck = null;
        product.checkStatus = 'permission-required';
        product.lastError = {
          code: 'PERMISSION_REQUIRED',
          message: V.ERROR_MESSAGES.PERMISSION_REQUIRED,
          detail: '',
          at: D.nowIso()
        };
        product.updatedAt = D.nowIso();
      });
      await Alarm.clearFor(id);
      return ok({
        product: marked.product,
        scheduled: false,
        needsPermission: true,
        warning: V.ERROR_MESSAGES.PERMISSION_REQUIRED
      });
    }

    var scheduled = await withProductScheduling(id, { fromNow: true });
    return ok({
      product: scheduled.product || update.product,
      scheduled: !!scheduled.scheduled,
      needsPermission: false,
      warning: scheduled.reason === 'permission' ? V.ERROR_MESSAGES.PERMISSION_REQUIRED : ''
    });
  }

  async function setFrequency(message) {
    var id = requireId(message);
    var frequency = Number(message.frequency);
    if (V.VALID_FREQUENCIES.indexOf(frequency) === -1) throw new V.AppError('INVALID_SETTINGS');
    var update = await Storage.updateProduct(id, function (product) {
      product.checkFrequency = frequency;
      product.nextCheck = null;
      product.updatedAt = D.nowIso();
    });
    var scheduled = await withProductScheduling(id, { fromNow: true });
    return ok({
      product: scheduled.product || update.product,
      scheduled: !!scheduled.scheduled,
      warning: scheduled.reason === 'permission' ? V.ERROR_MESSAGES.PERMISSION_REQUIRED : ''
    });
  }

  async function setTarget(message) {
    var id = requireId(message);
    var target = V.asTargetPrice(message.targetPrice);
    if (message.targetPrice !== null && message.targetPrice !== '' && message.targetPrice !== undefined && target === null) {
      throw new V.AppError('INVALID_PRICE');
    }
    var update = await Storage.updateProduct(id, function (product) {
      DataModel.setTarget(product, target);
    });
    return ok({ product: update.product });
  }

  async function setNotifications(message) {
    var id = requireId(message);
    var update = await Storage.updateProduct(id, function (product) {
      product.notificationsEnabled = message.enabled === true;
      product.updatedAt = D.nowIso();
    });
    return ok({ product: update.product });
  }

  async function removeProduct(message) {
    var id = requireId(message);
    await Alarm.clearFor(id);
    try {
      await new Promise(function (resolve) {
        chrome.notifications.clear(Notifications.notificationId(id), function () { resolve(); });
      });
    } catch (_) { /* ignore */ }
    var removed = await Storage.removeProduct(id);
    return ok({ removed: removed, id: id });
  }

  async function clearAllProducts() {
    await Alarm.clearAllCheckAlarms();
    var count = await Storage.clearProducts();
    try {
      var notifications = await new Promise(function (resolve, reject) {
        chrome.notifications.getAll(function (all) {
          var err = chrome.runtime.lastError;
          if (err) return reject(err);
          resolve(all || {});
        });
      });
      Object.keys(notifications).forEach(function (id) {
        if (id.indexOf(Notifications.ID_PREFIX) === 0) {
          chrome.notifications.clear(id, function () {});
        }
      });
    } catch (error) {
      console.warn('[SPT] Could not clear notifications', error);
    }
    return ok({ removed: count });
  }

  async function updateSettings(message) {
    if (!message.settings || typeof message.settings !== 'object') throw new V.AppError('INVALID_SETTINGS');
    var settings = await Storage.saveSettings(message.settings);
    return ok({ settings: settings });
  }

  async function importBackup(message) {
    if (!message.data || typeof message.data !== 'object') throw new V.AppError('INVALID_IMPORT');
    var approx = 0;
    try { approx = new TextEncoder().encode(JSON.stringify(message.data)).length; } catch (_) { approx = 0; }
    if (approx > V.LIMITS.MAX_IMPORT_BYTES) throw new V.AppError('IMPORT_TOO_LARGE');
    var result = await Storage.importBackup(message.data, {
      mode: message.mode === 'replace' ? 'replace' : 'merge',
      includeSettings: message.includeSettings === true
    });
    await Alarm.rebuildAll();
    return ok(result);
  }

  async function getStatus() {
    return ok({
      initialized: true,
      version: chrome.runtime.getManifest().version,
      monitor: Monitor.status(),
      storage: await Storage.getStorageInfo()
    });
  }

  async function handleMessage(message, sender) {
    if (!validSender(sender)) throw new V.AppError('UNKNOWN');
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      throw new V.AppError('UNKNOWN');
    }
    await bootPromise;
    switch (message.type) {
      case 'PING':
        return ok({ version: chrome.runtime.getManifest().version });
      case 'GET_STATUS':
        return getStatus();
      case 'TRACK_PRODUCT':
        return trackProduct(message);
      case 'GET_PRODUCT': {
        var product = await Storage.getProduct(requireId(message));
        if (!product) throw new V.AppError('PRODUCT_NOT_FOUND');
        return ok({ product: product });
      }
      case 'MANUAL_UPDATE':
        return Monitor.manualUpdate(requireId(message));
      case 'APPLY_MANUAL_PRICE':
        return Monitor.recordManualPrice(requireId(message), {
          price: message.price,
          originalPrice: message.originalPrice,
          source: message.source === 'confirmed' ? 'confirmed' : 'manual',
          extractionSource: message.extractionSource
        });
      case 'SET_TRACKING':
        return setTracking(message);
      case 'SET_MONITORING':
        return setMonitoring(message);
      case 'SET_FREQUENCY':
        return setFrequency(message);
      case 'SET_TARGET':
        return setTarget(message);
      case 'SET_NOTIFICATIONS':
        return setNotifications(message);
      case 'REMOVE_PRODUCT':
        return removeProduct(message);
      case 'CLEAR_ALL_PRODUCTS':
        return clearAllProducts();
      case 'UPDATE_SETTINGS':
        return updateSettings(message);
      case 'IMPORT_BACKUP':
        return importBackup(message);
      case 'REBUILD_ALARMS': {
        var alarms = await Alarm.rebuildAll();
        return ok({ alarms: alarms });
      }
      default:
        throw new V.AppError('UNKNOWN');
    }
  }

  chrome.runtime.onInstalled.addListener(function () {
    fullInitialize().catch(function (error) { console.warn('[SPT] Install initialization failed', error); });
  });

  chrome.runtime.onStartup.addListener(function () {
    fullInitialize().catch(function (error) { console.warn('[SPT] Startup initialization failed', error); });
  });

  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (!alarm || !alarm.name) return;
    if (alarm.name === Alarm.MAINTENANCE_ALARM) {
      bootPromise.then(function () { return Alarm.rebuildAll(); }).catch(function (error) {
        console.warn('[SPT] Maintenance alarm failed', error);
      });
      return;
    }
    var productId = Alarm.productIdFromAlarm(alarm.name);
    if (!productId) return;
    bootPromise.then(function () { return Monitor.checkProduct(productId); }).then(function (result) {
      if (result && result.ok === false && !result.skipped) {
        console.info('[SPT] Scheduled check failed:', result.error && result.error.code);
      }
    }).catch(function (error) {
      console.warn('[SPT] Alarm check error', error);
    });
  });

  chrome.notifications.onClicked.addListener(function (notificationId) {
    bootPromise.then(function () { return Notifications.openProductForNotification(notificationId); }).catch(function (error) {
      console.warn('[SPT] Notification click failed', error);
    });
  });

  chrome.notifications.onButtonClicked.addListener(function (notificationId) {
    bootPromise.then(function () { return Notifications.openProductForNotification(notificationId); }).catch(function (error) {
      console.warn('[SPT] Notification button failed', error);
    });
  });

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    // The offscreen document owns this message type. Returning false keeps the
    // service worker from replying first with an "unknown message" error.
    if (message && message.type === 'OFFSCREEN_EXTRACT') return false;
    if (!validSender(sender)) {
      sendResponse({ ok: false, error: { code: 'UNKNOWN', message: V.ERROR_MESSAGES.UNKNOWN } });
      return false;
    }
    handleMessage(message, sender).then(function (response) {
      sendResponse(response);
    }).catch(function (error) {
      if (error && error.code !== 'PRODUCT_NOT_FOUND' && error.code !== 'PERMISSION_REQUIRED') {
        console.warn('[SPT] Message failed', message && message.type, error && (error.detail || error.message));
      }
      sendResponse(fail(error));
    });
    return true;
  });

  if (chrome.permissions && chrome.permissions.onAdded) {
    chrome.permissions.onAdded.addListener(function () {
      bootPromise.then(function () { return Alarm.rebuildAll(); }).catch(function () {});
    });
    chrome.permissions.onRemoved.addListener(function () {
      bootPromise.then(function () { return Alarm.rebuildAll(); }).catch(function () {});
    });
  }

  // Ensure permissions/install state is reconciled on a cold worker start too.
  bootPromise.then(function () {
    return Alarm.ensureMaintenanceAlarm();
  }).catch(function () {});
})();
