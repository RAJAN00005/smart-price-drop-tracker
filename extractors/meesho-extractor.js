/** Meesho specific selectors. Meesho uses generated class names, so generic and JSON-LD strategies matter. */
(function (root) {
  'use strict';
  root.SPT = root.SPT || {};
  root.SPT.Extractors = root.SPT.Extractors || {};

  function externalId(url) {
    var utils = root.SPT.UrlUtils;
    return utils ? utils.externalIdFor(url, 'meesho') : '';
  }

  root.SPT.Extractors.meesho = {
    id: 'meesho',
    name: 'Meesho',
    currency: 'INR',
    priceSelectors: [
      { selector: '[class*="ProductPrice"]', confidence: 0.9 },
      { selector: '[class*="product-price"]', confidence: 0.88 },
      { selector: '.product-price', confidence: 0.86 },
      { selector: '[class*="Price"] h4', confidence: 0.8 },
      { selector: 'h4', confidence: 0.72 }
    ],
    originalPriceSelectors: [
      '[class*="strikethrough"]',
      '[class*="oldPrice"]',
      '[class*="OldPrice"]',
      'del', 's', 'strike'
    ],
    titleSelectors: [
      '[class*="ProductTitle"]',
      '[class*="product-title"]',
      'h1',
      'meta[property="og:title"]'
    ],
    imageSelectors: [
      '[class*="ProductImage"] img',
      'img[src*="meesho"]',
      'meta[property="og:image"]'
    ],
    availabilitySelectors: [
      '[class*="OutOfStock"]',
      '[class*="out-of-stock"]',
      '[class*="sold-out"]'
    ],
    getExternalId: externalId
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
