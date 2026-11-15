/**
 * Applies the cached theme before first paint (prevents a flash of the wrong
 * theme). The authoritative setting lives in chrome.storage.local and is
 * applied again once settings load.
 */
(function (root) {
  'use strict';

  var CACHE_KEY = 'spt-theme';
  var media = null;

  function resolve(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (_) {
      return 'light';
    }
  }

  function apply(mode, options) {
    var safeMode = mode === 'light' || mode === 'dark' || mode === 'system' ? mode : 'system';
    var resolved = resolve(safeMode);
    var doc = document.documentElement;
    doc.setAttribute('data-theme', resolved);
    doc.setAttribute('data-theme-mode', safeMode);
    doc.style.colorScheme = resolved;
    if (!options || options.persist !== false) {
      try { localStorage.setItem(CACHE_KEY, safeMode); } catch (_) { /* ignore */ }
    }
    return resolved;
  }

  function readCached() {
    try { return localStorage.getItem(CACHE_KEY) || 'system'; } catch (_) { return 'system'; }
  }

  function watchSystem() {
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)');
      var handler = function () {
        if (document.documentElement.getAttribute('data-theme-mode') === 'system') apply('system', { persist: false });
      };
      if (typeof media.addEventListener === 'function') media.addEventListener('change', handler);
      else if (typeof media.addListener === 'function') media.addListener(handler);
    } catch (_) { /* ignore */ }
  }

  apply(readCached(), { persist: false });
  watchSystem();

  root.SPT = root.SPT || {};
  root.SPT.Theme = { apply: apply, readCached: readCached, resolve: resolve };
})(typeof globalThis !== 'undefined' ? globalThis : self);
