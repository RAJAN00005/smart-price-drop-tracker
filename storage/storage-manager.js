/**
 * Local-only persistence built on chrome.storage.local plus ephemeral
 * monitoring-tab bookkeeping in chrome.storage.session.
 *
 * Products are stored under individual keys (spt:product:<id>) so two checks
 * can never overwrite each other's complete product list. All mutations in the
 * service worker are serialized with a promise mutex.
 */
(function (root) {
  'use strict';

  var V = root.SPT.Validation;
  var D = root.SPT.DateUtils;
  var DM = root.SPT.DataModel;
  var U = root.SPT.UrlUtils;

  var PREFIX = 'spt:product:';
  var KEY_SETTINGS = 'spt:settings';
  var KEY_META = 'spt:meta';
  var KEY_TEMP_TABS = 'spt:tempTabs';
  var SCHEMA_VERSION = 1;

  var tail = Promise.resolve();
  var initPromise = null;

  function withLock(fn) {
    var run = tail.then(fn, fn);
    tail = run.then(function () {}, function () {});
    return run;
  }

  function localGet(keys) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.storage.local.get(keys, function (result) {
          var err = chrome.runtime.lastError;
          if (err) return reject(new V.AppError('STORAGE_ERROR', null, err.message));
          resolve(result || {});
        });
      } catch (error) {
        reject(new V.AppError('STORAGE_ERROR', null, String(error && error.message || error)));
      }
    });
  }

  function localSet(items) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.storage.local.set(items, function () {
          var err = chrome.runtime.lastError;
          if (err) {
            var message = err.message || '';
            if (/quota|QUOTA_BYTES/i.test(message)) return reject(new V.AppError('STORAGE_FULL', null, message));
            return reject(new V.AppError('STORAGE_ERROR', null, message));
          }
          resolve();
        });
      } catch (error) {
        reject(new V.AppError('STORAGE_ERROR', null, String(error && error.message || error)));
      }
    });
  }

  function localRemove(keys) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.storage.local.remove(keys, function () {
          var err = chrome.runtime.lastError;
          if (err) return reject(new V.AppError('STORAGE_ERROR', null, err.message));
          resolve();
        });
      } catch (error) {
        reject(new V.AppError('STORAGE_ERROR', null, String(error && error.message || error)));
      }
    });
  }

  function sessionAvailable() {
    return !!(chrome.storage && chrome.storage.session);
  }

  function sessionGet(key) {
    if (!sessionAvailable()) return Promise.resolve({});
    return new Promise(function (resolve, reject) {
      chrome.storage.session.get(key, function (result) {
        var err = chrome.runtime.lastError;
        if (err) return reject(new V.AppError('STORAGE_ERROR', null, err.message));
        resolve(result || {});
      });
    });
  }

  function sessionSet(items) {
    if (!sessionAvailable()) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      chrome.storage.session.set(items, function () {
        var err = chrome.runtime.lastError;
        if (err) return reject(new V.AppError('STORAGE_ERROR', null, err.message));
        resolve();
      });
    });
  }

  function productKey(id) {
    return PREFIX + id;
  }

  function isProductKey(key) {
    return typeof key === 'string' && key.indexOf(PREFIX) === 0;
  }

  function parseProduct(raw, key) {
    try {
      return DM.validateProduct(raw);
    } catch (error) {
      // A single corrupt record must not take down the whole dashboard.
      console.warn('[SPT] Skipping invalid stored product:', key, error && error.code);
      return null;
    }
  }

  function productFromStorage(key, raw) {
    if (!raw || !V.isPlainObject(raw)) return null;
    var product = parseProduct(raw, key);
    if (!product) return null;
    if (key !== productKey(product.id)) {
      // The id is the source of truth for keying; preserve the record's id but
      // surface it under its actual storage key if they differ.
      product.id = key.slice(PREFIX.length);
    }
    return product;
  }

  function sortedProducts(products) {
    return products.sort(function (a, b) {
      return (D.parseDate(b.createdAt) || 0) - (D.parseDate(a.createdAt) || 0);
    });
  }

  async function readProductsUnlocked() {
    var all = await localGet(null);
    var products = [];
    Object.keys(all).forEach(function (key) {
      if (!isProductKey(key)) return;
      var product = productFromStorage(key, all[key]);
      if (product) products.push(product);
    });
    return sortedProducts(products);
  }

  async function readSettingsUnlocked() {
    var result = await localGet(KEY_SETTINGS);
    return V.sanitizeSettings(result[KEY_SETTINGS] || DM.defaultSettings());
  }

  async function writeProductUnlocked(product) {
    if (!product || !product.id) throw new V.AppError('VALIDATION_ERROR');
    var clean = DM.validateProduct(product);
    await localSet({ [productKey(clean.id)]: clean });
    return clean;
  }

  async function migrateUnlocked() {
    var all = await localGet(null);
    var meta = all[KEY_META];
    var writes = {};
    var removals = [];

    var legacyProducts = all.products;
    if (Array.isArray(legacyProducts) && legacyProducts.length) {
      var seen = new Set();
      for (var i = 0; i < legacyProducts.length; i++) {
        var migrated = DM.migrateLegacyProduct(legacyProducts[i]);
        if (!migrated) continue;
        if (seen.has(migrated.normalizedUrl)) continue;
        seen.add(migrated.normalizedUrl);
        writes[productKey(migrated.id)] = migrated;
      }
      removals.push('products');
    }

    if (all.settings && !all[KEY_SETTINGS]) {
      writes[KEY_SETTINGS] = V.sanitizeSettings(all.settings);
      removals.push('settings');
    }

    if (!all[KEY_SETTINGS] && !writes[KEY_SETTINGS]) {
      writes[KEY_SETTINGS] = DM.defaultSettings();
    }

    if (!meta || !Number.isFinite(Number(meta.schemaVersion)) || Number(meta.schemaVersion) < SCHEMA_VERSION) {
      meta = V.isPlainObject(meta) ? meta : {};
      writes[KEY_META] = {
        schemaVersion: SCHEMA_VERSION,
        createdAt: V.asIso(meta.createdAt, D.nowIso()),
        updatedAt: D.nowIso()
      };
      if (meta.schemaVersion !== undefined) {
        writes[KEY_META].migratedFrom = Number(meta.schemaVersion);
      }
    }

    if (Object.keys(writes).length) await localSet(writes);
    if (removals.length) {
      try { await localRemove(removals); } catch (error) { console.warn('[SPT] Legacy key cleanup failed', error); }
    }
    return true;
  }

  var StorageManager = {
    PREFIX: PREFIX,
    KEY_SETTINGS: KEY_SETTINGS,
    KEY_META: KEY_META,
    KEY_TEMP_TABS: KEY_TEMP_TABS,
    SCHEMA_VERSION: SCHEMA_VERSION,

    withLock: withLock,

    async init() {
      if (!initPromise) {
        initPromise = withLock(migrateUnlocked).catch(function (error) {
          initPromise = null;
          throw error;
        });
      }
      return initPromise;
    },

    async getSettings() {
      return readSettingsUnlocked();
    },

    async saveSettings(patch) {
      return withLock(async function () {
        var current = await readSettingsUnlocked();
        var merged = V.sanitizeSettings(Object.assign({}, current, patch || {}));
        merged.updatedAt = D.nowIso();
        await localSet({ [KEY_SETTINGS]: merged });
        return merged;
      });
    },

    async listProducts() {
      return readProductsUnlocked();
    },

    async getProduct(id) {
      if (!id) return null;
      var result = await localGet(productKey(id));
      return productFromStorage(productKey(id), result[productKey(id)]);
    },

    async countProducts() {
      var all = await localGet(null);
      return Object.keys(all).filter(isProductKey).length;
    },

    async findMatching(input) {
      var url = input && input.url ? U.cleanUrl(input.url) : '';
      var normalized = url ? U.normalizedProductUrl(url) : '';
      var externalId = input && input.externalId ? String(input.externalId) : '';
      var storeId = input && input.storeId ? String(input.storeId) : '';
      var products = await readProductsUnlocked();
      for (var i = 0; i < products.length; i++) {
        var product = products[i];
        if (normalized && product.normalizedUrl === normalized) return product;
        if (externalId && storeId && product.externalId === externalId && product.storeId === storeId) return product;
      }
      return null;
    },

    async findByNormalizedUrl(url) {
      return this.findMatching({ url: url });
    },

    async addProduct(draft) {
      return withLock(async function () {
        var settings = await readSettingsUnlocked();
        var products = await readProductsUnlocked();
        if (products.length >= V.LIMITS.MAX_PRODUCTS) throw new V.AppError('PRODUCT_LIMIT');

        var normalized = U.normalizedProductUrl(draft.url);
        var externalId = V.cleanText(draft.externalId || U.externalIdFor(draft.url, draft.storeId || ''), 120);
        for (var i = 0; i < products.length; i++) {
          var existing = products[i];
          if (normalized && existing.normalizedUrl === normalized) {
            return { duplicate: true, product: existing };
          }
          if (externalId && existing.externalId === externalId &&
              (!draft.storeId || existing.storeId === draft.storeId)) {
            return { duplicate: true, product: existing };
          }
        }

        var draftWithExtras = Object.assign({}, draft, {
          externalId: externalId,
          checkFrequency: draft.checkFrequency || settings.defaultFrequency
        });
        var product = DM.createProduct(draftWithExtras, settings);
        await localSet({ [productKey(product.id)]: product });
        return { duplicate: false, product: product };
      });
    },

    async updateProduct(id, mutator) {
      if (!id) throw new V.AppError('PRODUCT_NOT_FOUND');
      return withLock(async function () {
        var result = await localGet(productKey(id));
        var raw = result[productKey(id)];
        if (!raw) throw new V.AppError('PRODUCT_NOT_FOUND');
        var product = parseProduct(raw, productKey(id));
        if (!product) throw new V.AppError('PRODUCT_NOT_FOUND');
        product.id = id;
        var mutationResult = await mutator(product);
        var clean = await writeProductUnlocked(product);
        return { product: clean, result: mutationResult };
      });
    },

    async saveProduct(product) {
      return withLock(function () { return writeProductUnlocked(product); });
    },

    async removeProduct(id) {
      if (!id) return false;
      return withLock(async function () {
        await localRemove(productKey(id));
        return true;
      });
    },

    async clearProducts() {
      return withLock(async function () {
        var all = await localGet(null);
        var keys = Object.keys(all).filter(isProductKey);
        if (keys.length) await localRemove(keys);
        return keys.length;
      });
    },

    async exportData() {
      var products = await readProductsUnlocked();
      var settings = await readSettingsUnlocked();
      var metaResult = await localGet(KEY_META);
      var payload = DM.exportPayload(products, settings);
      payload.meta = V.isPlainObject(metaResult[KEY_META]) ? metaResult[KEY_META] : null;
      return payload;
    },

    async importBackup(data, options) {
      var opts = options || {};
      return withLock(async function () {
        var validated = DM.validateBackup(data);
        var mode = opts.mode === 'replace' ? 'replace' : 'merge';
        var products = await readProductsUnlocked();
        var existing = products.slice();
        var imported = [];
        var skipped = validated.skipped;

        if (mode === 'replace') {
          var importedProducts = [];
          for (var j = 0; j < validated.products.length; j++) {
            var rp = Object.assign({}, validated.products[j], { id: V.uid('p_'), updatedAt: D.nowIso() });
            importedProducts.push(DM.validateProduct(rp));
          }
          if (!importedProducts.length) throw new V.AppError('INVALID_IMPORT');
          var all = await localGet(null);
          var keys = Object.keys(all).filter(isProductKey);
          if (keys.length) await localRemove(keys);
          var writes = {};
          importedProducts.forEach(function (p) { writes[productKey(p.id)] = p; });
          if (opts.includeSettings !== false && validated.settings) {
            writes[KEY_SETTINGS] = validated.settings;
          }
          await localSet(writes);
          imported = importedProducts;
        } else {
          var seenUrls = new Set(existing.map(function (p) { return p.normalizedUrl; }));
          var seenExternal = new Set(existing.filter(function (p) { return p.externalId; }).map(function (p) {
            return p.storeId + '|' + p.externalId;
          }));
          var newProducts = [];
          for (var k = 0; k < validated.products.length; k++) {
            var candidate = validated.products[k];
            var candidateUrl = candidate.normalizedUrl;
            var candidateExt = candidate.externalId ? candidate.storeId + '|' + candidate.externalId : '';
            if (seenUrls.has(candidateUrl) || (candidateExt && seenExternal.has(candidateExt))) {
              skipped++;
              continue;
            }
            var withId = Object.assign({}, candidate, { id: V.uid('p_'), updatedAt: D.nowIso() });
            var clean = DM.validateProduct(withId);
            newProducts.push(clean);
            seenUrls.add(clean.normalizedUrl);
            if (candidateExt) seenExternal.add(candidateExt);
          }
          if (newProducts.length && products.length + newProducts.length > V.LIMITS.MAX_PRODUCTS) {
            throw new V.AppError('PRODUCT_LIMIT');
          }
          var mergeWrites = {};
          newProducts.forEach(function (p) { mergeWrites[productKey(p.id)] = p; });
          if (opts.includeSettings && validated.settings) mergeWrites[KEY_SETTINGS] = validated.settings;
          if (Object.keys(mergeWrites).length) await localSet(mergeWrites);
          imported = newProducts;
        }

        return {
          mode: mode,
          imported: imported.length,
          skipped: skipped,
          errors: validated.errors,
          settingsImported: !!(opts.includeSettings !== false && validated.settings && mode === 'replace')
            || !!(opts.includeSettings && validated.settings)
        };
      });
    },

    async getStorageInfo() {
      var used = 0;
      try {
        used = await new Promise(function (resolve, reject) {
          chrome.storage.local.getBytesInUse(null, function (bytes) {
            var err = chrome.runtime.lastError;
            if (err) return reject(err);
            resolve(bytes || 0);
          });
        });
      } catch (_) {
        used = 0;
      }
      var quota = (chrome.storage.local.QUOTA_BYTES || 10485760);
      return { used: used, quota: quota, percent: quota ? Math.min(100, Math.round((used / quota) * 1000) / 10) : 0 };
    },

    async getMeta() {
      var result = await localGet(KEY_META);
      return V.isPlainObject(result[KEY_META]) ? result[KEY_META] : null;
    },

    async setMeta(patch) {
      return withLock(async function () {
        var result = await localGet(KEY_META);
        var current = V.isPlainObject(result[KEY_META]) ? result[KEY_META] : {};
        var merged = Object.assign({}, current, patch || {}, {
          schemaVersion: current.schemaVersion || SCHEMA_VERSION,
          updatedAt: D.nowIso()
        });
        await localSet({ [KEY_META]: merged });
        return merged;
      });
    },

    async getTempTabs() {
      try {
        var result = await sessionGet(KEY_TEMP_TABS);
        return Array.isArray(result[KEY_TEMP_TABS]) ? result[KEY_TEMP_TABS] : [];
      } catch (_) {
        return [];
      }
    },

    async addTempTab(tabId, productId) {
      return withLock(async function () {
        var tabs = await this.getTempTabs();
        tabs = tabs.filter(function (entry) { return entry && entry.tabId !== tabId; });
        tabs.push({ tabId: tabId, productId: productId || '', at: D.nowIso() });
        await sessionSet({ [KEY_TEMP_TABS]: tabs });
      }.bind(this));
    },

    async removeTempTab(tabId) {
      return withLock(async function () {
        var tabs = await this.getTempTabs();
        var filtered = tabs.filter(function (entry) { return entry && entry.tabId !== tabId; });
        if (filtered.length !== tabs.length) await sessionSet({ [KEY_TEMP_TABS]: filtered });
      }.bind(this));
    },

    async clearTempTabs() {
      return withLock(async function () {
        await sessionSet({ [KEY_TEMP_TABS]: [] });
      });
    }
  };

  root.SPT = root.SPT || {};
  root.SPT.StorageManager = StorageManager;
})(typeof globalThis !== 'undefined' ? globalThis : self);
