'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpt } = require('./helpers');

const SPT = createSpt();
const C = SPT.SiteCatalog;

test('detects every supported Indian retailer', () => {
  const cases = [
    ['https://www.amazon.in/dp/B09Y2MYL5C', 'amazon', 'Amazon India'],
    ['https://www.flipkart.com/item/p/itm123?pid=ABC123', 'flipkart', 'Flipkart'],
    ['https://www.myntra.com/shirt/12345678', 'myntra', 'Myntra'],
    ['https://www.ajio.com/p/abc123', 'ajio', 'AJIO'],
    ['https://www.croma.com/p/123456', 'croma', 'Croma'],
    ['https://www.reliancedigital.in/product/abc123', 'reliance', 'Reliance Digital'],
    ['https://www.tatacliq.com/p/abc123', 'tatacliq', 'Tata CLiQ'],
    ['https://www.meesho.com/p/abc123', 'meesho', 'Meesho']
  ];
  for (const [url, id, name] of cases) {
    const store = C.detect(url);
    assert.equal(store.id, id, url);
    assert.equal(store.name, name, url);
    assert.equal(store.known, true, url);
    assert.equal(store.currency, 'INR', url);
  }
});

test('recognizes retailer subdomains but not lookalike domains', () => {
  assert.equal(C.detect('https://smile.amazon.in/dp/B09Y2MYL5C').id, 'amazon');
  assert.equal(C.detect('https://m.flipkart.com/item/p/itm123').id, 'flipkart');
  assert.equal(C.detect('https://amazon.in.evil.example/dp/B09Y2MYL5C').known, false);
  assert.equal(C.detect('https://notamazon.in/dp/B09Y2MYL5C').known, false);
});

test('unknown stores fall back to a generic, usable store', () => {
  const store = C.detect('https://shop.example.com/products/backpack');
  assert.equal(store.id, 'generic');
  assert.equal(store.name, 'shop.example.com');
  assert.equal(store.hostname, 'shop.example.com');
  assert.equal(store.known, false);
  assert.equal(store.supported, true);
  assert.equal(store.currency, 'INR');
  assert.equal(C.detect('not a url'), null);
});

test('getById returns catalog entries and a generic fallback', () => {
  assert.equal(C.getById('amazon').name, 'Amazon India');
  assert.equal(C.getById('meesho').name, 'Meesho');
  const fallback = C.getById('unknown');
  assert.equal(fallback.id, 'generic');
  assert.equal(fallback.supported, true);
  assert.equal(C.all().length, 8);
});

test('permission origins are exact to the product host', () => {
  assert.equal(C.permissionOriginsFor('https://www.amazon.in/dp/B09Y2MYL5C').join(','), 'https://www.amazon.in/*');
  assert.equal(C.permissionOriginsFor('not a url').length, 0);
  assert.equal(C.isKnownStore('https://www.croma.com/p/123456'), true);
  assert.equal(C.isKnownStore('https://shop.example.com/products/1'), false);
});
