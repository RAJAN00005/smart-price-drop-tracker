'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpt } = require('./helpers');

const SPT = createSpt();
const U = SPT.UrlUtils;

test('cleanUrl removes tracking parameters but keeps product parameters', () => {
  assert.equal(
    U.cleanUrl('https://www.amazon.in/dp/B09Y2MYL5C?tag=abc&variant=red&utm_source=newsletter#reviews'),
    'https://www.amazon.in/dp/B09Y2MYL5C?variant=red'
  );
  assert.equal(
    U.cleanUrl('https://www.flipkart.com/item/p/itm123?pid=ABC123&affid=affiliate&utm_medium=cpc'),
    'https://www.flipkart.com/item/p/itm123?pid=ABC123'
  );
  assert.equal(
    U.cleanUrl('https://example.com/product?b=2&a=1'),
    'https://example.com/product?a=1&b=2'
  );
});

test('cleanUrl upgrades known retailers to HTTPS and strips fragments', () => {
  assert.equal(U.cleanUrl('http://www.flipkart.com/item/p/itm123'), 'https://www.flipkart.com/item/p/itm123');
  assert.equal(U.cleanUrl('https://example.com/product#details'), 'https://example.com/product');
  assert.equal(U.cleanUrl('https://example.com/'), 'https://example.com/');
});

test('cleanUrl rejects unsafe or unsupported URLs', () => {
  assert.equal(U.cleanUrl('javascript:alert(1)'), '');
  assert.equal(U.cleanUrl('data:text/html,hello'), '');
  assert.equal(U.cleanUrl('ftp://example.com/file'), '');
  assert.equal(U.cleanUrl('https://user:pass@example.com/product'), '');
  assert.equal(U.cleanUrl('not a url'), '');
  assert.equal(U.cleanUrl(''), '');
});

test('normalizedProductUrl is stable for duplicate detection', () => {
  assert.equal(
    U.normalizedProductUrl('https://www.amazon.in/Some-Product-Name/dp/B09Y2MYL5C/ref=sr_1_1?tag=abc'),
    'https://amazon.in/dp/B09Y2MYL5C'
  );
  assert.equal(
    U.normalizedProductUrl('https://www.flipkart.com/item/p/itm123?pid=ABC123&utm_source=x'),
    'https://flipkart.com/item/p/itm123?pid=abc123'
  );
  assert.equal(
    U.normalizedProductUrl('https://www.myntra.com/shirt/12345678?utm_source=x'),
    'https://myntra.com/shirt/12345678'
  );
  assert.equal(U.normalizedProductUrl('bad url'), '');
});

test('externalIdFor extracts retailer-specific identifiers', () => {
  assert.equal(U.externalIdFor('https://www.amazon.in/dp/B09Y2MYL5C', 'amazon'), 'B09Y2MYL5C');
  assert.equal(U.externalIdFor('https://www.amazon.in/gp/product/B0ABC12345?psc=1', 'amazon'), 'B0ABC12345');
  assert.equal(U.externalIdFor('https://www.flipkart.com/item/p/itm123?pid=ABC123', 'flipkart'), 'abc123');
  assert.equal(U.externalIdFor('https://www.myntra.com/shirt/12345678', 'myntra'), '12345678');
  assert.equal(U.externalIdFor('https://www.ajio.com/p/abc-123', 'ajio'), 'abc-123');
  assert.equal(U.externalIdFor('https://www.croma.com/p/123456', 'croma'), '123456');
  assert.equal(U.externalIdFor('https://www.reliancedigital.in/product/abc123', 'reliance'), 'abc123');
  assert.equal(U.externalIdFor('https://www.tatacliq.com/p/abc123', 'tatacliq'), 'abc123');
  assert.equal(U.externalIdFor('https://www.meesho.com/p/abc123', 'meesho'), 'abc123');
  assert.equal(U.externalIdFor('https://example.com/product', 'generic'), '');
});

test('origin and host helpers never expose credentials or paths', () => {
  assert.equal(U.originPattern('https://www.amazon.in/dp/B09Y2MYL5C?tag=x'), 'https://www.amazon.in/*');
  assert.equal(U.getOrigin('https://www.amazon.in/dp/B09Y2MYL5C'), 'https://www.amazon.in');
  assert.equal(U.hostLabel('https://www.amazon.in/dp/B09Y2MYL5C'), 'amazon.in');
  assert.equal(U.hostLabel('bad url'), 'Unknown store');
  assert.equal(U.sameOrigin('https://a.example.com/x', 'https://a.example.com/y'), true);
  assert.equal(U.sameOrigin('https://a.example.com/x', 'https://b.example.com/y'), false);
});

test('safeImageUrl only accepts http(s) image URLs', () => {
  assert.equal(U.safeImageUrl('//cdn.example.com/image.jpg', 'https://example.com'), 'https://cdn.example.com/image.jpg');
  assert.equal(U.safeImageUrl('/images/product.jpg', 'https://example.com/product'), 'https://example.com/images/product.jpg');
  assert.equal(U.safeImageUrl('javascript:alert(1)', 'https://example.com'), '');
  assert.equal(U.safeImageUrl('data:image/png;base64,AAAA', 'https://example.com'), '');
  assert.equal(U.safeImageUrl('', 'https://example.com'), '');
});

test('tracking parameter detection covers common affiliate keys', () => {
  assert.equal(U.isTrackingParam('utm_source'), true);
  assert.equal(U.isTrackingParam('gclid'), true);
  assert.equal(U.isTrackingParam('affid'), true);
  assert.equal(U.isTrackingParam('pid'), false);
  assert.equal(U.isTrackingParam('variant'), false);
  assert.equal(U.isKnownStoreHost('www.amazon.in'), true);
  assert.equal(U.isKnownStoreHost('shop.example.com'), false);
  assert.equal(U.isSupportedProductUrl('https://example.com/product'), true);
  assert.equal(U.isSupportedProductUrl('chrome://extensions'), false);
});
