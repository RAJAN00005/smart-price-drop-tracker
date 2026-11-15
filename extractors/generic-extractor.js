/** Generic retail adapter: semantic + common commerce selectors. */
(function (root) {
  'use strict';
  root.SPT = root.SPT || {};
  root.SPT.Extractors = root.SPT.Extractors || {};
  root.SPT.Extractors.generic = {
    id: 'generic',
    name: 'Generic store',
    currency: 'INR',
    priceSelectors: [
      '[itemprop="price"]',
      '[data-testid*="price" i]',
      '[data-price]',
      '[class*="selling-price" i]',
      '[class*="current-price" i]',
      '[class*="sale-price" i]',
      '[class*="product-price" i]'
    ],
    originalPriceSelectors: [
      '[class*="mrp" i]',
      '[class*="old-price" i]',
      '[class*="list-price" i]',
      'del', 's', 'strike'
    ],
    titleSelectors: ['h1', '[itemprop="name"]', 'meta[property="og:title"]'],
    imageSelectors: [
      'meta[property="og:image"]',
      '[class*="product"] img',
      '[class*="gallery"] img',
      'main img'
    ],
    availabilitySelectors: [
      '[class*="availability" i]',
      '[class*="stock" i]',
      '[class*="out-of-stock" i]'
    ]
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
