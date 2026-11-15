/**
 * URL validation, sanitizing and duplicate-detection normalization.
 *
 * Tracking/affiliate parameters are removed, but product-defining parameters
 * (for example Flipkart's `pid` variant id) are preserved. Title similarity is
 * never used for duplicate detection.
 */
(function (root) {
  'use strict';

  var TRACKING_PARAMS = [
    'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'dclid', 'yclid',
    'mc_cid', 'mc_eid', '_ga', '_gl', 'igshid', 'mkt_tok',
    'ref', 'ref_', 'ref_src', 'ref_url', 'referrer', 'source', 'src',
    'tag', 'linkcode', 'linkid', 'camp', 'creative', 'creativeasin',
    'ascsubtag', 'smid', 'th', 'psc', 'spia', 'sprefix', 'crid',
    'qid', 'sr', 'ds', 'dplnkid', 'slot', 'pf_rd_p', 'pf_rd_r',
    'pd_rd_r', 'pd_rd_w', 'pd_rd_wg', 'pd_rd_i',
    'otracker', 'otracker1', 'ssid', 'srno', 'fm', 'iid', 'ppt', 'ppn',
    'tk', '_appid', 'lid', 'marketplace', 'pageuid', '_refid', 'affid',
    'affiliate', 'cmpid', 'utm', 'ved', 'ei', 'srsltid', 's_cid',
    'wickedid', 'wickedsource', 'irclickid', 'irgwc', 'sharedid'
  ];

  var KNOWN_STORES = [
    'amazon.in', 'flipkart.com', 'myntra.com', 'ajio.com', 'croma.com',
    'reliancedigital.in', 'tatacliq.com', 'meesho.com'
  ];

  function isTrackingParam(name) {
    var key = String(name).toLowerCase();
    if (key.indexOf('utm_') === 0) return true;
    if (key.indexOf('pd_rd_') === 0 || key.indexOf('pf_rd_') === 0) return true;
    if (key.indexOf('_hs') === 0 || key.indexOf('mc_') === 0 || key.indexOf('hsa_') === 0) return true;
    if (key.indexOf('vero_') === 0 || key.indexOf('spm') === 0) return true;
    if (key.indexOf('aff') === 0) return true;
    return TRACKING_PARAMS.indexOf(key) !== -1;
  }

  function isSupportedWebUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return /^https?:\/\//i.test(url.trim());
  }

  function parseHttpUrl(url, base) {
    if (typeof url !== 'string') return null;
    var value = url.trim();
    if (!value) return null;
    try {
      var parsed = new URL(value, base);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      if (!parsed.hostname) return null;
      if (parsed.username || parsed.password) return null;
      if (parsed.href.length > 4096) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function isKnownStoreHost(hostname) {
    var host = String(hostname || '').toLowerCase().replace(/^www\./, '');
    for (var i = 0; i < KNOWN_STORES.length; i++) {
      if (host === KNOWN_STORES[i] || host.endsWith('.' + KNOWN_STORES[i])) return true;
    }
    return false;
  }

  function sortedParams(parsed) {
    var entries = [];
    parsed.searchParams.forEach(function (value, key) {
      if (!isTrackingParam(key)) entries.push([key, value]);
    });
    entries.sort(function (a, b) {
      if (a[0] === b[0]) return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
      return a[0] < b[0] ? -1 : 1;
    });
    return entries;
  }

  function cleanUrl(url, base) {
    var parsed = parseHttpUrl(url, base);
    if (!parsed) return '';
    parsed.hash = '';
    var params = sortedParams(parsed);
    var query = new URLSearchParams();
    for (var i = 0; i < params.length; i++) query.append(params[i][0], params[i][1]);
    parsed.search = query.toString();
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    // Upgrade known Indian retailers to HTTPS for reliable monitoring.
    if (parsed.protocol === 'http:' && isKnownStoreHost(parsed.hostname)) parsed.protocol = 'https:';
    return parsed.href.length <= 4096 ? parsed.href : '';
  }

  function amazonAsin(url) {
    var parsed = parseHttpUrl(url);
    if (!parsed || !/(^|\.)amazon\./i.test(parsed.hostname)) return null;
    var match = parsed.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/]|$)/i);
    if (match) return match[1].toUpperCase();
    var dp = parsed.searchParams.get('asin') || parsed.searchParams.get('ASIN');
    return dp && /^[A-Z0-9]{10}$/i.test(dp) ? dp.toUpperCase() : null;
  }

  /**
   * Stable key used only to detect the same product listing. It keeps all
   * non-tracking parameters because they may select a size/colour variant.
   */
  function normalizedProductUrl(url, base) {
    var parsed = parseHttpUrl(url, base);
    if (!parsed) return '';
    var host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    var asin = amazonAsin(parsed.href);
    if (asin) return 'https://' + host + '/dp/' + asin;
    parsed.hash = '';
    var params = sortedParams(parsed);
    var query = new URLSearchParams();
    for (var i = 0; i < params.length; i++) query.append(params[i][0], params[i][1]);
    var search = query.toString();
    var path = parsed.pathname;
    if (path.length > 1) path = path.replace(/\/+$/, '');
    return ('https://' + host + path + (search ? '?' + search : '')).toLowerCase();
  }

  function externalIdFor(url, storeId) {
    var parsed = parseHttpUrl(url);
    if (!parsed) return '';
    var path = parsed.pathname;
    var id = '';
    switch (storeId) {
      case 'amazon':
        return amazonAsin(parsed.href) || '';
      case 'flipkart':
        id = parsed.searchParams.get('pid') || '';
        if (!id) {
          var fk = path.match(/\/p\/(itm[a-z0-9]+)/i);
          if (fk) id = fk[1];
        }
        return id ? String(id).toLowerCase() : '';
      case 'myntra':
        id = (path.match(/\/(\d{6,})(?:\/|$)/) || [])[1] || '';
        return id;
      case 'ajio':
        id = (path.match(/\/p\/([a-z0-9_-]{3,})/i) || [])[1] || '';
        return id ? String(id).toLowerCase() : '';
      case 'croma':
        id = (path.match(/\/p\/(\d{4,})/i) || [])[1] || '';
        return id;
      case 'reliance':
        id = (path.match(/\/(?:p|product)\/([a-z0-9_-]{3,})/i) || [])[1] || '';
        return id ? String(id).toLowerCase() : '';
      case 'tatacliq':
        id = (path.match(/\/p\/([a-z0-9_-]{3,})/i) || [])[1] || '';
        return id ? String(id).toLowerCase() : '';
      case 'meesho':
        id = (path.match(/\/p\/([a-z0-9_-]{3,})/i) || [])[1] || '';
        return id ? String(id).toLowerCase() : '';
      default:
        return '';
    }
  }

  function originPattern(url) {
    var parsed = parseHttpUrl(url);
    if (!parsed) return '';
    return parsed.protocol + '//' + parsed.hostname + '/*';
  }

  function getOrigin(url) {
    var parsed = parseHttpUrl(url);
    return parsed ? parsed.origin : '';
  }

  function hostLabel(url) {
    var parsed = parseHttpUrl(url);
    if (!parsed) return 'Unknown store';
    return parsed.hostname.replace(/^www\./, '');
  }

  function safeImageUrl(value, base) {
    if (!value || typeof value !== 'string') return '';
    var raw = value.trim();
    if (!raw) return '';
    if (raw.indexOf('//') === 0) raw = 'https:' + raw;
    var parsed = parseHttpUrl(raw, base || undefined);
    if (!parsed) return '';
    parsed.hash = '';
    if (parsed.href.length > 2048) return '';
    return parsed.href;
  }

  function sameOrigin(a, b) {
    var pa = parseHttpUrl(a);
    var pb = parseHttpUrl(b);
    return !!pa && !!pb && pa.origin === pb.origin;
  }

  function isSupportedProductUrl(url) {
    return !!parseHttpUrl(url);
  }

  root.SPT = root.SPT || {};
  root.SPT.UrlUtils = {
    TRACKING_PARAMS: TRACKING_PARAMS,
    isTrackingParam: isTrackingParam,
    isSupportedWebUrl: isSupportedWebUrl,
    parseHttpUrl: parseHttpUrl,
    cleanUrl: cleanUrl,
    normalizedProductUrl: normalizedProductUrl,
    externalIdFor: externalIdFor,
    originPattern: originPattern,
    getOrigin: getOrigin,
    hostLabel: hostLabel,
    safeImageUrl: safeImageUrl,
    sameOrigin: sameOrigin,
    isSupportedProductUrl: isSupportedProductUrl,
    isKnownStoreHost: isKnownStoreHost
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
