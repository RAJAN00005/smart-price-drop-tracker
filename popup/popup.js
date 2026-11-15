/**
 * Smart Price Drop Tracker — popup controller.
 *
 * The popup only reads the current page after the user opens it (activeTab).
 * Every mutation is sent to the service worker so storage stays serialized.
 */
(function (root) {
  'use strict';

  var SPT = root.SPT;
  var V = SPT.Validation;
  var D = SPT.DateUtils;
  var P = SPT.PriceParser;
  var U = SPT.UrlUtils;
  var C = SPT.SiteCatalog;
  var Storage = SPT.StorageManager;
  var Client = SPT.ExtractionClient;
  var DM = SPT.DataModel;

  var CONFIRM_THRESHOLD = 0.72;
  var GOOD_THRESHOLD = 0.88;

  var state = {
    settings: DM.defaultSettings(),
    tab: null,
    tabUrl: '',
    store: null,
    extraction: null,
    detectionUrl: '',
    currentProduct: null,
    pagePrice: null,
    pageExtraction: null,
    busy: false,
    initialised: false
  };

  var el = {};

  function $(id) {
    return document.getElementById(id);
  }

  function cacheElements() {
    [
      'app-main', 'loading-view', 'detection-view', 'tracked-view', 'unsupported-view',
      'open-dashboard-btn', 'footer-dashboard-btn',
      'store-avatar', 'store-name', 'confidence-chip', 'confidence-note', 'confidence-detail',
      'candidate-list', 'product-image', 'image-fallback', 'product-title', 'product-url',
      'current-price', 'original-price', 'discount-chip', 'edit-price-btn', 'price-edit-block',
      'price-input', 'price-prefix', 'target-input', 'target-prefix', 'monitoring-toggle', 'track-btn',
      'tracked-status-chip', 'tracked-image', 'tracked-image-fallback', 'tracked-title',
      'tracked-store', 'tracked-current', 'tracked-original', 'tracked-target', 'tracked-lowest',
      'tracked-last-check', 'tracked-next-check', 'page-diff-note', 'page-diff-text',
      'tracked-update-block', 'tracked-price-input', 'tracked-price-prefix', 'save-price-btn',
      'cancel-price-btn', 'view-details-btn', 'update-price-btn', 'tracked-hint',
      'empty-title', 'empty-message', 'retry-btn', 'manual-toggle-btn', 'manual-form',
      'manual-title', 'manual-price', 'manual-price-prefix', 'manual-target', 'manual-target-prefix',
      'manual-monitoring', 'manual-submit-btn', 'manual-url-hint', 'toast-region'
    ].forEach(function (id) {
      el[id] = $(id);
    });
  }

  /* --------------------------------------------------------------------- */
  /* Small helpers                                                          */
  /* --------------------------------------------------------------------- */

  function setText(node, value) {
    if (node) node.textContent = value === null || value === undefined ? '' : String(value);
  }

  function show(node, visible) {
    if (node) node.hidden = !visible;
  }

  function formatPrice(value, currency) {
    return P.formatPrice(value, currency || 'INR', {
      currencyDisplay: state.settings.currencyDisplay || 'symbol'
    });
  }

  function plainAmount(value) {
    var amount = Number(value);
    if (!Number.isFinite(amount)) return '';
    try {
      return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(amount);
    } catch (_) {
      return String(amount);
    }
  }

  function currencyPrefix(currency) {
    var symbol = P.currencySymbol(currency || 'INR');
    return symbol.replace(/\s+$/, '');
  }

  function displayHost(url) {
    var host = U.hostLabel(url);
    try {
      var parsed = U.parseHttpUrl(url);
      var path = parsed ? parsed.pathname.replace(/\/+$/, '') : '';
      if (path && path !== '/') {
        var compact = decodeURIComponent(path);
        if (compact.length > 38) compact = compact.slice(0, 37) + '…';
        return host + compact;
      }
    } catch (_) { /* fall back to host */ }
    return host;
  }

  function shortSource(source) {
    var text = String(source || 'Detected price')
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > 30 ? text.slice(0, 29) + '…' : text;
  }

  function normalizeError(error, fallbackCode) {
    var code = error && error.code ? error.code : (fallbackCode || 'UNKNOWN');
    var message = V.userMessage(error, code);
    if (!message || message === V.ERROR_MESSAGES.UNKNOWN && V.ERROR_MESSAGES[code]) {
      message = V.ERROR_MESSAGES[code];
    }
    return { code: code, message: message, detail: error && (error.detail || error.details) };
  }

  function errorFromResponse(response) {
    if (response && response.error) {
      var error = new Error(response.error.message || V.ERROR_MESSAGES.UNKNOWN);
      error.code = response.error.code || 'UNKNOWN';
      return error;
    }
    return new Error(V.ERROR_MESSAGES.UNKNOWN);
  }

  function sendMessage(type, payload) {
    return new Promise(function (resolve, reject) {
      var message = Object.assign({ type: type }, payload || {});
      try {
        chrome.runtime.sendMessage(message, function (response) {
          var runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message || V.ERROR_MESSAGES.UNKNOWN));
            return;
          }
          if (!response) {
            reject(new Error('The extension background service did not respond.'));
            return;
          }
          if (response.ok === false) {
            reject(errorFromResponse(response));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function setAvatar(node, store) {
    if (!node) return;
    setText(node, store && store.initials ? store.initials : 'S');
    if (store && store.accent) node.style.background = store.accent;
  }

  function setProductImage(img, fallback, url, title, store) {
    if (!img || !fallback) return;
    var safe = U.safeImageUrl(url || '');
    setText(fallback, store && store.initials ? store.initials : 'S');
    if (store && store.accent) fallback.style.background = store.accent;
    show(fallback, !safe);
    img.classList.remove('is-broken');
    img.removeAttribute('src');
    img.alt = title ? String(title) : 'Product image';
    if (!safe) {
      img.hidden = true;
      return;
    }
    img.hidden = false;
    img.onload = function () {
      img.hidden = false;
      show(fallback, false);
    };
    img.onerror = function () {
      img.hidden = true;
      img.removeAttribute('src');
      show(fallback, true);
    };
    img.src = safe;
  }

  function showView(name) {
    show(el['loading-view'], name === 'loading');
    show(el['detection-view'], name === 'detection');
    show(el['tracked-view'], name === 'tracked');
    show(el['unsupported-view'], name === 'unsupported');
    if (el['app-main']) {
      el['app-main'].setAttribute('aria-busy', name === 'loading' ? 'true' : 'false');
    }
  }

  function setBusy(button, busy, busyLabel) {
    if (!button) return;
    if (busy) {
      if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      var spinner = document.createElement('span');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');
      button.replaceChildren(spinner, document.createTextNode(busyLabel || 'Working…'));
    } else {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = button.dataset.originalLabel || button.textContent;
      delete button.dataset.originalLabel;
    }
  }

  function markInvalid(input, invalid) {
    if (!input) return;
    input.classList.toggle('invalid', !!invalid);
    input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
  }

  function toast(message, type, timeout) {
    if (!el['toast-region'] || !message) return;
    var node = document.createElement('div');
    node.className = 'toast ' + (type || 'info');
    node.textContent = String(message);
    el['toast-region'].appendChild(node);
    var remove = function () {
      if (!node.isConnected) return;
      node.classList.add('is-leaving');
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 200);
    };
    node.addEventListener('click', remove);
    setTimeout(remove, timeout || 4200);
  }

  function openDashboard(hash) {
    var url = chrome.runtime.getURL('dashboard/dashboard.html') + (hash ? '#' + hash : '');
    try {
      chrome.tabs.create({ url: url });
    } catch (_) { /* ignore */ }
    window.close();
  }

  /* --------------------------------------------------------------------- */
  /* Store / confidence rendering                                           */
  /* --------------------------------------------------------------------- */

  function resolveStore(url, extraction) {
    var detected = C.detect(url) || C.getById('generic');
    if (detected.known) return detected;
    var name = extraction && extraction.store ? extraction.store : detected.name;
    return Object.assign({}, detected, {
      name: name || detected.name,
      currency: (extraction && extraction.currency) || detected.currency || 'INR'
    });
  }

  function renderStoreChip(store) {
    setText(el['store-name'], store && store.name ? store.name : 'Online store');
    setAvatar(el['store-avatar'], store);
    el['store-avatar'] && el['store-avatar'].setAttribute('title', store && store.hostname ? store.hostname : '');
  }

  function confidenceInfo(extraction) {
    var confidence = extraction && Number.isFinite(Number(extraction.confidence)) ? Number(extraction.confidence) : 0;
    var percent = Math.round(confidence * 100);
    if (!extraction || extraction.needsConfirmation || confidence < CONFIRM_THRESHOLD) {
      return { label: 'Needs review', className: 'warn', title: 'Detected price needs confirmation (' + percent + '% confidence)' };
    }
    if (confidence >= GOOD_THRESHOLD) {
      return { label: 'High confidence', className: 'good', title: 'Detected price looks trustworthy (' + percent + '% confidence)' };
    }
    return { label: 'Likely match', className: 'neutral', title: 'Detected price is probably correct (' + percent + '% confidence)' };
  }

  function renderConfidenceChip(extraction) {
    var chip = el['confidence-chip'];
    if (!chip) return;
    var info = confidenceInfo(extraction);
    chip.className = 'status-chip ' + info.className;
    chip.textContent = info.label;
    chip.title = info.title;
  }

  function renderCandidates(extraction, currency) {
    var list = el['candidate-list'];
    if (!list) return;
    list.replaceChildren();
    var candidates = extraction && Array.isArray(extraction.candidates) ? extraction.candidates : [];
    var seen = {};
    candidates.forEach(function (candidate) {
      if (!candidate || !Number.isFinite(Number(candidate.price))) return;
      var key = candidate.price + '|' + (candidate.currency || '');
      if (seen[key]) return;
      seen[key] = true;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'candidate-btn';
      button.title = 'Use ' + formatPrice(candidate.price, candidate.currency || currency) + ' from ' + (candidate.source || 'detected price');
      var price = document.createElement('strong');
      price.textContent = formatPrice(candidate.price, candidate.currency || currency);
      var source = document.createElement('small');
      source.textContent = shortSource(candidate.source);
      button.append(price, source);
      button.addEventListener('click', function () {
        if (!el['price-input']) return;
        el['price-input'].value = plainAmount(candidate.price);
        markInvalid(el['price-input'], false);
        setText(el['confidence-detail'], 'Selected ' + formatPrice(candidate.price, candidate.currency || currency) + '. Confirm to track this price.');
        el['price-input'].focus();
        el['price-input'].select();
      });
      list.appendChild(button);
    });
    show(list, list.childElementCount > 0);
  }

  /* --------------------------------------------------------------------- */
  /* Views                                                                  */
  /* --------------------------------------------------------------------- */

  function renderDetection(extraction, store) {
    state.extraction = extraction;
    state.store = store;
    state.detectionUrl = extraction.url;
    renderStoreChip(store);
    renderConfidenceChip(extraction);
    setProductImage(el['product-image'], el['image-fallback'], extraction.image, extraction.title, store);
    setText(el['product-title'], extraction.title);
    setText(el['product-url'], displayHost(extraction.url));
    el['product-url'] && el['product-url'].setAttribute('title', extraction.url);

    var currency = extraction.currency || store.currency || 'INR';
    setText(el['current-price'], formatPrice(extraction.price, currency));
    var original = Number(extraction.originalPrice);
    var discount = 0;
    if (Number.isFinite(original) && original > extraction.price) {
      setText(el['original-price'], formatPrice(original, currency));
      show(el['original-price'], true);
      discount = P.discountPercent(original, extraction.price);
    } else {
      show(el['original-price'], false);
    }
    if (discount > 0) {
      setText(el['discount-chip'], discount + '% off');
      show(el['discount-chip'], true);
    } else {
      show(el['discount-chip'], false);
    }

    setText(el['price-prefix'], currencyPrefix(currency));
    setText(el['target-prefix'], currencyPrefix(currency));
    el['price-input'].value = plainAmount(extraction.price);
    el['target-input'].value = '';
    markInvalid(el['price-input'], false);
    markInvalid(el['target-input'], false);

    var needsReview = !!(extraction.needsConfirmation || Number(extraction.confidence) < CONFIRM_THRESHOLD);
    show(el['confidence-note'], needsReview);
    if (needsReview) {
      var candidateCount = Array.isArray(extraction.candidates) ? extraction.candidates.length : 0;
      setText(el['confidence-detail'], candidateCount > 1
        ? 'More than one price was found. Check the amount against the page before saving.'
        : 'The detected amount was not fully reliable. Please check it against the page.');
      renderCandidates(extraction, currency);
      show(el['price-edit-block'], true);
      el['track-btn'].textContent = 'Confirm & Track Price';
    } else {
      setText(el['confidence-detail'], '');
      show(el['price-edit-block'], false);
      show(el['candidate-list'], false);
      el['track-btn'].textContent = 'Track Price';
    }

    show(el['loading-view'], false);
    showView('detection');
    if (needsReview) {
      setTimeout(function () {
        if (el['price-input'] && !el['price-edit-block'].hidden) {
          el['price-input'].focus();
          el['price-input'].select();
        }
      }, 80);
    }
  }

  function prefillManualFrom(extraction) {
    if (!extraction) return;
    if (extraction.title && el['manual-title'] && !el['manual-title'].value) {
      el['manual-title'].value = extraction.title;
    }
    if (extraction.price && el['manual-price'] && !el['manual-price'].value) {
      el['manual-price'].value = plainAmount(extraction.price);
    }
    if (extraction.currency) {
      setText(el['manual-price-prefix'], currencyPrefix(extraction.currency));
      setText(el['manual-target-prefix'], currencyPrefix(extraction.currency));
    }
  }

  function renderUnsupported(options) {
    var opts = options || {};
    showView('unsupported');
    setText(el['empty-title'], opts.title || 'No supported product detected');
    setText(el['empty-message'], opts.message || V.ERROR_MESSAGES.NO_PRODUCT);
    show(el['manual-form'], false);
    setText(el['manual-url-hint'], state.tabUrl ? 'Page: ' + state.tabUrl : '');
    el['manual-toggle-btn'] && (el['manual-toggle-btn'].textContent = 'Add manually');

    var canManual = !!state.tabUrl;
    show(el['manual-toggle-btn'], canManual);
    show(el['retry-btn'], canManual);
    if (canManual) prefillManualFrom(opts.extraction || state.extraction);
    if (opts.extraction && opts.extraction.currency) {
      setText(el['manual-price-prefix'], currencyPrefix(opts.extraction.currency));
      setText(el['manual-target-prefix'], currencyPrefix(opts.extraction.currency));
    }
    if (opts.focusManual && canManual) {
      show(el['manual-form'], true);
      el['manual-toggle-btn'] && (el['manual-toggle-btn'].textContent = 'Hide manual form');
      setTimeout(function () { el['manual-title'] && el['manual-title'].focus(); }, 60);
    }
  }

  function trackedStatus(product) {
    if (!product.trackingEnabled) return { label: 'Paused', className: 'neutral' };
    if (!product.monitoringEnabled) return { label: 'Manual only', className: 'neutral' };
    if (product.checkStatus === 'permission-required') return { label: 'Site access needed', className: 'warn' };
    if (product.checkStatus === 'failed') return { label: 'Check failed', className: 'bad' };
    if (product.checkStatus === 'idle') return { label: 'Scheduled', className: 'neutral' };
    return { label: 'Active', className: 'good' };
  }

  function renderTracked(product) {
    if (!product) return;
    state.currentProduct = product;
    var store = resolveStore(product.url, null);
    setProductImage(el['tracked-image'], el['tracked-image-fallback'], product.image, product.title, store);
    setText(el['tracked-title'], product.title);
    setText(el['tracked-store'], (product.store || store.name) + (product.storeId === 'generic' ? '' : ' · ' + U.hostLabel(product.url)));
    var currency = product.currency || 'INR';
    setText(el['tracked-current'], formatPrice(product.currentPrice, currency));
    if (Number.isFinite(Number(product.originalPrice)) && Number(product.originalPrice) > Number(product.currentPrice)) {
      setText(el['tracked-original'], formatPrice(product.originalPrice, currency));
      show(el['tracked-original'], true);
    } else {
      show(el['tracked-original'], false);
    }

    setText(el['tracked-target'], product.targetPrice ? formatPrice(product.targetPrice, currency) : 'Not set');
    setText(el['tracked-lowest'], product.lowestPrice ? formatPrice(product.lowestPrice, currency) : '—');
    setText(el['tracked-last-check'], product.lastChecked ? D.formatRelative(product.lastChecked) : 'Never');
    el['tracked-last-check'] && el['tracked-last-check'].setAttribute('title', product.lastChecked ? D.formatDate(product.lastChecked) : 'No checks yet');

    var next = '—';
    if (!product.trackingEnabled) next = 'Paused';
    else if (!product.monitoringEnabled) next = 'Manual only';
    else if (product.checkStatus === 'permission-required') next = 'Needs access';
    else if (product.nextCheck) next = D.formatRelativeFuture(product.nextCheck);
    setText(el['tracked-next-check'], next);
    el['tracked-next-check'] && el['tracked-next-check'].setAttribute('title', product.nextCheck ? D.formatDate(product.nextCheck) : next);

    var status = trackedStatus(product);
    var chip = el['tracked-status-chip'];
    if (chip) {
      chip.className = 'status-chip ' + status.className;
      chip.textContent = status.label;
    }

    var frequency = Number(product.checkFrequency) || state.settings.defaultFrequency || 12;
    if (!product.trackingEnabled) {
      setText(el['tracked-hint'], 'Automatic checks are paused. You can still update the price manually.');
    } else if (!product.monitoringEnabled) {
      setText(el['tracked-hint'], 'Automatic checks are off for this product. Update the price manually anytime.');
    } else if (product.checkStatus === 'permission-required') {
      setText(el['tracked-hint'], 'Allow site access from the dashboard to resume automatic checks.');
    } else if (product.checkStatus === 'failed') {
      setText(el['tracked-hint'], 'The last check failed. Your saved price was kept; we will try again automatically.');
    } else {
      setText(el['tracked-hint'], 'Checks every ' + frequency + ' hours while Chrome is open.');
    }

    show(el['tracked-update-block'], false);
    el['tracked-price-input'].value = '';
    markInvalid(el['tracked-price-input'], false);
    setText(el['tracked-price-prefix'], currencyPrefix(currency));
    setText(el['page-diff-text'], '');
    show(el['page-diff-note'], false);
    showView('tracked');
  }

  function showPageDiff(extraction) {
    if (!state.currentProduct || !extraction || !extraction.found) return;
    if (extraction.needsConfirmation || Number(extraction.confidence) < CONFIRM_THRESHOLD) return;
    var price = Number(extraction.price);
    var saved = Number(state.currentProduct.currentPrice);
    if (!Number.isFinite(price) || !Number.isFinite(saved)) return;
    var diff = Math.round((price - saved) * 100) / 100;
    if (Math.abs(diff) < 0.01) return;
    state.pagePrice = price;
    state.pageExtraction = extraction;
    var direction = diff < 0 ? 'below' : 'higher than';
    var comparison = diff < 0
      ? 'This page shows ' + formatPrice(price, extraction.currency) + ' — ' + formatPrice(Math.abs(diff), extraction.currency) + ' below your saved price.'
      : 'This page shows ' + formatPrice(price, extraction.currency) + ' — ' + formatPrice(Math.abs(diff), extraction.currency) + ' higher than your saved price.';
    setText(el['page-diff-text'], comparison + ' Use “Update price” to save it.');
    el['page-diff-text'].setAttribute('title', direction === 'below' ? 'Lower than saved price' : 'Higher than saved price');
    show(el['page-diff-note'], true);
  }

  /* --------------------------------------------------------------------- */
  /* Detection                                                              */
  /* --------------------------------------------------------------------- */

  async function findTracked(url, extraction) {
    var input = { url: url };
    if (extraction && extraction.externalId && extraction.storeId) {
      input.externalId = extraction.externalId;
      input.storeId = extraction.storeId;
    }
    try {
      return await Storage.findMatching(input);
    } catch (_) {
      return null;
    }
  }

  async function refreshPageDiff(tab, product) {
    if (!tab || !tab.id || !product) return;
    try {
      var result = await Client.extractFromTab(tab.id);
      if (!result || !result.ok || !result.data || !result.data.found) return;
      if (state.currentProduct && state.currentProduct.id !== product.id) return;
      state.pageExtraction = result.data;
      showPageDiff(result.data);
    } catch (_) {
      // A failed page read must never hide the saved product information.
    }
  }

  async function detectActiveTab() {
    state.busy = false;
    state.pagePrice = null;
    state.pageExtraction = null;
    state.currentProduct = null;
    state.extraction = null;
    showView('loading');

    var tab;
    try {
      tab = await Client.getActiveTab();
    } catch (_) {
      tab = null;
    }
    state.tab = tab;

    if (!tab || !tab.id || !tab.url || !Client.isInjectableUrl(tab.url)) {
      state.tabUrl = '';
      state.store = null;
      renderUnsupported({
        title: 'This page can’t be tracked',
        message: 'Open a regular product page on a shopping website. Chrome system pages and the Web Store cannot be read.'
      });
      return;
    }

    state.tabUrl = U.cleanUrl(tab.url) || tab.url;
    state.store = C.detect(state.tabUrl);

    var existing = await findTracked(state.tabUrl, null);
    if (existing) {
      renderTracked(existing);
      refreshPageDiff(tab, existing);
      return;
    }

    var result;
    try {
      result = await Client.extractFromTab(tab.id);
    } catch (error) {
      result = { ok: false, error: { code: 'INJECTION_FAILED', message: V.ERROR_MESSAGES.INJECTION_FAILED } };
    }

    if (!result || !result.ok) {
      var info = normalizeError(result && result.error, 'INJECTION_FAILED');
      renderUnsupported({
        title: 'We couldn’t read this page',
        message: info.message,
        focusManual: false
      });
      return;
    }

    var data = result.data;
    if (!data) {
      renderUnsupported({ title: 'No product detected', message: V.ERROR_MESSAGES.NO_PRODUCT });
      return;
    }

    state.extraction = data;
    if (data.blocked) {
      var blockedCode = data.error && data.error.code ? data.error.code : 'BLOCKED';
      renderUnsupported({
        title: 'This website blocked automated access',
        message: V.ERROR_MESSAGES[blockedCode] || V.ERROR_MESSAGES.BLOCKED,
        extraction: data,
        focusManual: !!data.title
      });
      return;
    }

    if (!data.found || !data.price) {
      renderUnsupported({
        title: data.title ? 'No reliable price found' : 'No product detected',
        message: V.ERROR_MESSAGES.PRICE_NOT_FOUND,
        extraction: data,
        focusManual: !!data.title
      });
      return;
    }

    if (!data.title) {
      renderUnsupported({
        title: 'Product name not detected',
        message: V.ERROR_MESSAGES.TITLE_NOT_FOUND + ' You can add it manually.',
        extraction: data,
        focusManual: true
      });
      return;
    }

    var canonical = U.cleanUrl(data.canonicalUrl || '');
    var pageOrigin = U.getOrigin(state.tabUrl);
    var finalUrl = state.tabUrl;
    if (canonical && U.getOrigin(canonical) === pageOrigin) finalUrl = canonical;
    else if (data.url && U.getOrigin(data.url) === pageOrigin) finalUrl = U.cleanUrl(data.url) || finalUrl;

    // A different URL variant (size, colour, storefront) may already be saved.
    var duplicate = await findTracked(finalUrl, data);
    if (duplicate) {
      renderTracked(duplicate);
      refreshPageDiff(tab, duplicate);
      return;
    }

    var store = resolveStore(finalUrl, data);
    renderDetection(Object.assign({}, data, { url: finalUrl }), store);
  }

  /* --------------------------------------------------------------------- */
  /* Tracking                                                               */
  /* --------------------------------------------------------------------- */

  function startPermissionRequest(url) {
    // Must be invoked synchronously in the click/submit handler so Chrome
    // treats it as a user gesture.
    return Client.requestSitePermission(url);
  }

  function currentDetectionDraft() {
    var extraction = state.extraction;
    var url = state.detectionUrl || state.tabUrl;
    if (!extraction || !url) return null;
    var title = V.cleanText(extraction.title, V.LIMITS.MAX_TITLE);
    var price = V.asPrice(el['price-input'] ? el['price-input'].value : null);
    var targetInput = el['target-input'] ? el['target-input'].value : '';
    var target = targetInput === '' ? null : V.asTargetPrice(targetInput);
    var store = state.store || resolveStore(url, extraction);
    var currency = extraction.currency || store.currency || 'INR';
    var original = Number(extraction.originalPrice);
    return {
      url: url,
      title: title,
      price: price,
      target: target,
      targetProvided: targetInput !== '',
      currency: currency,
      store: store,
      originalPrice: Number.isFinite(original) && original > price ? original : null
    };
  }

  async function handleTrackClick() {
    if (state.busy) return;
    var draft = currentDetectionDraft();
    if (!draft) {
      toast(V.ERROR_MESSAGES.NO_PRODUCT, 'error');
      return;
    }
    markInvalid(el['price-input'], false);
    markInvalid(el['target-input'], false);
    if (draft.price === null) {
      markInvalid(el['price-input'], true);
      toast(V.ERROR_MESSAGES.INVALID_PRICE, 'error');
      el['price-input'] && el['price-input'].focus();
      return;
    }
    if (draft.targetProvided && draft.target === null) {
      markInvalid(el['target-input'], true);
      toast('Enter a valid target price, or leave it empty.', 'error');
      el['target-input'] && el['target-input'].focus();
      return;
    }

    var monitoringWanted = !!(el['monitoring-toggle'] && el['monitoring-toggle'].checked);
    var permission = { granted: false, error: '' };
    if (monitoringWanted) {
      permission = await startPermissionRequest(draft.url);
    }

    state.busy = true;
    setBusy(el['track-btn'], true, 'Saving…');
    try {
      var response = await sendMessage('TRACK_PRODUCT', {
        product: {
          title: draft.title,
          image: state.extraction.image,
          url: draft.url,
          externalId: state.extraction.externalId,
          store: draft.store.name,
          storeId: draft.store.id,
          currency: draft.currency,
          currentPrice: draft.price,
          originalPrice: draft.originalPrice,
          availability: state.extraction.availability,
          confidence: state.extraction.confidence,
          extractionSource: state.extraction.source || 'Page extraction',
          candidates: state.extraction.candidates
        },
        targetPrice: draft.target,
        trackingEnabled: true,
        monitoringEnabled: monitoringWanted && permission.granted,
        notificationsEnabled: state.settings.notificationsEnabled !== false,
        checkFrequency: state.settings.defaultFrequency
      });

      if (response.duplicate) {
        renderTracked(response.product);
        toast('This product is already being tracked.', 'warning');
        return;
      }

      renderTracked(response.product);
      if (monitoringWanted && !permission.granted) {
        toast('Price saved. Automatic checks are off until you allow site access.', 'warning', 5200);
      } else if (response.warning) {
        toast(response.warning, 'warning', 5200);
      } else {
        toast(monitoringWanted ? 'Tracking started. First check is scheduled.' : 'Price saved. You can update it manually anytime.', 'success');
      }
    } catch (error) {
      var info = normalizeError(error);
      toast(info.message, 'error', 5200);
    } finally {
      state.busy = false;
      setBusy(el['track-btn'], false);
    }
  }

  async function handleManualSubmit(event) {
    if (event) event.preventDefault();
    if (state.busy) return;
    if (!state.tabUrl) {
      toast('Open a regular web page before adding a product manually.', 'error');
      return;
    }

    var title = V.cleanText(el['manual-title'] ? el['manual-title'].value : '', V.LIMITS.MAX_TITLE);
    var price = V.asPrice(el['manual-price'] ? el['manual-price'].value : null);
    var targetText = el['manual-target'] ? el['manual-target'].value : '';
    var target = targetText === '' ? null : V.asTargetPrice(targetText);
    markInvalid(el['manual-title'], false);
    markInvalid(el['manual-price'], false);
    markInvalid(el['manual-target'], false);

    if (!title) {
      markInvalid(el['manual-title'], true);
      toast('Enter a product name.', 'error');
      el['manual-title'] && el['manual-title'].focus();
      return;
    }
    if (price === null) {
      markInvalid(el['manual-price'], true);
      toast(V.ERROR_MESSAGES.INVALID_PRICE, 'error');
      el['manual-price'] && el['manual-price'].focus();
      return;
    }
    if (targetText !== '' && target === null) {
      markInvalid(el['manual-target'], true);
      toast('Enter a valid target price, or leave it empty.', 'error');
      el['manual-target'] && el['manual-target'].focus();
      return;
    }

    var monitoringWanted = !!(el['manual-monitoring'] && el['manual-monitoring'].checked);
    var permission = { granted: false, error: '' };
    if (monitoringWanted) {
      permission = await startPermissionRequest(state.tabUrl);
    }

    var store = state.store || C.detect(state.tabUrl) || C.getById('generic');
    var currency = (store && store.currency) || 'INR';
    state.busy = true;
    setBusy(el['manual-submit-btn'], true, 'Saving…');
    try {
      var response = await sendMessage('TRACK_PRODUCT', {
        product: {
          title: title,
          image: state.extraction && state.extraction.image ? state.extraction.image : '',
          url: state.tabUrl,
          store: store.name,
          storeId: store.id,
          currency: currency,
          currentPrice: price,
          originalPrice: null,
          availability: 'Unknown',
          confidence: 1,
          extractionSource: 'Manual entry',
          candidates: []
        },
        targetPrice: target,
        trackingEnabled: true,
        monitoringEnabled: monitoringWanted && permission.granted,
        notificationsEnabled: state.settings.notificationsEnabled !== false,
        checkFrequency: state.settings.defaultFrequency,
        manual: true
      });

      if (response.duplicate) {
        renderTracked(response.product);
        toast('This product is already being tracked.', 'warning');
        return;
      }
      renderTracked(response.product);
      if (monitoringWanted && !permission.granted) {
        toast('Product saved. Automatic checks are off until you allow site access.', 'warning', 5200);
      } else {
        toast('Product saved.', 'success');
      }
    } catch (error) {
      var info = normalizeError(error);
      toast(info.message, 'error', 5200);
    } finally {
      state.busy = false;
      setBusy(el['manual-submit-btn'], false);
    }
  }

  async function handleSavePrice() {
    if (state.busy || !state.currentProduct) return;
    var product = state.currentProduct;
    var price = V.asPrice(el['tracked-price-input'] ? el['tracked-price-input'].value : null);
    markInvalid(el['tracked-price-input'], false);
    if (price === null) {
      markInvalid(el['tracked-price-input'], true);
      toast(V.ERROR_MESSAGES.INVALID_PRICE, 'error');
      el['tracked-price-input'] && el['tracked-price-input'].focus();
      return;
    }

    state.busy = true;
    setBusy(el['save-price-btn'], true, 'Saving…');
    try {
      var response = await sendMessage('APPLY_MANUAL_PRICE', {
        id: product.id,
        price: price,
        source: 'manual',
        extractionSource: 'Manual price update'
      });
      var updated = response.product || await Storage.getProduct(product.id);
      if (updated) {
        renderTracked(updated);
        var report = response.report;
        if (report && report.changed) {
          if (report.isDrop) {
            toast('Price updated: ' + formatPrice(report.price, updated.currency) + ', down ' + formatPrice(report.dropAmount, updated.currency) + '.', 'success', 5000);
          } else {
            toast('Price updated to ' + formatPrice(report.price, updated.currency) + '.', 'success');
          }
        } else {
          toast('Price confirmed at ' + formatPrice(price, updated.currency) + '.', 'success');
        }
      } else {
        toast('Price saved.', 'success');
      }
      if (state.pagePrice !== null && Math.abs(Number(state.pagePrice) - price) < 0.01) {
        state.pagePrice = null;
      }
    } catch (error) {
      toast(normalizeError(error).message, 'error', 5200);
    } finally {
      state.busy = false;
      setBusy(el['save-price-btn'], false);
    }
  }

  function togglePriceEditor() {
    if (!state.currentProduct) return;
    var block = el['tracked-update-block'];
    if (!block) return;
    var opening = block.hidden;
    show(block, opening);
    if (opening) {
      var preferred = state.pagePrice !== null ? state.pagePrice : state.currentProduct.currentPrice;
      el['tracked-price-input'].value = plainAmount(preferred);
      markInvalid(el['tracked-price-input'], false);
      el['update-price-btn'].textContent = state.pagePrice !== null ? 'Use page price' : 'Update price';
      setTimeout(function () {
        el['tracked-price-input'].focus();
        el['tracked-price-input'].select();
      }, 40);
    } else {
      el['update-price-btn'].textContent = 'Update price';
      el['tracked-price-input'].value = '';
    }
  }

  /* --------------------------------------------------------------------- */
  /* Events / init                                                          */
  /* --------------------------------------------------------------------- */

  function applyTheme(settings) {
    if (root.SPT.Theme) root.SPT.Theme.apply(settings.theme || 'system');
  }

  function wireEvents() {
    el['open-dashboard-btn'] && el['open-dashboard-btn'].addEventListener('click', function () { openDashboard('overview'); });
    el['footer-dashboard-btn'] && el['footer-dashboard-btn'].addEventListener('click', function () { openDashboard('overview'); });

    el['edit-price-btn'] && el['edit-price-btn'].addEventListener('click', function () {
      var block = el['price-edit-block'];
      show(block, block.hidden);
      if (!block.hidden) {
        el['price-input'].focus();
        el['price-input'].select();
      }
    });

    el['track-btn'] && el['track-btn'].addEventListener('click', handleTrackClick);
    el['manual-form'] && el['manual-form'].addEventListener('submit', handleManualSubmit);

    el['retry-btn'] && el['retry-btn'].addEventListener('click', function () {
      detectActiveTab().catch(function (error) {
        renderUnsupported({ title: 'Detection failed', message: normalizeError(error).message });
      });
    });

    el['manual-toggle-btn'] && el['manual-toggle-btn'].addEventListener('click', function () {
      var form = el['manual-form'];
      var opening = form.hidden;
      show(form, opening);
      el['manual-toggle-btn'].textContent = opening ? 'Hide manual form' : 'Add manually';
      if (opening) {
        prefillManualFrom(state.extraction);
        setTimeout(function () { el['manual-title'] && el['manual-title'].focus(); }, 40);
      }
    });

    el['view-details-btn'] && el['view-details-btn'].addEventListener('click', function () {
      if (!state.currentProduct) return;
      openDashboard('product=' + encodeURIComponent(state.currentProduct.id));
    });

    el['update-price-btn'] && el['update-price-btn'].addEventListener('click', togglePriceEditor);
    el['save-price-btn'] && el['save-price-btn'].addEventListener('click', handleSavePrice);
    el['cancel-price-btn'] && el['cancel-price-btn'].addEventListener('click', function () {
      show(el['tracked-update-block'], false);
      el['tracked-price-input'].value = '';
      markInvalid(el['tracked-price-input'], false);
      el['update-price-btn'].textContent = 'Update price';
    });

    el['tracked-price-input'] && el['tracked-price-input'].addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleSavePrice();
      }
      if (event.key === 'Escape') {
        show(el['tracked-update-block'], false);
      }
    });

    el['price-input'] && el['price-input'].addEventListener('input', function () { markInvalid(el['price-input'], false); });
    el['target-input'] && el['target-input'].addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleTrackClick();
      }
    });
    el['manual-price'] && el['manual-price'].addEventListener('input', function () { markInvalid(el['manual-price'], false); });
    el['manual-title'] && el['manual-title'].addEventListener('input', function () { markInvalid(el['manual-title'], false); });

    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes[Storage.KEY_SETTINGS]) {
          var next = V.sanitizeSettings(changes[Storage.KEY_SETTINGS].newValue || state.settings);
          state.settings = next;
          applyTheme(next);
        }
        if (state.currentProduct && changes[Storage.PREFIX + state.currentProduct.id]) {
          var raw = changes[Storage.PREFIX + state.currentProduct.id].newValue;
          if (!raw) {
            state.currentProduct = null;
            return;
          }
          try {
            var updated = DM.validateProduct(raw);
            if (el['tracked-view'] && !el['tracked-view'].hidden) renderTracked(updated);
          } catch (_) { /* ignore corrupt updates */ }
        }
      });
    }
  }

  async function init() {
    cacheElements();
    wireEvents();
    try {
      state.settings = await Storage.getSettings();
    } catch (_) {
      state.settings = DM.defaultSettings();
    }
    applyTheme(state.settings);
    try {
      await detectActiveTab();
    } catch (error) {
      renderUnsupported({
        title: 'Something went wrong',
        message: normalizeError(error).message
      });
    }
    state.initialised = true;
  }

  init();
})(typeof globalThis !== 'undefined' ? globalThis : self);
