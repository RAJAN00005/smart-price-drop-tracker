'use strict';

/**
 * Loads the extension's classic IIFE modules into an isolated VM context.
 * This mirrors how Chrome loads the same files in extension pages, the
 * service worker and injected extractor frames (globalThis.SPT).
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');

const CORE_FILES = [
  'utils/date-utils.js',
  'utils/price-parser.js',
  'utils/url-normalizer.js',
  'utils/validation.js',
  'utils/site-catalog.js',
  'storage/data-model.js'
];

function createSpt(extraFiles) {
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    crypto: webcrypto
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  const files = CORE_FILES.concat(extraFiles || []);
  for (const file of files) {
    const absolute = path.join(ROOT, file);
    const code = fs.readFileSync(absolute, 'utf8');
    vm.runInContext(code, context, { filename: file });
  }
  return context.SPT;
}

function readFixture(name) {
  return fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', name), 'utf8');
}

function loadExtractors() {
  return createSpt([
    'extractors/extractor-core.js',
    'extractors/generic-extractor.js',
    'extractors/amazon-extractor.js',
    'extractors/flipkart-extractor.js',
    'extractors/myntra-extractor.js',
    'extractors/ajio-extractor.js',
    'extractors/croma-extractor.js',
    'extractors/reliance-extractor.js',
    'extractors/tata-cliq-extractor.js',
    'extractors/meesho-extractor.js',
    'extractors/extractor-registry.js'
  ]);
}

module.exports = {
  ROOT,
  createSpt,
  readFixture,
  loadExtractors
};
