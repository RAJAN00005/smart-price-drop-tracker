/** AJIO specific selectors. */
(function (root) {
  'use strict';
  root.SPT = root.SPT || {};
  root.SPT.Extractors = root.SPT.Extractors || {};

  function externalId(url) {
    var utils = root.SPT.UrlUtils;
    return utils ? utils.externalIdFor(url, 'ajio') : '';
  }

  root.SPT.Extractors.ajio = {
    id: 'ajio',
    name: 'AJIO',
    currency: 'INR',
    priceSelectors: [
      { selector: '.promotion-clearance .prod-sp', confidence: 0.95 },
      { selector: '.prod-sp', confidence: 0.94 },
      { selector: '[class*="prod-sp"]', confidence: 0.92 },
      { selector: '.product-price .price', confidence: 0.88 },
      { selector: '[class*="price"] .price', confidence: 0.82 }
    ],
    originalPriceSelectors: [
      '.promotion-clearance .prod-cp',
      '.prod-cp',
      '[class*="prod-cp"]',
      '[class*="old-price"]'
    ],
    titleSelectors: [
      '.prod-name',
      'h1.prod-name',
      '.product-name',
      'h1',
      'meta[property="og:title"]'
    ],
    imageSelectors: [
      '.img-meta img',
      '.product-image img',
      'img[src*="assets.ajio"]',
      'meta[property="og:image"]'
    ],
    availabilitySelectors: [
      '.add-to-bag',
      '.out-of-stock',
      '[class*="out-of-stock"]'
    ],
    getExternalId: externalId
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
