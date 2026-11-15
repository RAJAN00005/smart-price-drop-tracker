/** Flipkart specific selectors, including current and older class names. */
(function (root) {
  'use strict';
  root.SPT = root.SPT || {};
  root.SPT.Extractors = root.SPT.Extractors || {};

  function externalId(url) {
    var utils = root.SPT.UrlUtils;
    return utils ? utils.externalIdFor(url, 'flipkart') : '';
  }

  root.SPT.Extractors.flipkart = {
    id: 'flipkart',
    name: 'Flipkart',
    currency: 'INR',
    priceSelectors: [
      { selector: '.Nx9bqj.CxhGGd', confidence: 0.96 },
      { selector: '.Nx9bqj', confidence: 0.95 },
      { selector: '._30jeq3._16Jk6d', confidence: 0.94 },
      { selector: '._30jeq3', confidence: 0.93 },
      { selector: '[class*="CxhGGd"]', confidence: 0.9 },
      { selector: '#container .CxhGGd', confidence: 0.88 },
      { selector: 'div[class*="price"] .CxhGGd', confidence: 0.82 }
    ],
    originalPriceSelectors: [
      '.yRaY8j',
      '._3I9_wc._2p6lqe',
      '._3I9_wc',
      '[class*="yRaY8j"]',
      '[class*="strike"]'
    ],
    titleSelectors: [
      '.B_NuCI',
      '.VU-ZEz',
      'h1',
      'meta[property="og:title"]'
    ],
    imageSelectors: [
      '.DByuf4',
      '._396cs4',
      '._2r_T1I',
      'img[src*="flixcart"]',
      'meta[property="og:image"]'
    ],
    availabilitySelectors: [
      '._16FRp0',
      '.F_1J1v',
      '.Z8JjpR',
      '[class*="out-of-stock"]'
    ],
    getExternalId: externalId
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
