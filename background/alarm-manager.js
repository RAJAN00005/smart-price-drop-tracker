/**
 * Per-product one-shot alarms. Using one alarm per product avoids a single
 * global tick checking every product at once and lets each product keep its
 * own frequency and next-check time.
 */
(function (root) {
  'use strict';

  var V = root.SPT.Validation;
  var D = root.SPT.DateUtils;
  var Storage = root.SPT.StorageManager;

  var CHECK_PREFIX = 'spt:check:';
  var MAINTENANCE_ALARM = 'spt:maintenance';
  var MIN_DELAY_MS = 30 * 1000;
  var MAINTENANCE_MINUTES = 6 * 60;

  function alarmName(productId) {
    return CHECK_PREFIX + productId;
  }

  function productIdFromAlarm(name) {
    if (!name || name.indexOf(CHECK_PREFIX) !== 0) return null;
    var id = name.slice(CHECK_PREFIX.length);
    return id || null;
  }

  function alarmsGetAll() {
    return new Promise(function (resolve, reject) {
      try {
        chrome.alarms.getAll(function (alarms) {
          var err = chrome.runtime.lastError;
          if (err) return reject(new V.AppError('ALARM_ERROR', null, err.message));
          resolve(Array.isArray(alarms) ? alarms : []);
        });
      } catch (error) {
        reject(new V.AppError('ALARM_ERROR', null, String(error && error.message || error)));
      }
    });
  }

  function alarmClear(name) {
    return new Promise(function (resolve) {
      try {
        chrome.alarms.clear(name, function () { resolve(); });
      } catch (_) {
        resolve();
      }
    });
  }

  function alarmClearAll() {
    return new Promise(function (resolve, reject) {
      try {
        chrome.alarms.clearAll(function () {
          var err = chrome.runtime.lastError;
          if (err) return reject(new V.AppError('ALARM_ERROR', null, err.message));
          resolve();
        });
      } catch (error) {
        reject(new V.AppError('ALARM_ERROR', null, String(error && error.message || error)));
      }
    });
  }

  function alarmCreate(name, when) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.alarms.create(name, { when: Math.max(Date.now() + MIN_DELAY_MS, Number(when)) });
        resolve();
      } catch (error) {
        reject(new V.AppError('ALARM_ERROR', null, String(error && error.message || error)));
      }
    });
  }

  async function hasPermission(product) {
    var client = root.SPT.ExtractionClient;
    if (!client) return false;
    return client.hasSitePermission(product.url);
  }

  function frequencyMs(product) {
    var hours = V.asFrequency(product && product.checkFrequency, 12);
    return hours * 60 * 60 * 1000;
  }

  function computeNextCheck(product, fromNow) {
    var now = Date.now();
    var parsed = product && product.nextCheck ? D.parseDate(product.nextCheck) : null;
    if (!fromNow && parsed && parsed > now + 5000) return new Date(parsed).toISOString();
    return new Date(now + frequencyMs(product)).toISOString();
  }

  async function ensureMaintenanceAlarm() {
    try {
      var alarms = await alarmsGetAll();
      var existing = alarms.find(function (alarm) { return alarm.name === MAINTENANCE_ALARM; });
      if (existing) return;
      chrome.alarms.create(MAINTENANCE_ALARM, {
        delayInMinutes: 15,
        periodInMinutes: MAINTENANCE_MINUTES
      });
    } catch (error) {
      console.warn('[SPT] Could not create maintenance alarm', error);
    }
  }

  /**
   * Creates (or clears) the alarm for a product without writing storage.
   * The caller is responsible for persisting product.nextCheck.
   */
  async function createFor(product) {
    if (!product || !product.id) return { scheduled: false, reason: 'missing' };
    var name = alarmName(product.id);
    if (!product.trackingEnabled) {
      await alarmClear(name);
      return { scheduled: false, reason: 'paused' };
    }
    if (!product.monitoringEnabled) {
      await alarmClear(name);
      return { scheduled: false, reason: 'manual-only' };
    }
    var permitted = await hasPermission(product);
    if (!permitted) {
      await alarmClear(name);
      return { scheduled: false, reason: 'permission' };
    }
    var next = product.nextCheck && D.parseDate(product.nextCheck) > Date.now() + 5000
      ? product.nextCheck
      : new Date(Date.now() + frequencyMs(product)).toISOString();
    await alarmCreate(name, D.parseDate(next));
    return { scheduled: true, nextCheck: next };
  }

  /**
   * Schedules a product and persists the resulting nextCheck. When monitor
   * permission is missing the alarm is removed and nextCheck becomes null.
   */
  async function scheduleProductById(productId, options) {
    var opts = options || {};
    var scheduledResult = { scheduled: false, reason: 'missing' };
    var updated;
    try {
      var result = await Storage.updateProduct(productId, async function (product) {
        if (!product.trackingEnabled) {
          product.nextCheck = null;
          scheduledResult = { scheduled: false, reason: 'paused' };
          return { scheduled: false, reason: 'paused' };
        }
        if (!product.monitoringEnabled) {
          product.nextCheck = null;
          scheduledResult = { scheduled: false, reason: 'manual-only' };
          return { scheduled: false, reason: 'manual-only' };
        }
        var permitted = await hasPermission(product);
        if (!permitted) {
          product.nextCheck = null;
          product.checkStatus = 'permission-required';
          if (!product.lastError || product.lastError.code !== 'PERMISSION_REQUIRED') {
            product.lastError = {
              code: 'PERMISSION_REQUIRED',
              message: V.ERROR_MESSAGES.PERMISSION_REQUIRED,
              detail: '',
              at: D.nowIso()
            };
          }
          scheduledResult = { scheduled: false, reason: 'permission' };
          return { scheduled: false, reason: 'permission' };
        }
        var next = computeNextCheck(product, opts.fromNow === true);
        product.nextCheck = next;
        if (product.checkStatus === 'permission-required') product.checkStatus = 'idle';
        if (product.lastError && product.lastError.code === 'PERMISSION_REQUIRED') product.lastError = null;
        scheduledResult = { scheduled: true, nextCheck: next };
        return { scheduled: true, nextCheck: next };
      });
      updated = result.product;
    } catch (error) {
      if (error && error.code === 'PRODUCT_NOT_FOUND') return { scheduled: false, reason: 'missing' };
      throw error;
    }

    await alarmClear(alarmName(productId));
    if (scheduledResult.scheduled) {
      try {
        await alarmCreate(alarmName(productId), D.parseDate(scheduledResult.nextCheck));
      } catch (error) {
        console.warn('[SPT] Alarm creation failed', error);
        scheduledResult = { scheduled: false, reason: 'alarm-error', error: V.asErrorInfo(error, 'ALARM_ERROR') };
      }
    }
    return Object.assign({ product: updated }, scheduledResult);
  }

  async function clearFor(productId) {
    await alarmClear(alarmName(productId));
  }

  /**
   * Reconciles alarms with stored products. Runs on install/startup, after
   * permission changes, and periodically as a safety net.
   */
  async function rebuildAll() {
    await ensureMaintenanceAlarm();
    var products;
    try {
      products = await Storage.listProducts();
    } catch (error) {
      console.warn('[SPT] Could not list products while rebuilding alarms', error);
      return { checked: 0, scheduled: 0 };
    }
    var existingAlarms = [];
    try { existingAlarms = await alarmsGetAll(); } catch (_) { existingAlarms = []; }
    var existingMap = {};
    existingAlarms.forEach(function (alarm) { existingMap[alarm.name] = alarm; });
    var validNames = new Set();
    var scheduled = 0;

    for (var i = 0; i < products.length; i++) {
      var product = products[i];
      var name = alarmName(product.id);
      if (!product.trackingEnabled || !product.monitoringEnabled) {
        if (existingMap[name]) await alarmClear(name);
        if (product.nextCheck) {
          try {
            await Storage.updateProduct(product.id, function (p) {
              p.nextCheck = null;
              p.checkStatus = p.trackingEnabled ? p.checkStatus : 'paused';
            });
          } catch (_) { /* ignore */ }
        }
        continue;
      }
      var permitted = await hasPermission(product);
      if (!permitted) {
        if (existingMap[name]) await alarmClear(name);
        if (product.nextCheck) {
          try {
            await Storage.updateProduct(product.id, function (p) { p.nextCheck = null; });
          } catch (_) { /* ignore */ }
        }
        continue;
      }
      if (product.checkStatus === 'permission-required') {
        try {
          await Storage.updateProduct(product.id, function (p) {
            p.checkStatus = p.trackingEnabled ? 'idle' : 'paused';
            if (p.lastError && p.lastError.code === 'PERMISSION_REQUIRED') p.lastError = null;
          });
        } catch (_) { /* ignore */ }
      }
      validNames.add(name);
      var existing = existingMap[name];
      var nextMs = D.parseDate(product.nextCheck);
      if (!existing) {
        if (!nextMs || nextMs <= Date.now() + 5000) nextMs = Date.now() + 60 * 1000;
        try {
          await alarmCreate(name, nextMs);
          scheduled++;
          var nextIso = new Date(nextMs).toISOString();
          if (product.nextCheck !== nextIso) {
            await Storage.updateProduct(product.id, function (p) { p.nextCheck = nextIso; });
          }
        } catch (error) {
          console.warn('[SPT] Could not recreate alarm for', product.id, error);
        }
      } else if (!product.nextCheck && existing.scheduledTime) {
        try {
          await Storage.updateProduct(product.id, function (p) {
            p.nextCheck = new Date(existing.scheduledTime).toISOString();
          });
        } catch (_) { /* ignore */ }
      }
    }

    // Remove orphaned product alarms (deleted/paused products).
    for (var a = 0; a < existingAlarms.length; a++) {
      var alarm = existingAlarms[a];
      if (alarm.name.indexOf(CHECK_PREFIX) === 0 && !validNames.has(alarm.name)) {
        await alarmClear(alarm.name);
      }
    }
    return { checked: products.length, scheduled: scheduled };
  }

  async function clearAllCheckAlarms() {
    try {
      var alarms = await alarmsGetAll();
      for (var i = 0; i < alarms.length; i++) {
        if (alarms[i].name.indexOf(CHECK_PREFIX) === 0) await alarmClear(alarms[i].name);
      }
    } catch (_) { /* ignore */ }
  }

  root.SPT = root.SPT || {};
  root.SPT.AlarmManager = {
    CHECK_PREFIX: CHECK_PREFIX,
    MAINTENANCE_ALARM: MAINTENANCE_ALARM,
    alarmName: alarmName,
    productIdFromAlarm: productIdFromAlarm,
    frequencyMs: frequencyMs,
    computeNextCheck: computeNextCheck,
    createFor: createFor,
    scheduleProductById: scheduleProductById,
    clearFor: clearFor,
    rebuildAll: rebuildAll,
    clearAllCheckAlarms: clearAllCheckAlarms,
    ensureMaintenanceAlarm: ensureMaintenanceAlarm,
    hasPermission: hasPermission
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
