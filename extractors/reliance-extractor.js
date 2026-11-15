/** Reliance Digital specific selectors. */
(function (root) {
  'use strict';
  root.SPT = root.SPT || {};
  root.SPT.Extractors = root.SPT.Extractors || {};

  function externalId(url) {
    var utils = root.SPT.UrlUtils;
    return utils ? utils.externalIdFor(url, 'reliance') : '';
  }

  root.SPT.Extractors.reliance = {
    id: 'reliance',
    name: 'Reliance Digital',
    currency: 'INR',
    priceSelectors: [
      { selector: '.pdp__offerPrice', confidence: 0.95 },
      { selector: '#pdp__offerPrice', confidence: 0.94 },
      { selector: '.pdp__price', confidence: 0.9 },
      { selector: '[class*="offerPrice"]', confidence: 0.88 },
      { selector: '.product-price .price', confidence: 0.84 }
    ],
    originalPriceSelectors: [
      '.pdp__mrpPrice',
      '[class*="mrpPrice"]',
      '.mrp-price',
      '.pdp__mrp'
    ],
    titleSelectors: [
      '.pdp__title',
      'h1.pdp__title',
      '.product-title',
      'h1',
      'meta[property="og:title"]'
    ],
    imageSelectors: [
      '.pdp__image img',
      '.product-image img',
      'img[src*="reliancedigital"]',
      'meta[property="og:image"]'
    ],
    availabilitySelectors: [
      '.pdp__stock',
      '.out-of-stock',
      '[class*="stock"]'
    ],
    getExternalId: externalId
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
