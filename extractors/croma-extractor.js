/** Croma specific selectors. */
(function (root) {
  'use strict';
  root.SPT = root.SPT || {};
  root.SPT.Extractors = root.SPT.Extractors || {};

  function externalId(url) {
    var utils = root.SPT.UrlUtils;
    return utils ? utils.externalIdFor(url, 'croma') : '';
  }

  root.SPT.Extractors.croma = {
    id: 'croma',
    name: 'Croma',
    currency: 'INR',
    priceSelectors: [
      { selector: '.pdp-product-price .amount', confidence: 0.95 },
      { selector: '.pdp-product-price', confidence: 0.93 },
      { selector: '.new-price', confidence: 0.9 },
      { selector: '.product-price .amount', confidence: 0.88 },
      { selector: '[class*="pdp"] [class*="price"] .amount', confidence: 0.84 }
    ],
    originalPriceSelectors: [
      '.pdp-product-price .old-price',
      '.old-price',
      '.price-old',
      '.mrp'
    ],
    titleSelectors: [
      'h1.pdp-title',
      '.pdp-title',
      '.product-title',
      'h1',
      'meta[property="og:title"]'
    ],
    imageSelectors: [
      '.pdp-image img',
      '.product-image img',
      '.carousel img',
      'meta[property="og:image"]'
    ],
    availabilitySelectors: [
      '.pdp-add-to-cart',
      '.out-of-stock',
      '[class*="stock"]'
    ],
    getExternalId: externalId
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
