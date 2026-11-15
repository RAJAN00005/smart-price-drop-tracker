/**
 * Price-drop and target-price notifications. One notification per product and
 * per newly notified price; the stable notification id also lets Chrome
 * replace an older alert for the same product.
 */
(function (root) {
  'use strict';

  var V = root.SPT.Validation;
  var P = root.SPT.PriceParser;
  var D = root.SPT.DateUtils;
  var Storage = root.SPT.StorageManager;

  var ID_PREFIX = 'spt-';

  function notificationId(productId) {
    return ID_PREFIX + productId;
  }

  function productIdFromNotification(notificationId) {
    if (!notificationId || notificationId.indexOf(ID_PREFIX) !== 0) return null;
    return notificationId.slice(ID_PREFIX.length) || null;
  }

  function createNotification(id, options) {
    return new Promise(function (resolve, reject) {
      try {
        if (!chrome.notifications || !chrome.notifications.create) {
          return reject(new V.AppError('NOTIFICATION_ERROR', 'Notifications are not available.'));
        }
        chrome.notifications.create(id, options, function (createdId) {
          var err = chrome.runtime.lastError;
          if (err) return reject(new V.AppError('NOTIFICATION_ERROR', null, err.message));
          resolve(createdId || id);
        });
      } catch (error) {
        reject(new V.AppError('NOTIFICATION_ERROR', null, String(error && error.message || error)));
      }
    });
  }

  function clearNotification(id) {
    return new Promise(function (resolve) {
      try {
        chrome.notifications.clear(id, function () { resolve(); });
      } catch (_) { resolve(); }
    });
  }

  function buildMessage(product, report, targetNotification, currencyDisplay) {
    var money = function (value) { return P.formatPrice(value, product.currency, { currencyDisplay: currencyDisplay }); };
    var title = V.cleanText(product.title, 70);
    var lines = [];
    if (targetNotification) {
      lines.push(title + ' has reached your target price.');
    } else {
      lines.push(title + ' price has dropped!');
    }
    if (Number.isFinite(report.previousPrice) && report.previousPrice > 0) {
      lines.push('Previous Price: ' + money(report.previousPrice));
    }
    lines.push('Current Price: ' + money(report.price));
    if (report.dropAmount > 0) {
      lines.push('You Save: ' + money(report.dropAmount) + ' (' + Math.round(report.dropPercent) + '%)');
    }
    if (targetNotification && product.targetPrice) {
      lines.push('Your target: ' + money(product.targetPrice));
    }
    if (product.store) lines.push(product.store);
    return lines.join('\n').slice(0, 1200);
  }

  /**
   * Decides and shows a notification. The caller persists
   * DataModel.markNotificationSent after a successful result.
   */
  async function notifyPriceChange(product, report, options) {
    var opts = options || {};
    if (!product || !report) return { shown: false, reason: 'missing' };
    if (opts.suppress === true) return { shown: false, reason: 'suppressed' };
    if (report.source === 'import') return { shown: false, reason: 'import' };
    if (product.notificationsEnabled === false) return { shown: false, reason: 'product-disabled' };
    if (report.availability === 'OutOfStock' || report.availability === 'Discontinued') {
      return { shown: false, reason: 'unavailable' };
    }

    var settings;
    try {
      settings = await Storage.getSettings();
    } catch (error) {
      return { shown: false, reason: 'settings', error: V.asErrorInfo(error, 'STORAGE_ERROR') };
    }
    if (!settings.notificationsEnabled) return { shown: false, reason: 'globally-disabled' };

    var isNewPrice = product.lastNotifiedPrice !== report.price;
    var dropWanted = report.isDrop === true && settings.priceDropNotifications && isNewPrice;
    var targetWanted = report.targetDue === true && settings.targetNotifications && isNewPrice;
    if (!dropWanted && !targetWanted) return { shown: false, reason: 'not-eligible' };

    var useTarget = targetWanted;
    var title = useTarget ? 'Target price reached!' : 'Price Drop Alert!';
    var message = buildMessage(product, report, useTarget, settings.currencyDisplay);
    var id = notificationId(product.id);

    try {
      await createNotification(id, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
        title: title,
        message: message,
        contextMessage: V.cleanText(product.store || 'Smart Price Drop Tracker', 80),
        priority: 2,
        requireInteraction: false,
        silent: false,
        buttons: [{ title: 'Open product page' }]
      });
    } catch (error) {
      return { shown: false, reason: 'create-failed', error: V.asErrorInfo(error, 'NOTIFICATION_ERROR') };
    }

    return {
      shown: true,
      id: id,
      target: useTarget,
      title: title,
      message: message
    };
  }

  async function openProductForNotification(notificationId) {
    var productId = productIdFromNotification(notificationId);
    await clearNotification(notificationId);
    if (!productId) return false;
    var product = null;
    try { product = await Storage.getProduct(productId); } catch (_) { product = null; }
    if (!product || !product.url) return false;
    try {
      await chrome.tabs.create({ url: product.url });
      return true;
    } catch (error) {
      console.warn('[SPT] Could not open product from notification', error);
      return false;
    }
  }

  root.SPT = root.SPT || {};
  root.SPT.NotificationManager = {
    ID_PREFIX: ID_PREFIX,
    notificationId: notificationId,
    productIdFromNotification: productIdFromNotification,
    notifyPriceChange: notifyPriceChange,
    openProductForNotification: openProductForNotification,
    clearNotification: clearNotification
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
