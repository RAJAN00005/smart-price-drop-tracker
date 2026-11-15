/**
 * Smart price extraction engine.
 *
 * Strategies are evaluated independently and scored. Structured data is
 * preferred over raw DOM scraping, and conflicting high-confidence prices are
 * surfaced to the user instead of being silently saved.
 */
(function (root) {
  'use strict';

  var P = root.SPT.PriceParser;
  var V = root.SPT.Validation;
  var U = root.SPT.UrlUtils;
  var C = root.SPT.SiteCatalog;

  var PRICE_ACCEPT_THRESHOLD = 0.72;
  var CONFLICT_DELTA = 0.04;
  // Parsed HTML (for example from an offscreen fetch) has no layout, so the
  // normal getComputedStyle/getClientRects visibility test cannot be used.
  var parsedDocument = false;

  function qsa(scope, selector, limit) {
    if (!scope || !selector) return [];
    try {
      var all = scope.querySelectorAll(selector);
      var out = [];
      for (var i = 0; i < all.length && out.length < (limit || 20); i++) out.push(all[i]);
      return out;
    } catch (_) {
      return [];
    }
  }

  function qs(scope, selector) {
    if (!scope || !selector) return null;
    try { return scope.querySelector(selector); } catch (_) { return null; }
  }

  function textOf(el, max) {
    if (!el) return '';
    var value = el.textContent || el.innerText || '';
    return P.cleanText(value).slice(0, max || 240);
  }

  function visible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden) return false;
    var tag = el.tagName;
    if (tag === 'META' || tag === 'LINK' || tag === 'SCRIPT' || tag === 'STYLE') return true;
    if (parsedDocument) {
      // Only explicit inline hiding is reliable without a rendered layout.
      try {
        var inline = el.style;
        if (inline && (inline.display === 'none' || inline.visibility === 'hidden' || inline.opacity === '0')) return false;
      } catch (_) { /* ignore */ }
      return true;
    }
    try {
      var style = window.getComputedStyle(el);
      if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      var rects = el.getClientRects();
      if (rects && rects.length === 0) return false;
    } catch (_) { /* ignore */ }
    return true;
  }

  function tokenString(el) {
    if (!el) return '';
    var classValue = '';
    try {
      classValue = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    } catch (_) { classValue = ''; }
    return [
      classValue,
      el.id || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('data-testid') || '',
      el.getAttribute('itemprop') || ''
    ].join(' ');
  }

  var NEGATIVE_RE = /(^|[\s_-])(mrp|m\.r\.p|old[\s_-]?price|list[\s_-]?price|was[\s_-]?price|strike[d]?|striked|compare[\s_-]?price|maximum[\s_-]?retail|emi|monthly|delivery|shipping|coupon|cashback|discount|tax|fee|savings?|you[\s_-]?save)([\s_-]|$)/i;

  function negativeContext(el) {
    if (!el) return false;
    var node = el;
    for (var i = 0; node && i < 4; i++) {
      if (node.tagName === 'DEL' || node.tagName === 'S' || node.tagName === 'STRIKE') return true;
      if (NEGATIVE_RE.test(tokenString(node))) return true;
      try {
        if (node.style && /line-through/i.test(node.style.textDecoration || '')) return true;
      } catch (_) { /* ignore */ }
      node = node.parentElement;
    }
    return false;
  }

  var POSITIVE_RE = /(selling|sale[\s_-]?price|current[\s_-]?price|final[\s_-]?price|offer[\s_-]?price|deal[\s_-]?price|discount[\s_-]?price|price[\s_-]?to[\s_-]?pay|special[\s_-]?price|lowest[\s_-]?price)/i;

  function positiveContext(el) {
    var node = el;
    for (var i = 0; node && i < 4; i++) {
      if (POSITIVE_RE.test(tokenString(node))) return true;
      node = node.parentElement;
    }
    return false;
  }

  var buyboxCache = new WeakMap();

  function insideBuybox(el) {
    var node = el;
    for (var depth = 0; node && depth < 6; depth++) {
      if (buyboxCache.has(node)) return buyboxCache.get(node);
      var controls = qsa(node, 'button, a, input[type="submit"], [role="button"]', 30);
      var found = false;
      for (var i = 0; i < controls.length; i++) {
        var label = (textOf(controls[i], 80) + ' ' + (controls[i].getAttribute('aria-label') || '')).toLowerCase();
        if (/add to (cart|bag|basket)|buy now|place order|add to trolley/.test(label)) {
          found = true;
          break;
        }
      }
      buyboxCache.set(node, found);
      if (found) return true;
      node = node.parentElement;
    }
    return false;
  }

  function nearHeading(el) {
    var node = el;
    for (var i = 0; node && i < 5; i++) {
      var heading = qs(node, 'h1');
      if (heading && heading.textContent && heading.textContent.trim().length > 2) return true;
      node = node.parentElement;
    }
    return false;
  }

  function parseNumericPrice(value, defaultCurrency, trusted) {
    if (typeof value === 'number') {
      var asPrice = V.asPrice(value);
      if (asPrice === null) return null;
      return { value: asPrice, currency: defaultCurrency || 'INR', raw: String(value), sourceValue: value };
    }
    if (value === null || value === undefined) return null;
    var text = P.cleanText(value);
    if (!text) return null;
    var parsed = P.parse(text, {
      allowBare: true,
      defaultCurrency: defaultCurrency || 'INR',
      trustedContext: trusted !== false
    });
    if (parsed) return parsed;
    var normalized = P.normalizeNumber(text);
    if (normalized !== null) return { value: normalized, currency: defaultCurrency || 'INR', raw: text };
    return null;
  }

  function metaContent(doc, key, attr) {
    var selector = 'meta[' + (attr || 'property') + '="' + key + '"]';
    var el = qs(doc, selector);
    return el ? (el.getAttribute('content') || '') : '';
  }

  function getCanonical(doc, pageUrl) {
    var link = qs(doc, 'link[rel="canonical"]');
    var href = link ? link.getAttribute('href') : '';
    if (!href) return '';
    var cleaned = U.cleanUrl(href, pageUrl);
    if (!cleaned) return '';
    try {
      if (new URL(cleaned).hostname !== new URL(pageUrl).hostname) return '';
    } catch (_) { return ''; }
    return cleaned;
  }

  function collectJsonLdNodes(doc) {
    var scripts = qsa(doc, 'script[type="application/ld+json"]', 20);
    var nodes = [];
    for (var i = 0; i < scripts.length; i++) {
      var raw = scripts[i].textContent || '';
      if (!raw || raw.length > 2000000) continue;
      raw = raw.trim().replace(/^\/\*[\s\S]*?\*\//, '').replace(/<!\[CDATA\[|\]\]>/g, '');
      if (!raw) continue;
      try {
        var data = JSON.parse(raw);
        flattenJsonLd(data, nodes);
      } catch (_) {
        // Invalid structured data is common; other strategies still run.
      }
    }
    return nodes;
  }

  function flattenJsonLd(node, out) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) flattenJsonLd(node[i], out);
      return;
    }
    if (typeof node !== 'object') return;
    if (node['@graph']) flattenJsonLd(node['@graph'], out);
    if (node['@type'] || node.offers || node.price) out.push(node);
    // Only descend into known container keys to avoid duplicate work.
    if (node.itemListElement) flattenJsonLd(node.itemListElement, out);
    if (node.hasVariant) flattenJsonLd(node.hasVariant, out);
  }

  function typeOf(node) {
    var type = node && node['@type'];
    if (Array.isArray(type)) return type.map(function (t) { return String(t).toLowerCase(); });
    return type ? [String(type).toLowerCase()] : [];
  }

  function isProductNode(node) {
    var types = typeOf(node);
    for (var i = 0; i < types.length; i++) {
      if (types[i].indexOf('product') !== -1) return true;
    }
    return false;
  }

  function scoreProductNode(node, pageUrl) {
    if (!node || typeof node !== 'object') return -1;
    var score = 0;
    if (isProductNode(node)) score += 3;
    if (node.offers) score += 4;
    if (node.name) score += 2;
    if (node.image) score += 1;
    if (node.url) {
      try {
        if (new URL(node.url, pageUrl).href.split('?')[0] === pageUrl.split('?')[0]) score += 3;
      } catch (_) { /* ignore */ }
    }
    if (Array.isArray(node.hasVariant) && node.hasVariant.length) score += 1;
    return score;
  }

  function bestProductNode(doc, pageUrl) {
    var nodes = collectJsonLdNodes(doc);
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < nodes.length; i++) {
      var score = scoreProductNode(nodes[i], pageUrl);
      if (score > bestScore) {
        bestScore = score;
        best = nodes[i];
      }
    }
    if (!best || bestScore < 2) {
      for (var j = 0; j < nodes.length; j++) {
        if (nodes[j].offers && nodes[j].name) {
          return nodes[j];
        }
      }
      return null;
    }
    // ProductGroup / variant selection: prefer the variant URL that matches.
    if (Array.isArray(best.hasVariant) && best.hasVariant.length) {
      var variant = null;
      for (var k = 0; k < best.hasVariant.length; k++) {
        var candidate = best.hasVariant[k];
        if (!candidate || typeof candidate !== 'object') continue;
        if (candidate.url) {
          try {
            if (new URL(candidate.url, pageUrl).href.split('?')[0] === pageUrl.split('?')[0]) {
              variant = candidate;
              break;
            }
          } catch (_) { /* ignore */ }
        }
      }
      if (!variant && best.hasVariant[0] && typeof best.hasVariant[0] === 'object') variant = best.hasVariant[0];
      if (variant) {
        variant = Object.assign({}, best, variant, {
          name: variant.name || best.name,
          image: variant.image || best.image,
          brand: variant.brand || best.brand
        });
        best = variant;
      }
    }
    return best;
  }

  function firstImage(value, pageUrl) {
    if (!value) return '';
    var list = Array.isArray(value) ? value : [value];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var raw = typeof item === 'string' ? item : (item && (item.url || item.contentUrl || item['@id']));
      var safe = U.safeImageUrl(raw, pageUrl);
      if (safe) return safe;
    }
    return '';
  }

  function flattenOffers(offers) {
    if (!offers) return [];
    var out = [];
    function walk(value) {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (typeof value !== 'object') return;
      out.push(value);
      if (value.offers) walk(value.offers);
    }
    walk(offers);
    return out;
  }

  function extractJsonLd(doc, pageUrl, defaultCurrency) {
    var node = bestProductNode(doc, pageUrl);
    if (!node) {
      return {
        candidates: [],
        title: '',
        image: '',
        availability: '',
        url: '',
        currency: defaultCurrency || 'INR',
        node: null
      };
    }

    var title = V.cleanText(node.name || '', V.LIMITS.MAX_TITLE);
    var image = firstImage(node.image, pageUrl);
    var availability = node.offers && !Array.isArray(node.offers) ? node.offers.availability : '';
    if (!availability) {
      var offs = flattenOffers(node.offers);
      if (offs.length) availability = offs[0].availability || '';
    }
    var nodeUrl = U.cleanUrl(node.url || '', pageUrl);
    var offers = flattenOffers(node.offers);
    var prices = [];
    var currency = defaultCurrency || 'INR';
    var ambiguous = false;
    var seen = {};

    for (var i = 0; i < offers.length; i++) {
      var offer = offers[i];
      var spec = offer.priceSpecification || {};
      var offerCurrency = offer.priceCurrency || spec.priceCurrency || currency;
      var rawPrice = offer.price !== undefined ? offer.price : (offer.lowPrice !== undefined ? offer.lowPrice : spec.price);
      if (rawPrice === undefined || rawPrice === null) continue;
      var parsed = parseNumericPrice(rawPrice, offerCurrency, true);
      if (!parsed) continue;
      var isAggregate = offer.lowPrice !== undefined && offer.highPrice !== undefined &&
        Number(offer.lowPrice) !== Number(offer.highPrice);
      var key = parsed.value + '|' + parsed.currency;
      if (seen[key]) continue;
      seen[key] = true;
      prices.push({
        price: parsed.value,
        currency: parsed.currency,
        source: isAggregate ? 'JSON-LD aggregate offer' : 'JSON-LD offer',
        confidence: isAggregate ? 0.78 : 0.91,
        ambiguous: isAggregate
      });
      currency = parsed.currency;
      if (isAggregate) ambiguous = true;
    }

    if (!prices.length && node.price !== undefined) {
      var direct = parseNumericPrice(node.price, node.priceCurrency || currency, true);
      if (direct) {
        prices.push({
          price: direct.value,
          currency: direct.currency,
          source: 'JSON-LD product price',
          confidence: 0.88,
          ambiguous: false
        });
        currency = direct.currency;
      }
    }

    if (prices.length > 1) {
      ambiguous = true;
      for (var p = 0; p < prices.length; p++) {
        if (prices[p].confidence > 0.82) prices[p].confidence = 0.82;
        prices[p].ambiguous = true;
      }
    }
    if (ambiguous && prices.length) prices[0].ambiguous = true;

    if (!availability && prices.length) {
      availability = offers[0] && offers[0].availability ? offers[0].availability : '';
    }

    return {
      candidates: prices.slice(0, 4),
      title: title,
      image: image,
      availability: availability || '',
      url: nodeUrl,
      currency: currency,
      node: node
    };
  }

  function microdataCurrency(doc, defaultCurrency) {
    var el = qs(doc, '[itemprop="priceCurrency"]');
    if (!el) return defaultCurrency;
    var value = el.getAttribute('content') || el.textContent || '';
    var code = value.trim().toUpperCase();
    return /^[A-Z]{3}$/.test(code) ? code : defaultCurrency;
  }

  function extractMicrodata(doc, defaultCurrency) {
    var candidates = [];
    var currency = microdataCurrency(doc, defaultCurrency);
    var elements = qsa(doc, '[itemprop="price"]', 8);
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (!visible(el) && el.tagName !== 'META') continue;
      if (negativeContext(el)) continue;
      var raw = el.getAttribute('content') || el.getAttribute('value') || el.textContent || '';
      if (!raw) continue;
      var parsed = parseNumericPrice(raw, currency, true);
      if (!parsed) continue;
      candidates.push({
        price: parsed.value,
        currency: parsed.currency,
        source: 'Schema.org microdata',
        confidence: 0.84,
        ambiguous: false
      });
      break;
    }
    return candidates;
  }

  function extractMetaPrices(doc, defaultCurrency) {
    var candidates = [];
    var currency = (metaContent(doc, 'product:price:currency') || metaContent(doc, 'og:price:currency') || defaultCurrency || 'INR').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) currency = defaultCurrency || 'INR';
    var defs = [
      ['product:price:amount', 0.9, 'property'],
      ['og:price:amount', 0.87, 'property'],
      ['product:sale_price:amount', 0.9, 'property'],
      ['price', 0.84, 'itemprop']
    ];
    for (var i = 0; i < defs.length; i++) {
      var meta = qs(doc, 'meta[' + defs[i][2] + '="' + defs[i][0] + '"]');
      if (!meta) continue;
      var raw = meta.getAttribute('content') || '';
      var parsed = parseNumericPrice(raw, currency, true);
      if (!parsed) continue;
      candidates.push({
        price: parsed.value,
        currency: parsed.currency,
        source: 'Meta tag ' + defs[i][0],
        confidence: defs[i][1],
        ambiguous: false
      });
    }
    return { candidates: candidates, currency: currency };
  }

  function extractMetaProduct(doc, pageUrl) {
    var title = V.cleanText(metaContent(doc, 'og:title') || metaContent(doc, 'twitter:title', 'name') || '', V.LIMITS.MAX_TITLE);
    var image = U.safeImageUrl(metaContent(doc, 'og:image') || metaContent(doc, 'twitter:image', 'name'), pageUrl);
    return { title: title, image: image };
  }

  function selectorEntries(adapter, key) {
    var raw = adapter && adapter[key];
    if (!raw) return [];
    if (!Array.isArray(raw)) raw = [raw];
    return raw.map(function (entry, index) {
      if (typeof entry === 'string') return { selector: entry, confidence: Math.max(0.84, 0.96 - index * 0.015) };
      return {
        selector: entry.selector,
        confidence: entry.confidence || Math.max(0.84, 0.96 - index * 0.015),
        scope: entry.scope || '',
        attr: entry.attr || '',
        allowHidden: entry.allowHidden === true,
        allowNegative: entry.allowNegative === true
      };
    }).filter(function (entry) { return !!entry.selector; });
  }

  function valueFromElement(el, entry) {
    if (!el) return '';
    if (entry.attr) return el.getAttribute(entry.attr) || '';
    var tag = el.tagName;
    if (tag === 'META') return el.getAttribute('content') || '';
    if (tag === 'INPUT') return el.getAttribute('value') || '';
    if (tag === 'TIME') return el.getAttribute('datetime') || el.textContent || '';
    return el.getAttribute('content') || el.getAttribute('data-price') || el.getAttribute('data-product-price') ||
      el.getAttribute('value') || el.textContent || '';
  }

  function adapterPrice(doc, adapter, defaultCurrency) {
    var entries = selectorEntries(adapter, 'priceSelectors');
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var scope = entry.scope ? qs(doc, entry.scope) : doc;
      if (!scope) continue;
      var elements = qsa(scope, entry.selector, 6);
      for (var j = 0; j < elements.length; j++) {
        var el = elements[j];
        if (!entry.allowHidden && !visible(el) && el.tagName !== 'META') continue;
        if (!entry.allowNegative && negativeContext(el)) continue;
        var raw = valueFromElement(el, entry);
        if (!raw) continue;
        var parsed = parseNumericPrice(raw, defaultCurrency, true);
        if (!parsed) continue;
        return {
          price: parsed.value,
          currency: parsed.currency,
          source: (adapter.name || 'retailer') + ' price selector',
          confidence: Math.min(0.98, entry.confidence || 0.96),
          ambiguous: false
        };
      }
    }
    return null;
  }

  function adapterText(doc, adapter, key, max) {
    var entries = selectorEntries(adapter, key);
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var scope = entry.scope ? qs(doc, entry.scope) : doc;
      if (!scope) continue;
      var el = qs(scope, entry.selector);
      if (!el) continue;
      var value = entry.attr ? el.getAttribute(entry.attr) : (el.getAttribute('content') || el.textContent || '');
      var clean = V.cleanText(value, max || V.LIMITS.MAX_TITLE);
      if (clean) return clean;
    }
    return '';
  }

  function adapterImage(doc, adapter, pageUrl) {
    var entries = selectorEntries(adapter, 'imageSelectors');
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var scope = entry.scope ? qs(doc, entry.scope) : doc;
      if (!scope) continue;
      var el = qs(scope, entry.selector);
      if (!el) continue;
      var image = imageFromElement(el, pageUrl);
      if (image) return image;
    }
    return '';
  }

  function imageFromElement(img, pageUrl) {
    if (!img) return '';
    var dynamic = img.getAttribute && img.getAttribute('data-a-dynamic-image');
    if (dynamic) {
      try {
        var map = JSON.parse(dynamic);
        var keys = Object.keys(map);
        var best = '';
        var bestArea = 0;
        for (var i = 0; i < keys.length; i++) {
          var dims = map[keys[i]];
          var area = Array.isArray(dims) ? Number(dims[0]) * Number(dims[1]) : 0;
          if (!best || area > bestArea) { best = keys[i]; bestArea = area; }
        }
        var safe = U.safeImageUrl(best, pageUrl);
        if (safe) return safe;
      } catch (_) { /* ignore */ }
    }
    var attrs = ['currentSrc', 'src', 'data-old-hires', 'data-src', 'data-lazy-src', 'data-original', 'content'];
    for (var a = 0; a < attrs.length; a++) {
      var value = attrs[a] === 'currentSrc' ? img.currentSrc : img.getAttribute(attrs[a]);
      var safeValue = U.safeImageUrl(value, pageUrl);
      if (safeValue) return safeValue;
    }
    var srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    if (srcset) {
      var bestUrl = '';
      var bestWidth = 0;
      var parts = srcset.split(',');
      for (var s = 0; s < parts.length; s++) {
        var bits = parts[s].trim().split(/\s+/);
        var width = parseInt(bits[1], 10) || 0;
        if (width >= bestWidth) { bestWidth = width; bestUrl = bits[0]; }
      }
      return U.safeImageUrl(bestUrl, pageUrl);
    }
    return '';
  }

  function extractGenericImage(doc, pageUrl) {
    var scopes = qsa(doc, 'main, [role="main"], #product, #dp, #centerCol, [class*="product-detail" i], [class*="pdp" i]', 5);
    var images = [];
    for (var i = 0; i < scopes.length; i++) {
      var found = qsa(scopes[i], 'img', 20);
      for (var j = 0; j < found.length; j++) images.push(found[j]);
    }
    if (!images.length) images = qsa(doc, 'img', 30);
    var bestUrl = '';
    var bestScore = -1;
    for (var k = 0; k < images.length; k++) {
      var img = images[k];
      var token = tokenString(img) + ' ' + (img.getAttribute('alt') || '');
      if (/icon|logo|sprite|avatar|badge|payment|flag|search/i.test(token)) continue;
      var width = parseInt(img.getAttribute('width'), 10) || 0;
      var height = parseInt(img.getAttribute('height'), 10) || 0;
      if (width && width < 120) continue;
      if (height && height < 120) continue;
      var url = imageFromElement(img, pageUrl);
      if (!url) continue;
      var score = 0;
      if (width >= 300 || height >= 300) score += 3;
      if (/product|large|zoom|gallery/i.test(token + ' ' + url)) score += 2;
      if (nearHeading(img)) score += 1;
      if (score > bestScore) { bestScore = score; bestUrl = url; }
    }
    return bestUrl;
  }

  function extractAdapterOriginal(doc, adapter, currentPrice, defaultCurrency) {
    var entries = selectorEntries(adapter, 'originalPriceSelectors');
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var scope = entry.scope ? qs(doc, entry.scope) : doc;
      if (!scope) continue;
      var elements = qsa(scope, entry.selector, 5);
      for (var j = 0; j < elements.length; j++) {
        var raw = valueFromElement(elements[j], entry);
        var parsed = parseNumericPrice(raw, defaultCurrency, true);
        if (!parsed) continue;
        if (parsed.value > currentPrice && parsed.value <= currentPrice * 100) return parsed.value;
      }
    }
    return null;
  }

  function extractGenericOriginal(doc, currentPrice, defaultCurrency) {
    var selectors = [
      'del', 's', 'strike',
      '[class*="mrp" i]', '[class*="old-price" i]', '[class*="oldprice" i]',
      '[class*="list-price" i]', '[class*="listprice" i]', '[class*="was-price" i]',
      '[class*="strike" i]', '[class*="compare-price" i]',
      '[style*="line-through"]'
    ];
    for (var s = 0; s < selectors.length; s++) {
      var elements = qsa(doc, selectors[s], 10);
      for (var i = 0; i < elements.length; i++) {
        var el = elements[i];
        if (!visible(el)) continue;
        var raw = el.getAttribute('content') || el.textContent || '';
        var parsed = parseNumericPrice(raw, defaultCurrency, true);
        if (!parsed) continue;
        if (parsed.value > currentPrice && parsed.value <= currentPrice * 100) return parsed.value;
      }
    }
    return null;
  }

  function detectAvailability(doc, adapter, jsonLdAvailability) {
    var fromAdapter = adapter ? adapterText(doc, adapter, 'availabilitySelectors', 160) : '';
    var candidates = [fromAdapter, jsonLdAvailability];
    var selectors = [
      '#availability', '#outOfStock', '#availability_feature_div',
      '[class*="availability" i]', '[class*="stock-status" i]', '[class*="stockstatus" i]',
      '[class*="out-of-stock" i]', '[class*="sold-out" i]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = qs(doc, selectors[i]);
      if (el && visible(el)) candidates.push(textOf(el, 160));
    }
    for (var c = 0; c < candidates.length; c++) {
      var text = P.cleanText(candidates[c] || '');
      if (!text) continue;
      if (/out of stock|sold out|currently unavailable|not available|notify me|temporarily unavailable/i.test(text)) return 'OutOfStock';
      if (/coming soon|pre[\s-]?order|preorder/i.test(text)) return 'PreOrder';
      if (/back[\s-]?order/i.test(text)) return 'BackOrder';
      if (/discontinued/i.test(text)) return 'Discontinued';
      if (/in stock|available|add to cart|buy now|add to bag/i.test(text)) return 'InStock';
    }
    var controls = qsa(doc, 'button, [role="button"], input[type="submit"]', 60);
    for (var a = 0; a < controls.length; a++) {
      if (!visible(controls[a])) continue;
      var label = (textOf(controls[a], 80) + ' ' + (controls[a].getAttribute('aria-label') || '')).toLowerCase();
      if (/add to (cart|bag|basket)|buy now|add to trolley|place order/.test(label)) return 'InStock';
      if (/notify me|sold out|out of stock/.test(label)) return 'OutOfStock';
    }
    return 'Unknown';
  }

  function cleanTitle(value) {
    var title = V.cleanText(value, V.LIMITS.MAX_TITLE);
    if (!title) return '';
    title = title.replace(/\s*[|–—]\s*/g, function (match) { return match; });
    return title.replace(/\s+/g, ' ').trim();
  }

  function stripStoreSuffix(title, store, hostname) {
    if (!title) return '';
    var separators = [' | ', ' – ', ' — ', ' - ', ' :: ', ' : '];
    for (var s = 0; s < separators.length; s++) {
      var index = title.lastIndexOf(separators[s]);
      if (index < 10) continue;
      var head = title.slice(0, index).trim();
      var tail = title.slice(index + separators[s].length).trim();
      var lowTail = tail.toLowerCase();
      var lowStore = (store || '').toLowerCase();
      var lowHost = (hostname || '').toLowerCase().replace(/^www\./, '');
      if (!tail) continue;
      if ((lowStore && lowTail.indexOf(lowStore) !== -1) || (lowHost && lowTail.indexOf(lowHost) !== -1) ||
          /online shopping|buy .* online|best price|free shipping|official store/.test(lowTail)) {
        return head;
      }
    }
    return title;
  }

  function validTitle(value, store, hostname) {
    var title = stripStoreSuffix(cleanTitle(value), store, hostname);
    if (!title || title.length < 3) return '';
    if (/^(amazon|flipkart|myntra|ajio|croma|meesho|online store|home|shop)$/i.test(title)) return '';
    if (/robot check|access denied|just a moment|attention required|security check|captcha|verify you are human/i.test(title)) return '';
    return title;
  }

  function detectBlocking(doc) {
    var title = (doc.title || '') + ' ' + (qs(doc, 'h1') ? textOf(qs(doc, 'h1'), 200) : '');
    if (/robot check|access denied|just a moment|attention required|security check|verify you are human|are you a robot|captcha/i.test(title)) {
      return { code: 'CAPTCHA', message: V.ERROR_MESSAGES.CAPTCHA, blocked: true };
    }
    var body = doc.body ? (doc.body.innerText || doc.body.textContent || '') : '';
    var sample = body.slice(0, 40000);
    if (/enter the characters you see below|type the characters you see|unusual traffic from your computer|automated access|verify you are human|are you a robot/i.test(sample)) {
      var isCaptcha = /characters you see|captcha|verify you are human|are you a robot/i.test(sample);
      return {
        code: isCaptcha ? 'CAPTCHA' : 'BLOCKED',
        message: isCaptcha ? V.ERROR_MESSAGES.CAPTCHA : V.ERROR_MESSAGES.BLOCKED,
        blocked: true
      };
    }
    var captchaEls = qsa(doc, 'form[action*="captcha" i], input[name*="captcha" i], iframe[src*="captcha" i], #captcha, [class*="captcha" i]', 4);
    for (var i = 0; i < captchaEls.length; i++) {
      if (visible(captchaEls[i])) {
        return { code: 'CAPTCHA', message: V.ERROR_MESSAGES.CAPTCHA, blocked: true };
      }
    }
    return null;
  }

  function addCandidate(list, candidate) {
    if (!candidate || !P.isPlausible(candidate.price)) return;
    candidate.currency = V.normalizeCurrency(candidate.currency, 'INR');
    candidate.confidence = Math.min(0.99, Math.max(0, Number(candidate.confidence) || 0));
    list.push(candidate);
  }

  function elementPrice(el, defaultCurrency, trusted) {
    var raw = valueFromElement(el, {});
    if (!raw) return null;
    if (/^\s*$/.test(raw)) return null;
    var parsed = P.parse(raw, {
      allowBare: true,
      defaultCurrency: defaultCurrency,
      trustedContext: trusted === true
    });
    if (parsed) return parsed;
    return null;
  }

  function genericDomCandidates(doc, defaultCurrency) {
    var selectors = [
      ['[data-testid*="price" i]', 0.78],
      ['[data-price]', 0.76],
      ['[class*="selling-price" i]', 0.78],
      ['[class*="sale-price" i]', 0.76],
      ['[class*="current-price" i]', 0.76],
      ['[class*="offer-price" i]', 0.74],
      ['[class*="final-price" i]', 0.74],
      ['[class*="discounted-price" i]', 0.73],
      ['[class*="product-price" i]', 0.7],
      ['[id*="price" i]', 0.68],
      ['[class*="price" i]', 0.62]
    ];
    var out = [];
    var seenEls = new Set();
    var total = 0;
    for (var s = 0; s < selectors.length && total < 80; s++) {
      var elements = qsa(doc, selectors[s][0], 10);
      for (var i = 0; i < elements.length && total < 80; i++) {
        var el = elements[i];
        if (seenEls.has(el)) continue;
        seenEls.add(el);
        total++;
        if (!visible(el)) continue;
        if (negativeContext(el)) continue;
        var text = textOf(el, 120);
        if (!text || text.length > 90) continue;
        var parsed = elementPrice(el, defaultCurrency, false);
        if (!parsed) continue;
        var mentions = P.extractMentions(text, { defaultCurrency: defaultCurrency, maxCandidates: 4 });
        var distinct = {};
        for (var m = 0; m < mentions.length; m++) distinct[mentions[m].value] = true;
        var ambiguity = Object.keys(distinct).length > 1;
        var confidence = selectors[s][1];
        if (insideBuybox(el)) confidence += 0.06;
        if (nearHeading(el)) confidence += 0.03;
        if (positiveContext(el)) confidence += 0.035;
        if (ambiguity) confidence = Math.min(confidence, 0.6);
        addCandidate(out, {
          price: parsed.value,
          currency: parsed.currency,
          source: 'Generic DOM price (' + selectors[s][0] + ')',
          confidence: Math.min(0.86, confidence),
          ambiguous: ambiguity
        });
        if (out.length >= 3) return out;
      }
    }
    return out;
  }

  function pageFallbackCandidates(doc, defaultCurrency, title) {
    var body = doc.body ? (doc.body.innerText || '') : '';
    if (!body) return [];
    var mentions = P.extractMentions(body.slice(0, 120000), { defaultCurrency: defaultCurrency, maxCandidates: 20 });
    if (!mentions.length) return [];
    var grouped = {};
    for (var i = 0; i < mentions.length; i++) {
      var mention = mentions[i];
      if (P.rejectionContext(mention.context)) continue;
      if (!grouped[mention.value]) grouped[mention.value] = { count: 0, context: mention.context, currency: mention.currency, index: mention.index };
      grouped[mention.value].count++;
    }
    var values = Object.keys(grouped);
    if (!values.length) return [];
    var nearBuy = '';
    for (var v = 0; v < values.length; v++) {
      if (/add to cart|buy now|add to bag/i.test(grouped[values[v]].context)) { nearBuy = values[v]; break; }
    }
    var chosen = nearBuy || values[0];
    var ambiguous = values.length > 1;
    var confidence = ambiguous ? 0.42 : 0.6;
    if (nearBuy) confidence += 0.04;
    var source = 'Whole-page price text';
    if (title && grouped[chosen].context.indexOf(title.slice(0, 20)) !== -1) confidence += 0.02;
    return [{
      price: Number(chosen),
      currency: grouped[chosen].currency,
      source: source,
      confidence: confidence,
      ambiguous: ambiguous
    }];
  }

  function choosePrice(candidates, expectedCurrency) {
    var filtered = candidates.slice();
    if (expectedCurrency) {
      var matching = filtered.filter(function (c) { return c.currency === expectedCurrency; });
      if (matching.length) filtered = matching;
    }
    if (!filtered.length) return { top: null, candidates: [], conflicts: [], needsConfirmation: false };
    filtered.sort(function (a, b) {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.price - b.price;
    });
    var top = filtered[0];
    var mixedCurrency = filtered.filter(function (c) { return c.currency !== top.currency; });
    var relevant = filtered.filter(function (c) { return c.currency === top.currency && !mixedCurrency.length ||
      c.currency === top.currency; });
    var conflicts = [];
    var seenValues = {};
    for (var i = 0; i < relevant.length; i++) {
      var candidate = relevant[i];
      if (candidate.price === top.price) continue;
      if (candidate.confidence >= top.confidence - CONFLICT_DELTA) {
        conflicts.push(candidate);
      } else if (candidate.confidence >= 0.85) {
        var ratio = Math.max(candidate.price, top.price) / Math.max(1, Math.min(candidate.price, top.price));
        if (ratio >= 1.25) conflicts.push(candidate);
      }
      seenValues[candidate.price] = true;
    }
    if (top.price < 10 && relevant.some(function (c) { return c.price >= 100 && c.confidence >= 0.8; })) {
      conflicts = conflicts.concat(relevant.filter(function (c) { return c.price >= 100 && c.confidence >= 0.8; }));
    }
    var uniqueConflicts = [];
    var seenConflict = {};
    for (var c = 0; c < conflicts.length; c++) {
      var key = conflicts[c].price + '|' + conflicts[c].currency;
      if (seenConflict[key]) continue;
      seenConflict[key] = true;
      uniqueConflicts.push(conflicts[c]);
    }
    var needsConfirmation = !!top.ambiguous || top.confidence < PRICE_ACCEPT_THRESHOLD || uniqueConflicts.length > 0;
    return { top: top, candidates: filtered.slice(0, 6), conflicts: uniqueConflicts.slice(0, 4), needsConfirmation: needsConfirmation };
  }

  function chooseTitle(doc, adapter, jsonLd, meta, store, hostname, pageUrl) {
    var candidates = [];
    var adapterTitle = adapter ? adapterText(doc, adapter, 'titleSelectors', V.LIMITS.MAX_TITLE) : '';
    if (adapterTitle) candidates.push({ title: adapterTitle, source: 'Site-specific title', confidence: 0.96 });
    if (jsonLd.title) candidates.push({ title: jsonLd.title, source: 'JSON-LD name', confidence: 0.93 });
    if (meta.title) candidates.push({ title: meta.title, source: 'Open Graph title', confidence: 0.84 });
    var h1 = qs(doc, 'h1');
    if (h1) candidates.push({ title: textOf(h1, V.LIMITS.MAX_TITLE), source: 'Page heading', confidence: 0.8 });
    var docTitle = doc.title || '';
    if (docTitle) {
      var cleanedDoc = docTitle.replace(/^buy\s+/i, '');
      candidates.push({ title: cleanedDoc, source: 'Document title', confidence: 0.6 });
    }
    candidates.sort(function (a, b) { return b.confidence - a.confidence; });
    for (var i = 0; i < candidates.length; i++) {
      var valid = validTitle(candidates[i].title, store, hostname);
      if (valid) return { title: valid, source: candidates[i].source, confidence: candidates[i].confidence };
    }
    return { title: '', source: '', confidence: 0 };
  }

  function chooseImage(doc, adapter, jsonLd, meta, pageUrl) {
    if (jsonLd.image) return { image: jsonLd.image, source: 'JSON-LD image' };
    var adapterImg = adapter ? adapterImage(doc, adapter, pageUrl) : '';
    if (adapterImg) return { image: adapterImg, source: 'Site-specific image' };
    if (meta.image) return { image: meta.image, source: 'Open Graph image' };
    var generic = extractGenericImage(doc, pageUrl);
    if (generic) return { image: generic, source: 'Product image' };
    return { image: '', source: '' };
  }

  function extract(doc, pageUrl, options) {
    var opts = options || {};
    var previous = parsedDocument;
    parsedDocument = opts.parsed === true;
    try {
      return extractInternal(doc, pageUrl, opts);
    } finally {
      parsedDocument = previous;
    }
  }

  function extractInternal(doc, pageUrl, options) {
    var started = Date.now();
    doc = doc || document;
    pageUrl = pageUrl || (doc.location && doc.location.href) || '';
    var opts = options || {};
    var store = C.detect(pageUrl) || { id: 'generic', name: U.hostLabel(pageUrl), currency: 'INR', known: false };
    var registry = root.SPT.ExtractorRegistry;
    var adapter = registry ? registry.getAdapter(store.id) : null;
    var url = U.cleanUrl(pageUrl) || pageUrl;
    var defaultCurrency = store.currency || 'INR';
    var blocking = detectBlocking(doc);

    var jsonLd = extractJsonLd(doc, pageUrl, defaultCurrency);
    var meta = extractMetaProduct(doc, pageUrl);
    var metaPrices = extractMetaPrices(doc, defaultCurrency);
    var titleInfo = chooseTitle(doc, adapter, jsonLd, meta, store.name, store.hostname, pageUrl);
    var imageInfo = chooseImage(doc, adapter, jsonLd, meta, pageUrl);

    if (blocking) {
      return {
        found: false,
        blocked: true,
        error: { code: blocking.code, message: blocking.message },
        title: titleInfo.title,
        image: imageInfo.image,
        price: null,
        originalPrice: null,
        currency: metaPrices.currency || defaultCurrency,
        url: url,
        canonicalUrl: getCanonical(doc, pageUrl),
        store: store.name,
        storeId: store.id,
        externalId: U.externalIdFor(url, store.id) || (adapter && adapter.getExternalId ? adapter.getExternalId(url) : ''),
        availability: 'Unknown',
        confidence: 0,
        source: '',
        needsConfirmation: false,
        candidates: [],
        issues: [blocking.code],
        diagnostics: { elapsedMs: Date.now() - started, adapter: store.id, pageTitle: V.cleanText(doc.title || '', 200) }
      };
    }

    var candidates = [];
    var adapterPriceCandidate = adapter ? adapterPrice(doc, adapter, defaultCurrency) : null;
    if (adapterPriceCandidate) addCandidate(candidates, adapterPriceCandidate);
    for (var j = 0; j < jsonLd.candidates.length; j++) {
      addCandidate(candidates, {
        price: jsonLd.candidates[j].price,
        currency: jsonLd.candidates[j].currency,
        source: jsonLd.candidates[j].source,
        confidence: jsonLd.candidates[j].confidence,
        ambiguous: jsonLd.candidates[j].ambiguous
      });
    }
    for (var m = 0; m < metaPrices.candidates.length; m++) addCandidate(candidates, metaPrices.candidates[m]);
    var microdata = extractMicrodata(doc, defaultCurrency);
    for (var md = 0; md < microdata.length; md++) addCandidate(candidates, microdata[md]);
    var generic = genericDomCandidates(doc, defaultCurrency);
    for (var g = 0; g < generic.length; g++) addCandidate(candidates, generic[g]);
    // Whole-page fallback only adds a confirmation-level candidate.
    var fallback = pageFallbackCandidates(doc, defaultCurrency, titleInfo.title);
    for (var f = 0; f < fallback.length; f++) addCandidate(candidates, fallback[f]);

    var expectedCurrency = store.known ? defaultCurrency : '';
    var selection = choosePrice(candidates, expectedCurrency);
    var top = selection.top;
    var originalPrice = null;
    var availability = detectAvailability(doc, adapter, jsonLd.availability);
    if (top) {
      originalPrice = adapter ? extractAdapterOriginal(doc, adapter, top.price, top.currency || defaultCurrency) : null;
      if (originalPrice === null) originalPrice = extractGenericOriginal(doc, top.price, top.currency || defaultCurrency);
    }

    var issues = [];
    if (!titleInfo.title) issues.push('TITLE_NOT_FOUND');
    if (!top) issues.push('PRICE_NOT_FOUND');

    var externalId = U.externalIdFor(url, store.id);
    if (!externalId && adapter && adapter.getExternalId) {
      try { externalId = adapter.getExternalId(url) || ''; } catch (_) { externalId = ''; }
    }

    return {
      found: !!top,
      blocked: false,
      error: top ? null : { code: 'PRICE_NOT_FOUND', message: V.ERROR_MESSAGES.PRICE_NOT_FOUND },
      title: titleInfo.title,
      image: imageInfo.image,
      price: top ? top.price : null,
      originalPrice: originalPrice,
      currency: top ? top.currency : (jsonLd.currency || metaPrices.currency || defaultCurrency),
      url: url,
      canonicalUrl: getCanonical(doc, pageUrl),
      store: store.name,
      storeId: store.id,
      externalId: externalId,
      availability: availability,
      confidence: top ? top.confidence : 0,
      source: top ? top.source : '',
      needsConfirmation: selection.needsConfirmation,
      candidates: selection.candidates.map(function (candidate) {
        return {
          price: candidate.price,
          currency: candidate.currency,
          source: candidate.source,
          confidence: Math.round(candidate.confidence * 100) / 100
        };
      }),
      conflicts: selection.conflicts.map(function (candidate) {
        return {
          price: candidate.price,
          currency: candidate.currency,
          source: candidate.source,
          confidence: Math.round(candidate.confidence * 100) / 100
        };
      }),
      issues: issues,
      titleSource: titleInfo.source,
      imageSource: imageInfo.source,
      diagnostics: {
        elapsedMs: Date.now() - started,
        adapter: store.id,
        pageTitle: V.cleanText(doc.title || '', 200),
        strategies: candidates.length,
        titleSource: titleInfo.source,
        needsConfirmation: selection.needsConfirmation
      }
    };
  }

  root.SPT = root.SPT || {};
  root.SPT.ExtractionEngine = {
    extract: extract,
    detectBlocking: detectBlocking,
    stripStoreSuffix: stripStoreSuffix,
    choosePrice: choosePrice,
    version: 1
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
