/** Amazon India specific selectors. Structured data and generic fallbacks still run. */
(function (root) {
  'use strict';
  root.SPT = root.SPT || {};
  root.SPT.Extractors = root.SPT.Extractors || {};

  function externalId(url) {
    var utils = root.SPT.UrlUtils;
    return utils ? utils.externalIdFor(url, 'amazon') : '';
  }

  root.SPT.Extractors.amazon = {
    id: 'amazon',
    name: 'Amazon India',
    currency: 'INR',
    priceSelectors: [
      // Current Amazon layout: the visible amount lives in .priceToPay while
      // its .a-offscreen sibling can be empty. Read the visible container.
      { selector: '#corePriceDisplay_desktop_feature_div .priceToPay', confidence: 0.97 },
      { selector: '#corePrice_feature_div .priceToPay', confidence: 0.97 },
      // Accessible .a-offscreen text is often opacity:0 on live pages. It is
      // still the correct selling price, so allow hidden matches for these.
      { selector: '#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price) .a-offscreen', confidence: 0.96, allowHidden: true },
      { selector: '#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen', confidence: 0.96, allowHidden: true },
      { selector: '#corePrice_feature_div .a-price .a-offscreen', confidence: 0.94 },
      { selector: '.priceToPay', confidence: 0.94 },
      { selector: '#priceblock_dealprice', confidence: 0.94 },
      { selector: '#priceblock_ourprice', confidence: 0.93 },
      { selector: '#priceblock_saleprice', confidence: 0.93 },
      { selector: '#price_inside_buybox', confidence: 0.92 },
      { selector: '#newBuyBoxPrice', confidence: 0.92 },
      { selector: '#buybox .a-price:not(.a-text-price) .a-offscreen', confidence: 0.9, allowHidden: true },
      { selector: '#centerCol .a-price[data-a-color="price"] .a-offscreen', confidence: 0.86, allowHidden: true },
      { selector: '#tp_price_block_total_price_ww .a-offscreen', confidence: 0.85, allowHidden: true }
    ],
    originalPriceSelectors: [
      '#corePriceDisplay_desktop_feature_div .apex-basisprice-value',
      '#corePriceDisplay_desktop_feature_div .apex-basisprice-offscreen-label',
      '.apex-basisprice-value',
      '.apex-basisprice-offscreen-label',
      '#corePrice_feature_div .a-text-price .a-offscreen',
      '#corePriceDisplay_desktop_feature_div .a-text-price .a-offscreen',
      '.basisPrice .a-offscreen',
      '#priceblock_listprice',
      '#listPrice',
      '.a-text-price .a-offscreen'
    ],
    titleSelectors: [
      '#productTitle',
      '#title',
      'h1[data-hook="product-title"]',
      'meta[property="og:title"]'
    ],
    imageSelectors: [
      '#landingImage',
      '#imgTagWrapperId img',
      '#main-image-container img',
      '#ebooksImgBlkFront',
      'meta[property="og:image"]'
    ],
    availabilitySelectors: [
      '#availability',
      '#availability_feature_div',
      '#outOfStock'
    ],
    getExternalId: externalId
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
