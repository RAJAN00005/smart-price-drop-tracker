/**
 * Client for the read-only extraction engine. The engine files are injected
 * on demand (never declared as always-on content scripts), so the extension
 * does not read pages until the user asks or enables monitoring.
 */
(function (root) {
  'use strict';

  var FILES = [
    'utils/date-utils.js',
    'utils/price-parser.js',
    'utils/url-normalizer.js',
    'utils/validation.js',
    'utils/site-catalog.js',
    'extractors/extractor-core.js',
    'extractors/generic-extractor.js',
    'extractors/amazon-extractor.js',
    'extractors/flipkart-extractor.js',
    'extractors/myntra-extractor.js',
    'extractors/ajio-extractor.js',
    'extractors/croma-extractor.js',
    'extractors/reliance-extractor.js',
    'extractors/tata-cliq-extractor.js',
    'extractors/meesho-extractor.js',
    'extractors/extractor-registry.js'
  ];

  function pageRunner() {
    try {
      var sp = globalThis.SPT;
      if (!sp || !sp.ExtractionEngine) {
        return {
          ok: false,
          error: { code: 'INJECTION_FAILED', message: 'The extraction engine could not be loaded on this page.' }
        };
      }
      var data = sp.ExtractionEngine.extract(document, location.href);
      return { ok: true, data: data };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'EXTRACTION_ERROR',
          message: error && error.message ? String(error.message).slice(0, 300) : 'The page could not be read.'
        }
      };
    }
  }

  function isInjectableUrl(url) {
    if (!url || !/^https?:\/\//i.test(url)) return false;
    try {
      var host = new URL(url).hostname;
      if (host === 'chromewebstore.google.com' || (host === 'chrome.google.com' && url.indexOf('/webstore') !== -1)) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  async function getActiveTab() {
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs && tabs[0] ? tabs[0] : null;
    } catch (_) {
      return null;
    }
  }

  async function getTab(tabId) {
    try { return await chrome.tabs.get(tabId); } catch (_) { return null; }
  }

  function mapInjectionError(error, options) {
    var V = root.SPT.Validation;
    var detail = error && error.message ? String(error.message) : String(error || '');
    var code = 'INJECTION_FAILED';
    if (/cannot access|can't access|missing host permission|permission|extension manifest must request/i.test(detail)) {
      code = options && options.monitoring ? 'PERMISSION_REQUIRED' : 'SCRIPTING_BLOCKED';
    }
    var info = V.asErrorInfo({ code: code, message: V.ERROR_MESSAGES[code], details: detail }, code);
    return { code: info.code, message: V.ERROR_MESSAGES[info.code] || info.message, detail: info.detail };
  }

  /**
   * Runs the extraction engine in a tab. Requires activeTab (popup) or an
   * optional host permission (background checks).
   */
  async function extractFromTab(tabId, options) {
    if (!tabId) {
      return { ok: false, error: { code: 'INJECTION_FAILED', message: 'No browser tab is available.' } };
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: FILES,
        world: 'ISOLATED'
      });
      var results = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: pageRunner,
        world: 'ISOLATED'
      });
      var frame = null;
      if (Array.isArray(results)) {
        frame = results.find(function (r) { return r && r.frameId === 0; }) || results[0] || null;
      }
      if (!frame || !frame.result) {
        return {
          ok: false,
          error: { code: 'INJECTION_FAILED', message: 'The page did not return any product information.' }
        };
      }
      return frame.result;
    } catch (error) {
      return { ok: false, error: mapInjectionError(error, options), rawError: error && error.message ? error.message : String(error) };
    }
  }

  function permissionOrigin(url) {
    var utils = root.SPT.UrlUtils;
    return utils ? utils.originPattern(url) : '';
  }

  async function hasSitePermission(url) {
    var pattern = permissionOrigin(url);
    if (!pattern) return false;
    try {
      return await chrome.permissions.contains({ origins: [pattern] });
    } catch (_) {
      return false;
    }
  }

  /**
   * Must be called directly from a user gesture (click handler) in an
   * extension page. Returns { granted, error }.
   */
  async function requestSitePermission(url) {
    var pattern = permissionOrigin(url);
    if (!pattern) return { granted: false, error: 'This page cannot be monitored automatically.' };
    try {
      var granted = await chrome.permissions.request({ origins: [pattern] });
      return { granted: !!granted, error: granted ? '' : 'Permission was not granted.' };
    } catch (error) {
      return { granted: false, error: error && error.message ? error.message : 'Permission could not be requested.' };
    }
  }

  root.SPT = root.SPT || {};
  root.SPT.ExtractionClient = {
    FILES: FILES,
    isInjectableUrl: isInjectableUrl,
    extractFromTab: extractFromTab,
    getActiveTab: getActiveTab,
    getTab: getTab,
    permissionOrigin: permissionOrigin,
    hasSitePermission: hasSitePermission,
    requestSitePermission: requestSitePermission,
    pageRunner: pageRunner
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
