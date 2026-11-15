/** Myntra specific selectors. */
(function (root) {
  'use strict';
  root.SPT = root.SPT || {};
  root.SPT.Extractors = root.SPT.Extractors || {};

  function externalId(url) {
    var utils = root.SPT.UrlUtils;
    return utils ? utils.externalIdFor(url, 'myntra') : '';
  }

  root.SPT.Extractors.myntra = {
    id: 'myntra',
    name: 'Myntra',
    currency: 'INR',
    priceSelectors: [
      { selector: '.pdp-price strong', confidence: 0.95 },
      { selector: '.pdp-price', confidence: 0.93 },
      { selector: '.pdp-discountedPrice', confidence: 0.92 },
      { selector: '.product-discountedPrice', confidence: 0.91 },
      { selector: '[class*="pdp-price"]', confidence: 0.88 }
    ],
    originalPriceSelectors: [
      '.pdp-mrp s',
      '.pdp-mrp',
      '.pdp-price s',
      '[class*="pdp-mrp"]'
    ],
    titleSelectors: [
      '.pdp-title',
      '.pdp-name',
      'h1.pdp-title',
      'meta[property="og:title"]'
    ],
    imageSelectors: [
      '.pdp-image img',
      '.image-grid-image',
      'img[src*="myntassets"]',
      'meta[property="og:image"]'
    ],
    availabilitySelectors: [
      '.pdp-add-to-bag',
      '.size-selector',
      '[class*="out-of-stock"]'
    ],
    getExternalId: externalId
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
