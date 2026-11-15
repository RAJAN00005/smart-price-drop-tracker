/** Tata CLiQ specific selectors. */
(function (root) {
  'use strict';
  root.SPT = root.SPT || {};
  root.SPT.Extractors = root.SPT.Extractors || {};

  function externalId(url) {
    var utils = root.SPT.UrlUtils;
    return utils ? utils.externalIdFor(url, 'tatacliq') : '';
  }

  root.SPT.Extractors.tatacliq = {
    id: 'tatacliq',
    name: 'Tata CLiQ',
    currency: 'INR',
    priceSelectors: [
      { selector: '[class*="ProductDetailsHeader__Price"]', confidence: 0.94 },
      { selector: '.selling-price', confidence: 0.92 },
      { selector: '.product-price', confidence: 0.9 },
      { selector: '.pdp-price', confidence: 0.88 },
      { selector: '[class*="price"]', confidence: 0.8 }
    ],
    originalPriceSelectors: [
      '[class*="ProductDetailsHeader__Mrp"]',
      '.list-price',
      '.mrp',
      '[class*="strike"]'
    ],
    titleSelectors: [
      '[class*="ProductDetailsHeader__Title"]',
      '.product-title',
      'h1',
      'meta[property="og:title"]'
    ],
    imageSelectors: [
      '[class*="ProductImage"] img',
      '.product-image img',
      'img[src*="tatacliq"]',
      'meta[property="og:image"]'
    ],
    availabilitySelectors: [
      '.out-of-stock',
      '[class*="stock"]',
      '[class*="availability"]'
    ],
    getExternalId: externalId
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
