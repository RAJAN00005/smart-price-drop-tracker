/**
 * Smart Price Drop Tracker — dashboard controller.
 *
 * All rendering uses DOM APIs and textContent; user-controlled product data is
 * never inserted as HTML. Storage is read directly, mutations go through the
 * background service worker.
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
  var DM = SPT.DataModel;
  var Client = SPT.ExtractionClient;

  var NS = 'http://www.w3.org/2000/svg';
  var CHART_RANGES = ['7d', '30d', '90d', 'all'];
  var SOURCE_LABELS = {
    auto: 'Automatic check',
    manual: 'Manual update',
    initial: 'First seen',
    import: 'Imported',
    confirmed: 'Confirmed',
    popup: 'Popup update',
    dashboard: 'Dashboard update'
  };

  var state = {
    settings: DM.defaultSettings(),
    products: [],
    summary: DM.summary([]),
    sites: [],
    storage: { used: 0, quota: 10485760, percent: 0 },
    route: { name: 'overview', productId: null },
    chartRange: '30d',
    filters: { query: '', filter: 'all', sort: 'newest' },
    settingsTimer: null,
    refreshTimer: null,
    modalBusy: false,
    lastFocused: null,
    pendingImport: null,
    loaded: false
  };

  var el = {};

  function $(id) {
    return document.getElementById(id);
  }

  function cacheElements() {
    [
      'page-content', 'nav-product-count', 'monitor-dot', 'monitor-status', 'app-version',
      'quick-export', 'quick-import', 'theme-toggle', 'toast-region', 'modal-root',
      'modal-title', 'modal-body', 'modal-actions', 'modal-close', 'import-file-input'
    ].forEach(function (id) { el[id] = $(id); });
  }

  /* --------------------------------------------------------------------- */
  /* DOM helpers                                                            */
  /* --------------------------------------------------------------------- */

  function node(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function add(parent) {
    for (var i = 1; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined || child === false) continue;
      parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return parent;
  }

  function clear(element) {
    if (element) element.replaceChildren();
  }

  function setText(element, text) {
    if (element) element.textContent = text === null || text === undefined ? '' : String(text);
  }

  function icon(name, className) {
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'icon' + (className ? ' ' + className : ''));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var use = document.createElementNS(NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function iconLabel(iconName, text, className) {
    var span = node('span', className || 'inline-flex');
    span.appendChild(icon(iconName));
    span.appendChild(document.createTextNode(text));
    return span;
  }

  function badge(text, variant) {
    return node('span', 'badge ' + (variant || 'badge-neutral'), text);
  }

  function makeButton(options) {
    var opts = options || {};
    var button = node('button', opts.className || 'btn btn-secondary');
    button.type = opts.type || 'button';
    if (opts.action) button.dataset.action = opts.action;
    if (opts.id) button.dataset.id = opts.id;
    if (opts.value !== undefined) button.dataset.value = opts.value;
    if (opts.range) button.dataset.range = opts.range;
    if (opts.origin) button.dataset.origin = opts.origin;
    if (opts.url) button.dataset.url = opts.url;
    if (opts.title) {
      button.title = opts.title;
      button.setAttribute('aria-label', opts.title);
    }
    if (opts.disabled) button.disabled = true;
    if (opts.icon) button.appendChild(icon(opts.icon));
    if (opts.label) button.appendChild(document.createTextNode(opts.label));
    return button;
  }

  function makeIconButton(options) {
    var opts = options || {};
    var button = makeButton({
      className: 'card-btn' + (opts.danger ? ' danger' : ''),
      action: opts.action,
      id: opts.id,
      title: opts.title,
      icon: opts.icon
    });
    return button;
  }

  function makeExternalLink(product, label) {
    var href = U.cleanUrl(product.url);
    if (!href) return null;
    var link = node('a', null, label || 'View product');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.appendChild(icon('external'));
    return link;
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      if (button.dataset.sptBusy === '1') return;
      button.dataset.sptBusy = '1';
      button._sptBusyNodes = Array.prototype.slice.call(button.childNodes);
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      var spinner = node('span', 'spinner');
      spinner.setAttribute('aria-hidden', 'true');
      button.replaceChildren(spinner, document.createTextNode(label || 'Working…'));
    } else {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      if (button.dataset.sptBusy === '1') {
        delete button.dataset.sptBusy;
        if (button._sptBusyNodes) {
          button.replaceChildren.apply(button, button._sptBusyNodes);
          delete button._sptBusyNodes;
        } else {
          button.textContent = '';
        }
      }
    }
  }

  function markInvalid(input, invalid) {
    if (!input) return;
    input.classList.toggle('invalid', !!invalid);
    input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
  }

  /* --------------------------------------------------------------------- */
  /* Formatting                                                             */
  /* --------------------------------------------------------------------- */

  function formatPrice(value, currency) {
    return P.formatPrice(value, currency || 'INR', {
      currencyDisplay: state.settings.currencyDisplay || 'symbol'
    });
  }

  function formatCompact(value, currency) {
    return P.formatCompact(value, currency || 'INR');
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

  function sourceLabel(source) {
    return SOURCE_LABELS[source] || 'Price observation';
  }

  function storeInfo(product) {
    var detected = C.detect(product.url);
    var fallback = C.getById(product.storeId || 'generic');
    var base = detected || fallback;
    var name = detected && detected.known
      ? detected.name
      : (product.store || base.name || 'Online store');
    return {
      id: product.storeId || base.id || 'generic',
      name: name,
      accent: base.accent || '#6d5efc',
      initials: base.initials || name.slice(0, 2).toUpperCase(),
      hostname: base.hostname || U.hostLabel(product.url)
    };
  }

  function createThumb(product, className) {
    var store = storeInfo(product);
    var wrap = node('div', className || 'product-thumb');
    var fallback = node('span', 'thumb-fallback', store.initials || 'S');
    fallback.style.background = store.accent;
    wrap.appendChild(fallback);
    var safe = U.safeImageUrl(product.image || '');
    if (safe) {
      var img = node('img');
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onload = function () { fallback.hidden = true; };
      img.onerror = function () { img.remove(); };
      img.src = safe;
      wrap.appendChild(img);
    }
    return wrap;
  }

  function productStatus(product) {
    if (!product.trackingEnabled) return { label: 'Paused', variant: 'badge-neutral' };
    if (!product.monitoringEnabled) return { label: 'Manual only', variant: 'badge-neutral' };
    if (product.checkStatus === 'permission-required') return { label: 'Needs access', variant: 'badge-warn' };
    if (product.checkStatus === 'failed') return { label: 'Check failed', variant: 'badge-bad' };
    if (product.checkStatus === 'idle') return { label: 'Scheduled', variant: 'badge-info' };
    return { label: 'Active', variant: 'badge-good' };
  }

  function originOf(product) {
    return U.originPattern(product.url);
  }

  function getProduct(id) {
    if (!id) return null;
    for (var i = 0; i < state.products.length; i++) {
      if (state.products[i].id === id) return state.products[i];
    }
    return null;
  }

  function attentionProducts() {
    return state.products.filter(function (product) {
      return product.checkStatus === 'failed' || product.checkStatus === 'permission-required';
    });
  }

  function lastDropInfo(product) {
    if (!product) return null;
    if (product.lastDropAt && Number(product.previousPrice) > Number(product.currentPrice)) {
      var amount = Number(product.previousPrice) - Number(product.currentPrice);
      return {
        amount: amount,
        percent: product.previousPrice > 0 ? Math.round((amount / product.previousPrice) * 100) : 0,
        date: product.lastDropAt
      };
    }
    var history = Array.isArray(product.priceHistory) ? product.priceHistory : [];
    for (var i = history.length - 1; i > 0; i--) {
      var current = Number(history[i].price);
      var previous = Number(history[i - 1].price);
      if (Number.isFinite(current) && Number.isFinite(previous) && current < previous) {
        var diff = previous - current;
        return {
          amount: diff,
          percent: previous > 0 ? Math.round((diff / previous) * 100) : 0,
          date: history[i].date
        };
      }
    }
    return null;
  }

  function nextCheckSummary() {
    var now = Date.now();
    var active = 0;
    var next = null;
    state.products.forEach(function (product) {
      if (!product.trackingEnabled || !product.monitoringEnabled) return;
      active++;
      var ms = product.nextCheck ? D.parseDate(product.nextCheck) : null;
      if (ms !== null && ms > now - 60000 && (next === null || ms < next)) next = ms;
    });
    return { active: active, next: next };
  }

  /* --------------------------------------------------------------------- */
  /* Messaging / toast                                                      */
  /* --------------------------------------------------------------------- */

  function normalizeError(error, fallbackCode) {
    var code = error && error.code ? error.code : (fallbackCode || 'UNKNOWN');
    var message = V.userMessage(error, code);
    if (!message || (message === V.ERROR_MESSAGES.UNKNOWN && V.ERROR_MESSAGES[code])) {
      message = V.ERROR_MESSAGES[code];
    }
    return { code: code, message: message, detail: error && (error.detail || error.details) };
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
            var error = new Error(response.error && response.error.message ? response.error.message : V.ERROR_MESSAGES.UNKNOWN);
            error.code = response.error && response.error.code ? response.error.code : 'UNKNOWN';
            reject(error);
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function toast(message, type, timeout) {
    if (!el['toast-region'] || !message) return;
    var item = node('div', 'toast ' + (type || 'info'), message);
    el['toast-region'].appendChild(item);
    var remove = function () {
      if (!item.isConnected) return;
      item.classList.add('is-leaving');
      setTimeout(function () {
        if (item.parentNode) item.parentNode.removeChild(item);
      }, 190);
    };
    item.addEventListener('click', remove);
    setTimeout(remove, timeout || 4200);
  }

  /* --------------------------------------------------------------------- */
  /* Modal                                                                  */
  /* --------------------------------------------------------------------- */

  function openModal(options) {
    var opts = options || {};
    state.lastFocused = document.activeElement;
    setText(el['modal-title'], opts.title || 'Dialog');
    clear(el['modal-body']);
    (opts.body || []).forEach(function (child) {
      if (child) el['modal-body'].appendChild(child);
    });
    clear(el['modal-actions']);
    (opts.actions || []).forEach(function (action) {
      var button = node('button', action.className || 'btn btn-secondary', action.label);
      button.type = 'button';
      if (action.onReady) action.onReady(button);
      button.addEventListener('click', function () {
        runModalAction(action, button);
      });
      el['modal-actions'].appendChild(button);
    });
    var panel = el['modal-root'].querySelector('.modal-panel');
    if (panel) panel.classList.toggle('is-wide', opts.wide === true);
    el['modal-root'].hidden = false;
    document.body.classList.add('modal-open');
    setTimeout(function () {
      var focusTarget = el['modal-actions'].querySelector('button:not(:disabled)') || el['modal-close'];
      if (focusTarget) focusTarget.focus();
    }, 30);
  }

  function closeModal() {
    if (!el['modal-root'] || el['modal-root'].hidden) return;
    el['modal-root'].hidden = true;
    document.body.classList.remove('modal-open');
    state.modalBusy = false;
    var focusTarget = state.lastFocused;
    state.lastFocused = null;
    if (focusTarget && focusTarget.isConnected && typeof focusTarget.focus === 'function') {
      try { focusTarget.focus(); } catch (_) { /* ignore */ }
    }
    if (state.pendingRefresh) {
      state.pendingRefresh = false;
      setTimeout(function () { refresh({ scroll: false }); }, 40);
    }
  }

  async function runModalAction(action, button) {
    if (state.modalBusy) return;
    state.modalBusy = true;
    setBusy(button, true, action.busyLabel || 'Working…');
    try {
      var result = await action.onClick(button);
      if (result !== false) closeModal();
    } catch (error) {
      toast(normalizeError(error).message, 'error', 5400);
      setBusy(button, false);
    } finally {
      state.modalBusy = false;
    }
  }

  function noteNode(iconName, text, variant) {
    var note = node('div', 'modal-note' + (variant ? ' ' + variant : ''));
    note.appendChild(icon(iconName || 'info'));
    note.appendChild(node('span', null, text));
    return note;
  }

  /* --------------------------------------------------------------------- */
  /* Data                                                                   */
  /* --------------------------------------------------------------------- */

  async function loadSites() {
    var groups = {};
    state.products.forEach(function (product) {
      var origin = originOf(product);
      if (!origin) return;
      if (!groups[origin]) {
        groups[origin] = {
          origin: origin,
          url: product.url,
          store: storeInfo(product),
          count: 0
        };
      }
      groups[origin].count++;
    });
    var sites = Object.keys(groups).map(function (key) { return groups[key]; });
    for (var i = 0; i < sites.length; i++) {
      try {
        sites[i].granted = await Client.hasSitePermission(sites[i].url);
      } catch (_) {
        sites[i].granted = false;
      }
    }
    sites.sort(function (a, b) {
      if (a.granted !== b.granted) return a.granted ? -1 : 1;
      return b.count - a.count;
    });
    state.sites = sites;
  }

  async function loadAll() {
    var results = await Promise.all([
      Storage.listProducts(),
      Storage.getSettings(),
      Storage.getStorageInfo()
    ]);
    state.products = results[0];
    // A data refresh can run while a settings save is still debounced or in
    // flight. Keep the local values in that case so a product change cannot
    // overwrite an unsaved settings toggle with the old storage snapshot.
    if (!state.settingsSaving) state.settings = results[1];
    state.storage = results[2];
    state.summary = DM.summary(state.products);
    await loadSites();
    state.loaded = true;
  }

  async function refresh(options) {
    var opts = options || {};
    state.pendingRefresh = false;
    var previousScroll = window.scrollY;
    try {
      await loadAll();
      applyTheme();
      updateChrome();
      renderRoute({ scroll: opts.scroll !== false });
      if (opts.scroll === false) {
        requestAnimationFrame(function () { window.scrollTo(0, previousScroll); });
      }
    } catch (error) {
      renderFatal(error);
    }
  }

  /* --------------------------------------------------------------------- */
  /* Chrome shell                                                           */
  /* --------------------------------------------------------------------- */

  function applyTheme() {
    if (root.SPT.Theme) root.SPT.Theme.apply(state.settings.theme || 'system');
    updateThemeIcon();
  }

  function updateThemeIcon() {
    if (!el['theme-toggle']) return;
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var use = el['theme-toggle'].querySelector('use');
    if (use) use.setAttribute('href', dark ? '#i-sun' : '#i-moon');
    var label = dark ? 'Switch to light theme' : 'Switch to dark theme';
    el['theme-toggle'].title = label;
    el['theme-toggle'].setAttribute('aria-label', label);
  }

  function updateChrome() {
    setText(el['nav-product-count'], state.products.length);
    setText(el['app-version'], chrome.runtime.getManifest().version);
    updateTopbar();
  }

  function updateTopbar() {
    var status = nextCheckSummary();
    var attention = attentionProducts().length;
    var text;
    if (!state.products.length) {
      text = 'No products tracked yet';
    } else if (attention > 0) {
      text = attention + (attention === 1 ? ' product needs' : ' products need') + ' attention';
    } else if (!status.active) {
      text = 'Automatic checks are paused';
    } else if (status.next) {
      text = 'Watching ' + status.active + (status.active === 1 ? ' product' : ' products') +
        ' · next check ' + D.formatRelativeFuture(new Date(status.next).toISOString());
    } else {
      text = 'Watching ' + status.active + (status.active === 1 ? ' product' : ' products');
    }
    setText(el['monitor-status'], text);
    if (el['monitor-dot']) {
      el['monitor-dot'].className = 'monitor-dot' +
        (attention > 0 ? ' is-warn' : (!status.active ? ' is-idle' : ''));
    }
  }

  function updateNav() {
    var active = state.route.name === 'product' ? 'products' : state.route.name;
    document.querySelectorAll('[data-nav]').forEach(function (link) {
      link.classList.toggle('is-active', link.dataset.nav === active);
      if (link.dataset.nav === active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  /* --------------------------------------------------------------------- */
  /* Routing                                                                */
  /* --------------------------------------------------------------------- */

  function parseHash() {
    var raw = (location.hash || '').replace(/^#/, '');
    if (!raw || raw === 'overview') return { name: 'overview', productId: null };
    if (raw === 'products') return { name: 'products', productId: null };
    if (raw === 'settings') return { name: 'settings', productId: null };
    if (raw.indexOf('product=') === 0) {
      var id = raw.slice('product='.length);
      try { id = decodeURIComponent(id); } catch (_) { /* keep raw */ }
      return { name: 'product', productId: id };
    }
    return { name: 'overview', productId: null };
  }

  function renderRoute(options) {
    var opts = options || {};
    state.route = parseHash();
    updateNav();
    clear(el['page-content']);
    var route = state.route;
    if (route.name === 'products') {
      renderProducts(el['page-content']);
      document.title = 'Products — Smart Price Tracker';
    } else if (route.name === 'settings') {
      renderSettings(el['page-content']);
      document.title = 'Settings — Smart Price Tracker';
    } else if (route.name === 'product') {
      var product = getProduct(route.productId);
      if (product) {
        renderProductDetail(el['page-content'], product);
        document.title = product.title + ' — Smart Price Tracker';
      } else {
        renderNotFound(el['page-content']);
        document.title = 'Product not found — Smart Price Tracker';
      }
    } else {
      renderOverview(el['page-content']);
      document.title = 'Overview — Smart Price Tracker';
    }
    if (opts.scroll !== false) window.scrollTo(0, 0);
  }

  function renderPageHead(title, subtitle, actions, eyebrow) {
    var head = node('div', 'page-head');
    var copy = node('div', 'page-head-copy');
    if (eyebrow) copy.appendChild(node('span', 'eyebrow', eyebrow));
    copy.appendChild(node('h1', 'page-title', title));
    if (subtitle) copy.appendChild(node('p', 'page-subtitle', subtitle));
    head.appendChild(copy);
    if (actions && actions.length) {
      var actionWrap = node('div', 'page-actions');
      actions.forEach(function (action) { if (action) actionWrap.appendChild(action); });
      head.appendChild(actionWrap);
    }
    return head;
  }

  function renderFatal(error) {
    if (!el['page-content']) return;
    clear(el['page-content']);
    var page = node('div', 'page');
    page.appendChild(renderPageHead('Dashboard unavailable', 'Your saved data has not been changed.', []));
    var empty = node('div', 'empty-state card');
    var iconWrap = node('div', 'empty-icon');
    iconWrap.appendChild(icon('alert'));
    add(empty, iconWrap, node('h2', null, 'Something went wrong'), node('p', null, normalizeError(error).message));
    var actions = node('div', 'empty-actions');
    actions.appendChild(makeButton({
      label: 'Try again',
      icon: 'refresh',
      className: 'btn btn-primary',
      action: 'retry-load'
    }));
    empty.appendChild(actions);
    page.appendChild(empty);
    el['page-content'].appendChild(page);
    setText(el['monitor-status'], 'Dashboard unavailable');
    if (el['monitor-dot']) el['monitor-dot'].className = 'monitor-dot is-warn';
  }

  function renderNotFound(container) {
    var page = node('div', 'page');
    page.appendChild(renderPageHead('Product not found', 'It may have been removed from this browser.', []));
    var empty = node('div', 'empty-state card');
    var iconWrap = node('div', 'empty-icon');
    iconWrap.appendChild(icon('box'));
    add(empty, iconWrap, node('h2', null, 'This product is no longer tracked'), node('p', null, 'Return to your products to see what is still being watched.'));
    var actions = node('div', 'empty-actions');
    actions.appendChild(makeButton({
      label: 'Back to products',
      icon: 'back',
      className: 'btn btn-primary',
      action: 'go-products'
    }));
    empty.appendChild(actions);
    page.appendChild(empty);
    container.appendChild(page);
  }

  /* --------------------------------------------------------------------- */
  /* Overview                                                               */
  /* --------------------------------------------------------------------- */

  function metricCard(iconName, tone, value, label, note) {
    var card = node('div', 'metric-card');
    var top = node('div', 'metric-top');
    var iconWrap = node('div', 'metric-icon' + (tone ? ' ' + tone : ''));
    iconWrap.appendChild(icon(iconName));
    top.appendChild(iconWrap);
    card.appendChild(top);
    card.appendChild(node('div', 'metric-value', value));
    card.appendChild(node('div', 'metric-label', label));
    if (note) card.appendChild(node('div', 'stat-note', note));
    return card;
  }

  function inlineEmpty(iconName, title, text) {
    var wrap = node('div', 'inline-empty');
    var iconWrap = node('div', 'inline-empty-icon');
    iconWrap.appendChild(icon(iconName));
    wrap.appendChild(iconWrap);
    wrap.appendChild(node('strong', null, title));
    if (text) wrap.appendChild(node('p', null, text));
    return wrap;
  }

  function dropRow(product, drop) {
    var row = node('button', 'drop-row');
    row.type = 'button';
    row.dataset.action = 'open-product';
    row.dataset.id = product.id;
    row.appendChild(createThumb(product, 'drop-thumb'));
    var copy = node('div', 'drop-copy');
    copy.appendChild(node('p', 'drop-name', product.title));
    var meta = node('div', 'drop-meta');
    meta.appendChild(node('span', null, product.store || storeInfo(product).name));
    meta.appendChild(node('span', null, '·'));
    meta.appendChild(node('span', null, D.formatRelative(drop.date)));
    copy.appendChild(meta);
    row.appendChild(copy);
    var prices = node('div', 'drop-prices');
    prices.appendChild(node('span', 'drop-price', formatPrice(product.currentPrice, product.currency)));
    var delta = node('span', 'drop-delta');
    delta.appendChild(icon('arrow-down'));
    delta.appendChild(document.createTextNode(formatPrice(drop.amount, product.currency)));
    if (drop.percent > 0) delta.appendChild(document.createTextNode(' (' + drop.percent + '%)'));
    prices.appendChild(delta);
    row.appendChild(prices);
    return row;
  }

  function attentionRow(product) {
    var row = node('div', 'attention-row');
    var isPermission = product.checkStatus === 'permission-required';
    var iconWrap = node('div', 'attention-icon' + (isPermission ? '' : ' bad'));
    iconWrap.appendChild(icon(isPermission ? 'shield' : 'alert'));
    row.appendChild(iconWrap);
    var copy = node('div', 'attention-copy');
    copy.appendChild(node('strong', null, product.title));
    var message = product.lastError && product.lastError.message
      ? product.lastError.message
      : (isPermission ? 'Site access is needed for automatic checks.' : 'The last price check failed.');
    copy.appendChild(node('p', null, message));
    row.appendChild(copy);
    var action = makeButton({
      label: 'Review',
      className: 'btn btn-ghost btn-sm attention-action',
      action: 'open-product',
      id: product.id
    });
    row.appendChild(action);
    return row;
  }

  function renderOverview(container) {
    var page = node('div', 'page');
    var products = state.products;
    page.appendChild(renderPageHead(
      'Overview',
      'A calm, private view of every price you are watching.',
      [
        makeButton({ label: 'Add a product', icon: 'plus', className: 'btn btn-primary', action: 'add-help' }),
        products.length ? makeButton({ label: 'All products', className: 'btn btn-secondary', action: 'go-products' }) : null
      ],
      'Your dashboard'
    ));

    if (!products.length) {
      var onboarding = node('div', 'empty-state card');
      var iconWrap = node('div', 'empty-icon');
      iconWrap.appendChild(icon('sparkles'));
      add(onboarding, iconWrap,
        node('h2', null, 'Start watching your first price'),
        node('p', null, 'Open any product page, click the Smart Price Tracker icon in your toolbar, confirm the detected price, and it will appear here. Everything stays on this device.'));

      var steps = node('div', 'onboarding-steps');
      [
        ['1', 'Open a product page', 'Amazon India, Flipkart, Myntra, AJIO, Croma, Reliance Digital, Tata CLiQ, Meesho or any other store.'],
        ['2', 'Click the toolbar icon', 'Review the detected title, price and store before saving.'],
        ['3', 'Confirm and relax', 'We check the price on your schedule and keep a private history.']
      ].forEach(function (step) {
        var item = node('div', 'onboarding-step');
        item.appendChild(node('span', null, step[0]));
        item.appendChild(node('strong', null, step[1]));
        item.appendChild(node('p', null, step[2]));
        steps.appendChild(item);
      });
      onboarding.appendChild(steps);

      var storeChips = node('div', 'store-chips');
      C.all().forEach(function (store) { storeChips.appendChild(node('span', 'store-chip', store.name)); });
      onboarding.appendChild(storeChips);

      var actions = node('div', 'empty-actions');
      actions.appendChild(makeButton({ label: 'How to add a product', icon: 'plus', className: 'btn btn-primary', action: 'add-help' }));
      onboarding.appendChild(actions);
      page.appendChild(onboarding);
      container.appendChild(page);
      return;
    }

    var summary = state.summary;
    var status = nextCheckSummary();
    var attention = attentionProducts();
    var hero = node('section', 'hero-card');
    var heroMain = node('div', 'hero-main');
    heroMain.appendChild(iconLabel('sparkles', 'Potential savings', 'hero-eyebrow'));
    heroMain.appendChild(node('div', 'hero-value', formatPrice(summary.potentialSavings || 0, 'INR')));
    heroMain.appendChild(node('p', 'hero-sub',
      'Based on the highest price seen for each product. ' +
      (summary.productsWithDrops ? summary.productsWithDrops + (summary.productsWithDrops === 1 ? ' product has' : ' products have') + ' dropped since you started tracking.' : 'No price drops recorded yet — we will keep watching.')));
    hero.appendChild(heroMain);

    var heroSide = node('div', 'hero-side');
    [
      ['Active checks', String(status.active)],
      ['Next check', status.next ? D.formatRelativeFuture(new Date(status.next).toISOString()) : 'Not scheduled'],
      ['At their lowest', String(summary.atLowest)]
    ].forEach(function (pair) {
      var stat = node('div', 'hero-stat');
      stat.appendChild(node('span', null, pair[0]));
      stat.appendChild(node('strong', null, pair[1]));
      heroSide.appendChild(stat);
    });
    hero.appendChild(heroSide);
    page.appendChild(hero);

    var metrics = node('div', 'metric-grid');
    var autoCount = products.filter(function (product) {
      return product.trackingEnabled && product.monitoringEnabled;
    }).length;
    metrics.appendChild(metricCard('box', '', String(summary.totalTracked), 'Products tracked',
      autoCount + ' with automatic checks'));
    metrics.appendChild(metricCard('trend-down', 'green', String(summary.atLowest), 'At their lowest',
      'Current price equals the lowest seen'));
    metrics.appendChild(metricCard('percent', 'violet', String(summary.productsWithDrops), 'Products with drops',
      'Any drop since tracking began'));
    metrics.appendChild(metricCard('alert', attention.length ? 'amber' : '', String(attention.length), 'Need attention',
      attention.length ? 'Permission or check failures' : 'Everything looks healthy'));
    page.appendChild(metrics);

    var grid = node('div', 'dashboard-grid');

    var dropsCard = node('section', 'card card-pad');
    var dropsHead = node('div', 'section-head');
    var dropsCopy = node('div', 'section-head-copy');
    dropsCopy.appendChild(node('h2', 'section-title', 'Recent price drops'));
    dropsCopy.appendChild(node('p', 'section-sub', 'The latest downward moves across your products.'));
    dropsHead.appendChild(dropsCopy);
    if (summary.productsWithDrops) {
      dropsHead.appendChild(makeButton({ label: 'View all', className: 'link-action', action: 'view-drops' }));
    }
    dropsCard.appendChild(dropsHead);

    var drops = products.map(function (product) {
      var drop = lastDropInfo(product);
      return drop ? { product: product, drop: drop } : null;
    }).filter(Boolean).sort(function (a, b) {
      return (D.parseDate(b.drop.date) || 0) - (D.parseDate(a.drop.date) || 0);
    }).slice(0, 5);

    if (!drops.length) {
      dropsCard.appendChild(inlineEmpty('chart', 'No drops yet', 'When a watched price falls, it will show up here.'));
    } else {
      var dropList = node('div', 'drop-list');
      drops.forEach(function (entry) { dropList.appendChild(dropRow(entry.product, entry.drop)); });
      dropsCard.appendChild(dropList);
    }
    grid.appendChild(dropsCard);

    var attentionCard = node('section', 'card card-pad');
    var attentionHead = node('div', 'section-head');
    var attentionCopy = node('div', 'section-head-copy');
    attentionCopy.appendChild(node('h2', 'section-title', 'Needs attention'));
    attentionCopy.appendChild(node('p', 'section-sub', 'Checks that need your permission or another look.'));
    attentionHead.appendChild(attentionCopy);
    attentionCard.appendChild(attentionHead);
    if (!attention.length) {
      attentionCard.appendChild(inlineEmpty('check', 'All clear', 'No failed checks or missing permissions right now.'));
    } else {
      var attentionList = node('div', 'attention-list');
      attention.slice(0, 4).forEach(function (product) { attentionList.appendChild(attentionRow(product)); });
      attentionCard.appendChild(attentionList);
      if (attention.length > 4) {
        attentionCard.appendChild(makeButton({
          label: 'Review all ' + attention.length,
          className: 'btn btn-ghost btn-sm',
          action: 'view-attention'
        }));
      }
    }
    grid.appendChild(attentionCard);
    page.appendChild(grid);

    var lowest = products.filter(function (product) {
      return Number.isFinite(Number(product.currentPrice)) &&
        Number.isFinite(Number(product.lowestPrice)) &&
        Number(product.currentPrice) <= Number(product.lowestPrice) + 0.009;
    }).sort(function (a, b) {
      return (Number(b.highestPrice) || 0) - (Number(a.highestPrice) || 0);
    }).slice(0, 6);

    var lowestCard = node('section', 'card card-pad');
    var lowestHead = node('div', 'section-head');
    var lowestCopy = node('div', 'section-head-copy');
    lowestCopy.appendChild(node('h2', 'section-title', 'At their lowest'));
    lowestCopy.appendChild(node('p', 'section-sub', 'These products are currently at the best price you have seen.'));
    lowestHead.appendChild(lowestCopy);
    lowestCard.appendChild(lowestHead);

    if (!lowest.length) {
      lowestCard.appendChild(inlineEmpty('target', 'Nothing at its lowest right now', 'Keep watching — we will tell you when a price falls.'));
    } else {
      var lowestGrid = node('div', 'lowest-grid');
      lowest.forEach(function (product) {
        var item = node('button', 'lowest-item');
        item.type = 'button';
        item.dataset.action = 'open-product';
        item.dataset.id = product.id;
        item.appendChild(createThumb(product, 'drop-thumb'));
        var copy = node('div', 'lowest-copy');
        copy.appendChild(node('strong', null, product.title));
        copy.appendChild(node('span', null, formatPrice(product.currentPrice, product.currency)));
        item.appendChild(copy);
        lowestGrid.appendChild(item);
      });
      lowestCard.appendChild(lowestGrid);
    }
    page.appendChild(lowestCard);

    container.appendChild(page);
  }

  /* --------------------------------------------------------------------- */
  /* Products                                                               */
  /* --------------------------------------------------------------------- */

  function filteredProducts() {
    var query = (state.filters.query || '').trim().toLowerCase();
    var filter = state.filters.filter;
    var list = state.products.filter(function (product) {
      if (query) {
        var haystack = [product.title, product.store, U.hostLabel(product.url)].join(' ').toLowerCase();
        if (haystack.indexOf(query) === -1) return false;
      }
      if (filter === 'active') return product.trackingEnabled && product.monitoringEnabled;
      if (filter === 'paused') return !product.trackingEnabled;
      if (filter === 'drops') return Number(product.totalDrops) > 0;
      if (filter === 'lowest') {
        return Number.isFinite(Number(product.currentPrice)) &&
          Number.isFinite(Number(product.lowestPrice)) &&
          Number(product.currentPrice) <= Number(product.lowestPrice) + 0.009;
      }
      if (filter === 'attention') {
        return product.checkStatus === 'failed' || product.checkStatus === 'permission-required';
      }
      return true;
    });

    list.sort(function (a, b) {
      switch (state.filters.sort) {
        case 'price-low':
          return (Number(a.currentPrice) || 0) - (Number(b.currentPrice) || 0);
        case 'price-high':
          return (Number(b.currentPrice) || 0) - (Number(a.currentPrice) || 0);
        case 'biggest-drop': {
          var ad = lastDropInfo(a);
          var bd = lastDropInfo(b);
          return (bd ? bd.percent : 0) - (ad ? ad.percent : 0);
        }
        case 'checked':
          return (D.parseDate(b.lastChecked) || 0) - (D.parseDate(a.lastChecked) || 0);
        case 'name':
          return String(a.title).localeCompare(String(b.title));
        case 'newest':
        default:
          return (D.parseDate(b.createdAt) || 0) - (D.parseDate(a.createdAt) || 0);
      }
    });
    return list;
  }

  function selectField(id, options, value, dataChange) {
    var select = node('select', 'select');
    select.id = id;
    if (dataChange) select.dataset.change = dataChange;
    options.forEach(function (option) {
      var item = node('option', null, option.label);
      item.value = option.value;
      if (String(option.value) === String(value)) item.selected = true;
      select.appendChild(item);
    });
    return select;
  }

  function sparkline(product) {
    var wrap = node('div', 'product-spark');
    var history = Array.isArray(product.priceHistory) ? product.priceHistory.slice(-22) : [];
    var values = history.map(function (entry) { return Number(entry.price); }).filter(function (value) { return Number.isFinite(value) && value > 0; });
    if (values.length < 2) {
      values = [Number(product.currentPrice) || 0, Number(product.currentPrice) || 0];
    }
    var width = 220;
    var height = 30;
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    if (max === min) { max = min + 1; }
    var points = values.map(function (value, index) {
      var x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
      var y = height - 4 - ((value - min) / (max - min)) * (height - 8);
      return { x: x, y: y };
    });
    var line = points.map(function (point, index) {
      return (index === 0 ? 'M' : 'L') + point.x.toFixed(1) + ' ' + point.y.toFixed(1);
    }).join(' ');
    var area = line + ' L ' + width + ' ' + height + ' L 0 ' + height + ' Z';
    var svg = svgEl('svg', {
      class: 'sparkline',
      viewBox: '0 0 ' + width + ' ' + height,
      preserveAspectRatio: 'none',
      'aria-hidden': 'true'
    });
    var down = values[values.length - 1] < values[0];
    svg.appendChild(svgEl('path', { class: 'spark-area', d: area }));
    svg.appendChild(svgEl('path', { class: 'spark-line' + (down ? ' down' : ''), d: line, 'vector-effect': 'non-scaling-stroke' }));
    var last = points[points.length - 1];
    svg.appendChild(svgEl('circle', { class: 'spark-dot' + (down ? ' down' : ''), cx: last.x, cy: last.y, r: 2 }));
    wrap.appendChild(svg);
    return wrap;
  }

  function renderProductCard(product) {
    var card = node('article', 'product-card');
    var top = node('div', 'product-card-top');
    top.appendChild(createThumb(product, 'product-thumb'));

    var info = node('div', 'product-info');
    var name = node('button', 'product-name', product.title);
    name.type = 'button';
    name.dataset.action = 'open-product';
    name.dataset.id = product.id;
    info.appendChild(name);

    var store = storeInfo(product);
    var storeLine = node('div', 'product-store');
    var dot = node('span', 'store-dot');
    dot.style.background = store.accent;
    storeLine.appendChild(dot);
    storeLine.appendChild(node('span', null, product.store || store.name));
    info.appendChild(storeLine);

    var status = productStatus(product);
    var statusBadge = badge(status.label, status.variant);
    statusBadge.style.marginTop = '5px';
    info.appendChild(statusBadge);
    top.appendChild(info);
    card.appendChild(top);

    var priceRow = node('div', 'product-price-row');
    priceRow.appendChild(node('span', 'product-price', formatPrice(product.currentPrice, product.currency)));
    if (Number(product.originalPrice) > Number(product.currentPrice)) {
      priceRow.appendChild(node('span', 'product-mrp', formatPrice(product.originalPrice, product.currency)));
      var off = P.discountPercent(product.originalPrice, product.currentPrice);
      if (off > 0) priceRow.appendChild(node('span', 'product-off', off + '% off'));
    }
    card.appendChild(priceRow);

    if (product.targetPrice) {
      var target = node('div', 'product-target');
      target.appendChild(icon('target'));
      target.appendChild(node('span', null, 'Target'));
      target.appendChild(node('strong', null, formatPrice(product.targetPrice, product.currency)));
      if (Number(product.currentPrice) <= Number(product.targetPrice)) {
        target.appendChild(node('span', 'product-off', 'reached'));
      }
      card.appendChild(target);
    }

    card.appendChild(sparkline(product));

    var footer = node('div', 'product-card-footer');
    footer.appendChild(node('span', 'product-checked',
      product.lastChecked ? 'Checked ' + D.formatRelative(product.lastChecked) : 'Not checked yet'));
    var actions = node('div', 'product-actions');

    actions.appendChild(makeIconButton({
      action: 'check-product',
      id: product.id,
      icon: 'refresh',
      title: 'Check this price now'
    }));

    var href = U.cleanUrl(product.url);
    if (href) {
      var link = node('a', 'card-btn');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = 'Open product page';
      link.setAttribute('aria-label', 'Open product page');
      link.appendChild(icon('external'));
      actions.appendChild(link);
    }

    actions.appendChild(makeIconButton({
      action: 'delete-product',
      id: product.id,
      icon: 'trash',
      title: 'Remove this product',
      danger: true
    }));
    footer.appendChild(actions);
    card.appendChild(footer);
    return card;
  }

  function renderProductsResults() {
    var results = $('products-results');
    if (!results) return;
    var list = filteredProducts();
    setText($('toolbar-count'), list.length + ' of ' + state.products.length);
    clear(results);
    if (!list.length) {
      var empty = node('div', 'empty-state card');
      var iconWrap = node('div', 'empty-icon');
      iconWrap.appendChild(icon('search'));
      add(empty, iconWrap,
        node('h2', null, state.products.length ? 'No products match these filters' : 'No products tracked yet'),
        node('p', null, state.products.length
          ? 'Try a different search or clear the filters.'
          : 'Open a product page and click the Smart Price Tracker icon in your toolbar to add your first product.'));
      var actions = node('div', 'empty-actions');
      if (state.products.length) {
        actions.appendChild(makeButton({ label: 'Clear filters', icon: 'refresh', className: 'btn btn-secondary', action: 'reset-filters' }));
      } else {
        actions.appendChild(makeButton({ label: 'How to add a product', icon: 'plus', className: 'btn btn-primary', action: 'add-help' }));
      }
      empty.appendChild(actions);
      results.appendChild(empty);
      return;
    }
    var grid = node('div', 'product-grid');
    list.forEach(function (product) { grid.appendChild(renderProductCard(product)); });
    results.appendChild(grid);
  }

  function renderProducts(container) {
    var page = node('div', 'page');
    page.appendChild(renderPageHead(
      'Tracked products',
      state.products.length
        ? state.products.length + (state.products.length === 1 ? ' product' : ' products') + ' stored only in this browser.'
        : 'Products you track from the extension popup appear here.',
      [makeButton({ label: 'How to add', icon: 'plus', className: 'btn btn-primary', action: 'add-help' })],
      'Your watchlist'
    ));

    var toolbar = node('div', 'card toolbar');
    var search = node('div', 'search-field');
    search.appendChild(icon('search'));
    var searchInput = node('input', 'input');
    searchInput.id = 'product-search';
    searchInput.type = 'search';
    searchInput.placeholder = 'Search by name or store…';
    searchInput.autocomplete = 'off';
    searchInput.value = state.filters.query;
    searchInput.setAttribute('aria-label', 'Search tracked products');
    search.appendChild(searchInput);
    toolbar.appendChild(search);

    toolbar.appendChild(selectField('product-filter', [
      { value: 'all', label: 'All products' },
      { value: 'active', label: 'Auto checks on' },
      { value: 'paused', label: 'Paused' },
      { value: 'drops', label: 'Has dropped' },
      { value: 'lowest', label: 'At lowest' },
      { value: 'attention', label: 'Needs attention' }
    ], state.filters.filter, 'filter'));

    toolbar.appendChild(selectField('product-sort', [
      { value: 'newest', label: 'Newest first' },
      { value: 'checked', label: 'Recently checked' },
      { value: 'price-low', label: 'Price: low to high' },
      { value: 'price-high', label: 'Price: high to low' },
      { value: 'biggest-drop', label: 'Biggest drop' },
      { value: 'name', label: 'Name A–Z' }
    ], state.filters.sort, 'sort'));

    var count = node('span', 'toolbar-count');
    count.id = 'toolbar-count';
    toolbar.appendChild(count);
    page.appendChild(toolbar);

    var results = node('div');
    results.id = 'products-results';
    page.appendChild(results);
    container.appendChild(page);
    renderProductsResults();
  }

  /* --------------------------------------------------------------------- */
  /* Product detail                                                         */
  /* --------------------------------------------------------------------- */

  function siteForProduct(product) {
    var origin = originOf(product);
    for (var i = 0; i < state.sites.length; i++) {
      if (state.sites[i].origin === origin) return state.sites[i];
    }
    return null;
  }

  function statusBanner(product) {
    var banner = null;
    var title = '';
    var message = '';
    var action = null;
    var tone = 'warn';
    var iconName = 'alert';

    if (product.checkStatus === 'permission-required') {
      title = 'Site access is needed';
      message = 'Chrome needs permission to read this store for automatic checks. Your saved price is safe.';
      tone = 'warn';
      iconName = 'shield';
      action = makeButton({
        label: 'Allow access',
        icon: 'shield',
        className: 'btn btn-secondary btn-sm',
        action: 'allow-product-site',
        id: product.id
      });
    } else if (product.checkStatus === 'failed') {
      title = 'The last automatic check failed';
      message = product.lastError && product.lastError.message ? product.lastError.message : 'Your last saved price was kept. We will try again later.';
      tone = 'bad';
      iconName = 'alert';
      action = makeButton({
        label: 'Check now',
        icon: 'refresh',
        className: 'btn btn-secondary btn-sm',
        action: 'check-product',
        id: product.id
      });
    } else if (product.availability === 'OutOfStock' || product.availability === 'Discontinued') {
      title = product.availability === 'Discontinued' ? 'This product looks discontinued' : 'Currently out of stock';
      message = 'The last known price is kept, but availability may affect automatic checks.';
      tone = 'info';
      iconName = 'info';
    } else if (!product.trackingEnabled) {
      title = 'Tracking is paused';
      message = 'Automatic checks are off. Your saved history is still available, and you can update the price manually.';
      tone = 'info';
      iconName = 'pause';
    }

    if (!title) return null;
    banner = node('div', 'status-banner ' + tone);
    var iconWrap = node('div', 'status-banner-icon');
    iconWrap.appendChild(icon(iconName));
    banner.appendChild(iconWrap);
    var copy = node('div', 'status-banner-copy');
    copy.appendChild(node('strong', null, title));
    copy.appendChild(node('p', null, message));
    banner.appendChild(copy);
    if (action) banner.appendChild(action);
    banner.classList.add('actions');
    return banner;
  }

  function switchControl(options) {
    var opts = options || {};
    var label = node('label', 'switch');
    if (opts.title) label.title = opts.title;
    var input = node('input');
    input.type = 'checkbox';
    input.checked = !!opts.checked;
    if (opts.toggle) input.dataset.toggle = opts.toggle;
    if (opts.setting) input.dataset.setting = opts.setting;
    if (opts.id) input.dataset.id = opts.id;
    if (opts.disabled) input.disabled = true;
    if (opts.label) input.setAttribute('aria-label', opts.label);
    label.appendChild(input);
    label.appendChild(node('span', 'switch-track'));
    return label;
  }

  function statCard(label, value, note) {
    var card = node('div', 'stat-card');
    card.appendChild(node('span', 'stat-label', label));
    card.appendChild(node('span', 'stat-value', value));
    if (note) card.appendChild(node('span', 'stat-note', note));
    return card;
  }

  function renderHistoryCard(product) {
    var card = node('section', 'card card-pad');
    var head = node('div', 'section-head');
    var copy = node('div', 'section-head-copy');
    copy.appendChild(node('h2', 'section-title', 'Price history'));
    copy.appendChild(node('p', 'section-sub', 'Every confirmed observation, stored locally on this device.'));
    head.appendChild(copy);
    card.appendChild(head);

    var history = Array.isArray(product.priceHistory) ? product.priceHistory.slice() : [];
    if (!history.length) {
      card.appendChild(inlineEmpty('chart', 'No observations yet', 'The first recorded price appears here after tracking begins.'));
      return card;
    }

    history.sort(function (a, b) {
      return (D.parseDate(a.date) || 0) - (D.parseDate(b.date) || 0);
    });
    var rows = [];
    var previous = null;
    history.forEach(function (entry) {
      var price = Number(entry.price);
      rows.push({
        price: price,
        date: entry.date,
        source: entry.source,
        change: previous === null ? null : Math.round((price - previous) * 100) / 100
      });
      previous = price;
    });
    rows.reverse();
    var shown = rows.slice(0, 200);

    var wrap = node('div', 'table-wrap history-scroll');
    var table = node('table', 'history-table');
    var thead = node('thead');
    var headRow = node('tr');
    ['Date', 'Price', 'Change', 'Source'].forEach(function (label) {
      headRow.appendChild(node('th', null, label));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = node('tbody');
    shown.forEach(function (row) {
      var tr = node('tr');
      tr.appendChild(node('td', null, D.formatDate(row.date, { year: true })));
      tr.appendChild(node('td', 'price-cell', formatPrice(row.price, product.currency)));
      var changeCell = node('td');
      if (row.change === null) {
        changeCell.textContent = '—';
        changeCell.className = 'change-flat';
      } else if (row.change < 0) {
        changeCell.textContent = '−' + formatPrice(Math.abs(row.change), product.currency);
        changeCell.className = 'change-down';
      } else if (row.change > 0) {
        changeCell.textContent = '+' + formatPrice(row.change, product.currency);
        changeCell.className = 'change-up';
      } else {
        changeCell.textContent = 'No change';
        changeCell.className = 'change-flat';
      }
      tr.appendChild(changeCell);
      tr.appendChild(node('td', 'source-cell', sourceLabel(row.source)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);

    var foot = node('div', 'table-foot');
    foot.appendChild(node('span', null,
      shown.length < rows.length
        ? 'Showing the latest ' + shown.length + ' of ' + rows.length + ' observations'
        : rows.length + (rows.length === 1 ? ' observation' : ' observations')));
    foot.appendChild(node('span', null, 'First seen ' + D.formatShortDate(history[0].date)));
    card.appendChild(foot);
    return card;
  }

  function renderProductDetail(container, product) {
    var page = node('div', 'page');
    var back = node('a', 'detail-back');
    back.href = '#products';
    back.appendChild(icon('back'));
    back.appendChild(document.createTextNode('All products'));
    page.appendChild(back);

    var store = storeInfo(product);
    var status = productStatus(product);
    var hero = node('section', 'card detail-hero');
    hero.appendChild(createThumb(product, 'detail-thumb'));

    var info = node('div', 'detail-info');
    var storeLine = node('div', 'detail-store');
    var dot = node('span', 'store-dot');
    dot.style.background = store.accent;
    storeLine.appendChild(dot);
    storeLine.appendChild(node('span', null, product.store || store.name));
    storeLine.appendChild(badge(status.label, status.variant));
    if (product.availability && product.availability !== 'Unknown') {
      storeLine.appendChild(badge(product.availability === 'InStock' ? 'In stock' : product.availability,
        product.availability === 'InStock' ? 'badge-good' : 'badge-neutral'));
    }
    info.appendChild(storeLine);
    info.appendChild(node('h1', 'detail-title', product.title));

    var links = node('div', 'detail-links');
    var external = makeExternalLink(product, 'View product');
    if (external) links.appendChild(external);
    links.appendChild(makeButton({
      label: 'Copy link',
      className: 'link-action',
      action: 'copy-url',
      id: product.id,
      icon: 'link'
    }));
    links.appendChild(node('span', 'subtle', U.hostLabel(product.url)));
    info.appendChild(links);
    hero.appendChild(info);

    var priceBlock = node('div', 'detail-price-block');
    priceBlock.appendChild(node('span', 'detail-price', formatPrice(product.currentPrice, product.currency)));
    if (Number(product.originalPrice) > Number(product.currentPrice)) {
      var mrpRow = node('div', 'detail-mrp-row');
      mrpRow.appendChild(node('span', 'detail-mrp', formatPrice(product.originalPrice, product.currency)));
      var off = P.discountPercent(product.originalPrice, product.currentPrice);
      if (off > 0) mrpRow.appendChild(node('span', 'product-off', off + '% off'));
      priceBlock.appendChild(mrpRow);
    }
    var heroActions = node('div', 'detail-actions');
    heroActions.appendChild(makeButton({
      label: 'Check now',
      icon: 'refresh',
      className: 'btn btn-primary btn-sm',
      action: 'check-product',
      id: product.id
    }));
    heroActions.appendChild(makeButton({
      label: 'Remove',
      icon: 'trash',
      className: 'btn btn-danger btn-sm',
      action: 'delete-product',
      id: product.id
    }));
    priceBlock.appendChild(heroActions);
    hero.appendChild(priceBlock);
    page.appendChild(hero);

    var banner = statusBanner(product);
    if (banner) page.appendChild(banner);

    var layout = node('div', 'detail-layout');
    var main = node('div', 'detail-main');

    var stats = node('div', 'stat-grid');
    stats.appendChild(statCard('Lowest seen', formatPrice(product.lowestPrice, product.currency),
      Number(product.currentPrice) <= Number(product.lowestPrice) + 0.009 ? 'Current price is the lowest' : 'All-time low'));
    stats.appendChild(statCard('Highest seen', formatPrice(product.highestPrice, product.currency), 'All-time high'));
    stats.appendChild(statCard('Average', formatPrice(product.averagePrice, product.currency),
      (product.priceHistory ? product.priceHistory.length : 0) + ' observations'));
    var lastDrop = lastDropInfo(product);
    stats.appendChild(statCard('Price drops', String(product.totalDrops || 0),
      lastDrop ? 'Last drop ' + D.formatRelative(lastDrop.date) : 'No drops recorded'));
    main.appendChild(stats);

    var chartCard = node('section', 'card chart-card');
    var chartHead = node('div', 'chart-head');
    var chartCopy = node('div', 'section-head-copy');
    chartCopy.appendChild(node('h2', 'section-title', 'Price movement'));
    chartCopy.appendChild(node('p', 'section-sub', 'A local chart built from your saved price observations.'));
    chartHead.appendChild(chartCopy);
    var tabs = node('div', 'range-tabs');
    [
      ['7d', '7D'], ['30d', '30D'], ['90d', '90D'], ['all', 'All']
    ].forEach(function (range) {
      var tab = node('button', 'range-tab' + (state.chartRange === range[0] ? ' is-active' : ''), range[1]);
      tab.type = 'button';
      tab.dataset.action = 'chart-range';
      tab.dataset.range = range[0];
      tab.setAttribute('aria-pressed', state.chartRange === range[0] ? 'true' : 'false');
      tabs.appendChild(tab);
    });
    chartHead.appendChild(tabs);
    chartCard.appendChild(chartHead);
    var chartWrap = node('div', 'chart-wrap');
    chartWrap.id = 'price-chart';
    chartCard.appendChild(chartWrap);
    main.appendChild(chartCard);

    main.appendChild(renderHistoryCard(product));
    layout.appendChild(main);

    var side = node('aside', 'detail-side');
    var sticky = node('div', 'side-sticky');

    var targetCard = node('section', 'card control-card');
    targetCard.appendChild(node('h2', 'control-title', 'Price target'));
    targetCard.appendChild(node('p', 'control-sub', 'Get an alert when this product reaches your price.'));
    if (product.targetPrice) {
      var targetRow = node('div', 'control-row');
      var targetCopy = node('div', 'control-copy');
      targetCopy.appendChild(node('span', 'control-label', 'Current target'));
      targetCopy.appendChild(node('span', 'control-desc', formatPrice(product.targetPrice, product.currency)));
      targetRow.appendChild(targetCopy);
      targetRow.appendChild(makeButton({
        label: 'Clear',
        className: 'btn btn-ghost btn-sm',
        action: 'clear-target',
        id: product.id
      }));
      targetCard.appendChild(targetRow);
    }
    var targetForm = node('form', 'mini-form');
    targetForm.dataset.form = 'target';
    targetForm.dataset.id = product.id;
    var targetInput = node('input', 'input');
    targetInput.type = 'text';
    targetInput.name = 'target';
    targetInput.inputMode = 'decimal';
    targetInput.autocomplete = 'off';
    targetInput.placeholder = 'e.g. 4,000';
    targetInput.value = product.targetPrice ? plainAmount(product.targetPrice) : '';
    targetInput.setAttribute('aria-label', 'Target price');
    targetForm.appendChild(targetInput);
    targetForm.appendChild(makeButton({ label: 'Set', className: 'btn btn-primary btn-sm', type: 'submit' }));
    targetCard.appendChild(targetForm);
    targetCard.appendChild(node('span', 'control-hint', 'Alerts use the price saved by a check or manual update.'));
    sticky.appendChild(targetCard);

    var scheduleCard = node('section', 'card control-card');
    scheduleCard.appendChild(node('h2', 'control-title', 'Monitoring'));
    scheduleCard.appendChild(node('p', 'control-sub', 'Choose how often this product is checked. Chrome must be open.'));

    var frequencyRow = node('div', 'control-row');
    var frequencyCopy = node('div', 'control-copy');
    frequencyCopy.appendChild(node('span', 'control-label', 'Check frequency'));
    frequencyCopy.appendChild(node('span', 'control-desc', 'Automatic checks run in the background without opening a tab.'));
    frequencyRow.appendChild(frequencyCopy);
    var frequencySelect = selectField('frequency-' + product.id, [
      { value: '6', label: 'Every 6 hours' },
      { value: '12', label: 'Every 12 hours' },
      { value: '24', label: 'Every 24 hours' }
    ], String(product.checkFrequency || 12), 'frequency');
    frequencySelect.dataset.id = product.id;
    frequencySelect.setAttribute('aria-label', 'Check frequency');
    frequencyRow.appendChild(frequencySelect);
    scheduleCard.appendChild(frequencyRow);

    var monitorRow = node('div', 'control-row');
    var monitorCopy = node('div', 'control-copy');
    monitorCopy.appendChild(node('span', 'control-label', 'Automatic checks'));
    monitorCopy.appendChild(node('span', 'control-desc', 'Requires one-time access to this store.'));
    monitorRow.appendChild(monitorCopy);
    monitorRow.appendChild(switchControl({
      toggle: 'monitoring',
      id: product.id,
      checked: product.monitoringEnabled,
      label: 'Automatic checks for ' + product.title
    }));
    scheduleCard.appendChild(monitorRow);

    var trackRow = node('div', 'control-row');
    var trackCopy = node('div', 'control-copy');
    trackCopy.appendChild(node('span', 'control-label', 'Track this product'));
    trackCopy.appendChild(node('span', 'control-desc', 'Turn off to pause all automatic checks.'));
    trackRow.appendChild(trackCopy);
    trackRow.appendChild(switchControl({
      toggle: 'tracking',
      id: product.id,
      checked: product.trackingEnabled,
      label: 'Track ' + product.title
    }));
    scheduleCard.appendChild(trackRow);

    var notifyRow = node('div', 'control-row');
    var notifyCopy = node('div', 'control-copy');
    notifyCopy.appendChild(node('span', 'control-label', 'Notifications'));
    notifyCopy.appendChild(node('span', 'control-desc',
      state.settings.notificationsEnabled ? 'Price drops and target alerts for this product.' : 'Global notifications are off in Settings.'));
    notifyRow.appendChild(notifyCopy);
    notifyRow.appendChild(switchControl({
      toggle: 'notifications',
      id: product.id,
      checked: product.notificationsEnabled,
      label: 'Notifications for ' + product.title
    }));
    scheduleCard.appendChild(notifyRow);

    var divider = node('div', 'control-divider');
    scheduleCard.appendChild(divider);

    var lastRow = node('div', 'control-row');
    lastRow.appendChild(node('span', 'control-label', 'Last checked'));
    lastRow.appendChild(node('span', 'control-value',
      product.lastChecked ? D.formatRelative(product.lastChecked) : 'Never'));
    scheduleCard.appendChild(lastRow);

    var nextRow = node('div', 'control-row');
    nextRow.appendChild(node('span', 'control-label', 'Next check'));
    nextRow.appendChild(node('span', 'control-value',
      !product.trackingEnabled ? 'Paused'
        : (!product.monitoringEnabled ? 'Manual only'
          : (product.nextCheck ? D.formatRelativeFuture(product.nextCheck) : 'Not scheduled'))));
    scheduleCard.appendChild(nextRow);

    var site = siteForProduct(product);
    var siteRow = node('div', 'control-row');
    var siteCopy = node('div', 'control-copy');
    siteCopy.appendChild(node('span', 'control-label', 'Site access'));
    siteCopy.appendChild(node('span', 'control-desc', site ? site.origin : U.originPattern(product.url) || 'Unavailable'));
    siteRow.appendChild(siteCopy);
    if (site && site.granted) {
      siteRow.appendChild(badge('Granted', 'badge-good'));
    } else {
      siteRow.appendChild(makeButton({
        label: 'Allow',
        className: 'btn btn-secondary btn-sm',
        action: 'allow-product-site',
        id: product.id
      }));
    }
    scheduleCard.appendChild(siteRow);

    sticky.appendChild(scheduleCard);
    side.appendChild(sticky);
    layout.appendChild(side);
    page.appendChild(layout);
    container.appendChild(page);

    renderChart(product);
  }

  /* --------------------------------------------------------------------- */
  /* Chart                                                                  */
  /* --------------------------------------------------------------------- */

  function svgEl(tag, attributes) {
    var element = document.createElementNS(NS, tag);
    if (attributes) {
      Object.keys(attributes).forEach(function (key) {
        element.setAttribute(key, attributes[key]);
      });
    }
    return element;
  }

  function chartEmpty(message) {
    var empty = node('div', 'chart-empty');
    empty.appendChild(icon('chart'));
    empty.appendChild(node('span', null, message));
    return empty;
  }

  function renderChart(product) {
    var wrap = $('price-chart');
    if (!wrap) return;
    clear(wrap);
    var currency = product.currency || 'INR';
    var history = D.filterHistoryByRange(product.priceHistory, state.chartRange);
    if (!history.length) {
      wrap.appendChild(chartEmpty('No price observations in this range yet. Try a wider range.'));
      return;
    }

    var width = 760;
    var height = 280;
    var margin = { top: 18, right: 16, bottom: 34, left: 64 };
    var plotW = width - margin.left - margin.right;
    var plotH = height - margin.top - margin.bottom;
    var single = history.length === 1;
    var points = history.map(function (entry) {
      return {
        price: Number(entry.price),
        date: entry.date,
        source: entry.source,
        ms: D.parseDate(entry.date)
      };
    }).filter(function (point) {
      return Number.isFinite(point.price) && point.ms !== null;
    });
    if (!points.length) {
      wrap.appendChild(chartEmpty('No valid price observations in this range yet.'));
      return;
    }

    var minT = points[0].ms;
    var maxT = points[points.length - 1].ms;
    if (single || minT === maxT) {
      minT -= D.DAY;
      maxT += D.DAY;
    }
    var minP = Math.min.apply(null, points.map(function (point) { return point.price; }));
    var maxP = Math.max.apply(null, points.map(function (point) { return point.price; }));
    if (minP === maxP) {
      minP = Math.max(0, minP * 0.96);
      maxP = maxP * 1.04;
    } else {
      var pad = (maxP - minP) * 0.1;
      minP = Math.max(0, minP - pad);
      maxP = maxP + pad;
    }

    function xFor(ms) {
      return margin.left + ((ms - minT) / (maxT - minT)) * plotW;
    }
    function yFor(price) {
      return margin.top + ((maxP - price) / (maxP - minP)) * plotH;
    }

    var coords = points.map(function (point) {
      return {
        x: single ? margin.left + plotW / 2 : xFor(point.ms),
        y: yFor(point.price),
        price: point.price,
        date: point.date,
        source: point.source
      };
    });

    var svg = svgEl('svg', {
      class: 'chart-svg',
      viewBox: '0 0 ' + width + ' ' + height,
      role: 'img',
      'aria-label': 'Price history for ' + product.title
    });
    var titleEl = svgEl('title');
    titleEl.textContent = 'Price history for ' + product.title;
    svg.appendChild(titleEl);

    var primary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#4f46e5';
    var primary2 = getComputedStyle(document.documentElement).getPropertyValue('--primary-2').trim() || '#7c3aed';
    var defs = svgEl('defs');
    var areaGradient = svgEl('linearGradient', { id: 'chartAreaGradient', x1: '0', y1: '0', x2: '0', y2: '1' });
    areaGradient.appendChild(svgEl('stop', { offset: '0%', 'stop-color': primary, 'stop-opacity': '0.24' }));
    areaGradient.appendChild(svgEl('stop', { offset: '100%', 'stop-color': primary2, 'stop-opacity': '0.02' }));
    defs.appendChild(areaGradient);
    var lineGradient = svgEl('linearGradient', { id: 'chartLineGradient', x1: '0', y1: '0', x2: '1', y2: '0' });
    lineGradient.appendChild(svgEl('stop', { offset: '0%', 'stop-color': primary }));
    lineGradient.appendChild(svgEl('stop', { offset: '100%', 'stop-color': primary2 }));
    defs.appendChild(lineGradient);
    svg.appendChild(defs);

    var yTicks = 4;
    for (var i = 0; i <= yTicks; i++) {
      var value = minP + ((maxP - minP) * i) / yTicks;
      var y = yFor(value);
      svg.appendChild(svgEl('line', {
        class: 'grid-line',
        x1: margin.left,
        y1: y,
        x2: margin.left + plotW,
        y2: y
      }));
      var yText = svgEl('text', { class: 'axis-text y', x: margin.left - 10, y: y + 3 });
      yText.textContent = formatCompact(value, currency);
      svg.appendChild(yText);
    }

    var withYear = state.chartRange === 'all' || (maxT - minT) > 120 * D.DAY;
    var xTickCount = single ? 1 : 4;
    for (var j = 0; j < xTickCount; j++) {
      var ratio = xTickCount === 1 ? 0.5 : j / (xTickCount - 1);
      var tickMs = single ? points[0].ms : minT + (maxT - minT) * ratio;
      var x = single ? margin.left + plotW / 2 : xFor(tickMs);
      var xText = svgEl('text', { class: 'axis-text x', x: x, y: height - 10 });
      xText.textContent = D.formatChartDate(new Date(tickMs).toISOString(), withYear);
      svg.appendChild(xText);
    }

    if (!single) {
      var linePath = coords.map(function (point, index) {
        return (index === 0 ? 'M' : 'L') + point.x.toFixed(2) + ' ' + point.y.toFixed(2);
      }).join(' ');
      var baseY = margin.top + plotH;
      var areaPath = linePath +
        ' L ' + coords[coords.length - 1].x.toFixed(2) + ' ' + baseY +
        ' L ' + coords[0].x.toFixed(2) + ' ' + baseY + ' Z';
      svg.appendChild(svgEl('path', { class: 'area-fill', d: areaPath }));
      svg.appendChild(svgEl('path', { class: 'price-line', d: linePath }));
    }

    var dotStep = Math.max(1, Math.ceil(coords.length / 40));
    coords.forEach(function (point, index) {
      if (!single && index % dotStep !== 0 && index !== coords.length - 1) return;
      var circle = svgEl('circle', {
        class: 'price-dot' + (point.price <= Number(product.lowestPrice) + 0.009 ? ' is-low' : ''),
        cx: point.x,
        cy: point.y,
        r: single ? 5 : 2.8
      });
      var circleTitle = svgEl('title');
      circleTitle.textContent = formatPrice(point.price, currency) + ' · ' + D.formatDate(point.date);
      circle.appendChild(circleTitle);
      svg.appendChild(circle);
    });

    var crosshair = svgEl('line', {
      class: 'crosshair',
      x1: 0,
      y1: margin.top,
      x2: 0,
      y2: margin.top + plotH
    });
    var hoverDot = svgEl('circle', { class: 'hover-dot', cx: 0, cy: 0, r: 4.5 });
    svg.appendChild(crosshair);
    svg.appendChild(hoverDot);
    svg.appendChild(svgEl('rect', {
      class: 'hit-area',
      x: margin.left,
      y: margin.top,
      width: plotW,
      height: plotH
    }));

    wrap.appendChild(svg);
    var tooltip = node('div', 'chart-tooltip');
    tooltip.setAttribute('aria-hidden', 'true');
    wrap.appendChild(tooltip);
    if (single) {
      wrap.appendChild(node('div', 'chart-single-note', 'Only one observation in this range.'));
    }

    function hideHover() {
      crosshair.style.opacity = '0';
      hoverDot.style.opacity = '0';
      tooltip.classList.remove('is-visible');
    }

    function showHover(clientX) {
      var rect = svg.getBoundingClientRect();
      var wrapRect = wrap.getBoundingClientRect();
      var localX = ((clientX - rect.left) / rect.width) * width;
      var best = coords[0];
      var distance = Infinity;
      coords.forEach(function (point) {
        var d = Math.abs(point.x - localX);
        if (d < distance) {
          distance = d;
          best = point;
        }
      });
      crosshair.setAttribute('x1', best.x);
      crosshair.setAttribute('x2', best.x);
      crosshair.style.opacity = '1';
      hoverDot.setAttribute('cx', best.x);
      hoverDot.setAttribute('cy', best.y);
      hoverDot.style.opacity = '1';
      clear(tooltip);
      tooltip.appendChild(node('strong', null, formatPrice(best.price, currency)));
      tooltip.appendChild(node('span', null, D.formatDate(best.date) + ' · ' + sourceLabel(best.source)));
      tooltip.style.left = ((best.x / width) * rect.width + (rect.left - wrapRect.left)) + 'px';
      tooltip.style.top = ((best.y / height) * rect.height + (rect.top - wrapRect.top)) + 'px';
      tooltip.classList.add('is-visible');
    }

    svg.addEventListener('pointermove', function (event) { showHover(event.clientX); });
    svg.addEventListener('pointerdown', function (event) { showHover(event.clientX); });
    svg.addEventListener('pointerleave', hideHover);
    svg.addEventListener('pointercancel', hideHover);
  }

  /* --------------------------------------------------------------------- */
  /* Settings                                                               */
  /* --------------------------------------------------------------------- */

  function settingsCard(iconName, title, description) {
    var card = node('section', 'card settings-card');
    var head = node('div', 'settings-head');
    var iconWrap = node('div', 'settings-icon');
    iconWrap.appendChild(icon(iconName));
    var copy = node('div', 'settings-head-copy');
    copy.appendChild(node('h2', 'settings-title', title));
    if (description) copy.appendChild(node('p', 'settings-desc', description));
    head.appendChild(iconWrap);
    head.appendChild(copy);
    card.appendChild(head);
    return card;
  }

  function settingRow(label, help, control) {
    var row = node('div', 'setting-row');
    var copy = node('div', 'setting-copy');
    copy.appendChild(node('span', 'setting-label', label));
    if (help) copy.appendChild(node('span', 'setting-help', help));
    row.appendChild(copy);
    var wrap = node('div', 'setting-control');
    wrap.appendChild(control);
    row.appendChild(wrap);
    return row;
  }

  function settingSelect(key, id, options, value) {
    var select = selectField(id, options, value, null);
    select.dataset.setting = key;
    return select;
  }

  function settingSwitch(key, checked, label, disabled) {
    return switchControl({
      setting: key,
      checked: checked,
      label: label,
      disabled: disabled
    });
  }

  function themeSegments() {
    var group = node('div', 'segmented');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Theme');
    [
      ['system', 'System'],
      ['light', 'Light'],
      ['dark', 'Dark']
    ].forEach(function (pair) {
      var active = state.settings.theme === pair[0];
      var button = node('button', 'segment' + (active ? ' is-active' : ''), pair[1]);
      button.type = 'button';
      button.dataset.action = 'set-theme';
      button.dataset.theme = pair[0];
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      group.appendChild(button);
    });
    return group;
  }

  function updateThemeSegments() {
    document.querySelectorAll('[data-action="set-theme"]').forEach(function (button) {
      var active = button.dataset.theme === state.settings.theme;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function saveNoteNode() {
    var note = node('span', 'save-note');
    note.id = 'settings-save-note';
    note.setAttribute('aria-live', 'polite');
    note.appendChild(icon('check'));
    note.appendChild(node('span', null, 'Saved locally'));
    return note;
  }

  function setSaveNote(mode, text) {
    var note = $('settings-save-note');
    if (!note) return;
    note.className = 'save-note' + (mode ? ' is-' + mode : '');
    var label = note.querySelector('span');
    if (label) label.textContent = text;
  }

  function queueSettingsSave() {
    clearTimeout(state.settingsTimer);
    state.settingsSaving = true;
    setSaveNote('saving', 'Saving…');
    var seq = (state.settingsSeq || 0) + 1;
    state.settingsSeq = seq;
    state.settingsTimer = setTimeout(function () {
      sendMessage('UPDATE_SETTINGS', { settings: state.settings }).then(function (response) {
        if (seq !== state.settingsSeq) return;
        state.settings = response.settings;
        state.settingsSaving = false;
        applyTheme();
        setSaveNote('saved', 'Saved locally');
        clearTimeout(state.settingsSavedTimer);
        state.settingsSavedTimer = setTimeout(function () {
          if (seq === state.settingsSeq) setSaveNote('', 'Saved locally');
        }, 2600);
      }).catch(function (error) {
        if (seq !== state.settingsSeq) return;
        state.settingsSaving = false;
        setSaveNote('error', 'Could not save');
        toast(normalizeError(error).message, 'error', 5200);
      });
    }, 420);
  }

  function setTheme(mode) {
    if (['system', 'light', 'dark'].indexOf(mode) === -1) return;
    state.settings.theme = mode;
    applyTheme();
    updateThemeSegments();
    queueSettingsSave();
  }

  function toggleTheme() {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    setTheme(dark ? 'light' : 'dark');
  }

  function renderSettings(container) {
    var page = node('div', 'page');
    page.appendChild(renderPageHead(
      'Settings',
      'Tune monitoring, notifications and your local backups.',
      [saveNoteNode()],
      'Preferences'
    ));

    var grid = node('div', 'settings-grid');

    var monitoring = settingsCard('clock', 'Monitoring', 'How often prices are checked. Chrome must be open for automatic checks.');
    monitoring.appendChild(settingRow(
      'Default check frequency',
      'New products start with this schedule. You can change it per product.',
      settingSelect('defaultFrequency', 'setting-default-frequency', [
        { value: '6', label: 'Every 6 hours' },
        { value: '12', label: 'Every 12 hours' },
        { value: '24', label: 'Every 24 hours' }
      ], String(state.settings.defaultFrequency))
    ));
    monitoring.appendChild(settingRow(
      'Checks at the same time',
      'Lower this if price checks feel heavy on your connection.',
      settingSelect('maxConcurrentChecks', 'setting-max-concurrent', [
        { value: '1', label: '1 check' },
        { value: '2', label: '2 checks' },
        { value: '3', label: '3 checks' },
        { value: '4', label: '4 checks' }
      ], String(state.settings.maxConcurrentChecks))
    ));
    monitoring.appendChild(node('div', 'settings-hint',
      'Checks fetch and parse the product page in the background without opening a tab. Pages blocked by CAPTCHA or bot protection are never bypassed.'));
    grid.appendChild(monitoring);

    var notifications = settingsCard('bell', 'Notifications', 'Alerts are generated locally by Chrome. Nothing is sent to a server.');
    notifications.appendChild(settingRow(
      'Enable notifications',
      'Master switch for price-drop and target alerts.',
      settingSwitch('notificationsEnabled', state.settings.notificationsEnabled, 'Enable notifications')
    ));
    notifications.appendChild(settingRow(
      'Price drops',
      'Notify when a watched price falls.',
      settingSwitch('priceDropNotifications', state.settings.priceDropNotifications,
        'Notify about price drops', !state.settings.notificationsEnabled)
    ));
    notifications.appendChild(settingRow(
      'Target reached',
      'Notify when a product reaches your target price.',
      settingSwitch('targetNotifications', state.settings.targetNotifications,
        'Notify when a target is reached', !state.settings.notificationsEnabled)
    ));
    notifications.appendChild(node('div', 'settings-hint',
      'Each product can also mute its own notifications from its detail page.'));
    grid.appendChild(notifications);

    var appearance = settingsCard('sun', 'Appearance', 'Choose how the dashboard and popup look on this device.');
    appearance.appendChild(settingRow('Theme', 'System follows your operating-system setting.', themeSegments()));
    appearance.appendChild(settingRow(
      'Price display',
      'Show the rupee symbol or the currency code.',
      settingSelect('currencyDisplay', 'setting-currency', [
        { value: 'symbol', label: 'Symbol (₹)' },
        { value: 'code', label: 'Code (INR)' }
      ], state.settings.currencyDisplay)
    ));
    grid.appendChild(appearance);

    var storageCard = settingsCard('database', 'Storage & backup', 'Everything is stored in chrome.storage.local on this device.');
    var storage = state.storage || { used: 0, quota: 1, percent: 0 };
    var bar = node('div', 'storage-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Local storage used');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(storage.percent));
    var fill = node('div', 'storage-fill');
    fill.style.width = Math.min(100, Math.max(1, Number(storage.percent) || 0)) + '%';
    bar.appendChild(fill);
    storageCard.appendChild(bar);
    var meta = node('div', 'storage-meta');
    meta.appendChild(node('span', null, V.formatBytes(storage.used) + ' used'));
    meta.appendChild(node('span', null, storage.percent + '% of ' + V.formatBytes(storage.quota)));
    storageCard.appendChild(meta);

    var observations = state.products.reduce(function (total, product) {
      return total + (Array.isArray(product.priceHistory) ? product.priceHistory.length : 0);
    }, 0);
    var totals = node('div', 'import-summary');
    [
      ['Products', String(state.products.length)],
      ['Observations', String(observations)]
    ].forEach(function (pair) {
      var stat = node('div', 'import-stat');
      stat.appendChild(node('span', null, pair[0]));
      stat.appendChild(node('strong', null, pair[1]));
      totals.appendChild(stat);
    });
    storageCard.appendChild(totals);

    var dataActions = node('div', 'data-actions');
    dataActions.appendChild(makeButton({
      label: 'Export JSON', icon: 'download', className: 'btn btn-secondary btn-sm', action: 'export-json'
    }));
    dataActions.appendChild(makeButton({
      label: 'Export CSV', icon: 'download', className: 'btn btn-secondary btn-sm', action: 'export-csv'
    }));
    dataActions.appendChild(makeButton({
      label: 'Import backup', icon: 'upload', className: 'btn btn-secondary btn-sm', action: 'import-json'
    }));
    storageCard.appendChild(dataActions);
    storageCard.appendChild(node('div', 'settings-hint',
      'Backups include products, price history and settings. Site permissions are never exported.'));
    grid.appendChild(storageCard);

    var sitesCard = settingsCard('shield', 'Site access', 'Automatic checks can read only the stores you explicitly allow.');
    if (!state.sites.length) {
      sitesCard.appendChild(inlineEmpty('lock', 'No site access needed yet',
        'Stores appear here after you add products. Manual updates never need site access.'));
    } else {
      var siteList = node('div', 'site-access-list');
      state.sites.forEach(function (site) {
        var row = node('div', 'site-row');
        var avatar = node('div', 'site-avatar', site.store.initials || 'ST');
        avatar.style.setProperty('--store-accent', site.store.accent || '#6d5efc');
        row.appendChild(avatar);
        var copy = node('div', 'site-copy');
        copy.appendChild(node('span', 'site-origin', site.origin));
        copy.appendChild(node('span', 'site-meta',
          site.store.name + ' · ' + site.count + (site.count === 1 ? ' product' : ' products')));
        row.appendChild(copy);
        var actions = node('div', 'site-actions');
        if (site.granted) {
          actions.appendChild(badge('Granted', 'badge-good'));
          actions.appendChild(makeButton({
            label: 'Remove', className: 'btn btn-ghost btn-sm', action: 'revoke-site',
            origin: site.origin, url: site.url
          }));
        } else {
          actions.appendChild(makeButton({
            label: 'Allow', className: 'btn btn-secondary btn-sm', action: 'allow-site',
            origin: site.origin, url: site.url
          }));
        }
        row.appendChild(actions);
        siteList.appendChild(row);
      });
      sitesCard.appendChild(siteList);
    }
    sitesCard.appendChild(noteNode('lock',
      'Access is optional and requested only for stores you choose. Removing access stops automatic checks but keeps your saved history.'));
    sitesCard.classList.add('full-span');
    grid.appendChild(sitesCard);

    var danger = settingsCard('alert', 'Danger zone', 'These actions cannot be undone.');
    danger.classList.add('danger-zone');
    var dangerRow = node('div', 'danger-row');
    var dangerCopy = node('div', 'setting-copy');
    dangerCopy.appendChild(node('span', 'setting-label', 'Remove all products'));
    dangerCopy.appendChild(node('span', 'setting-help',
      state.products.length
        ? 'Deletes ' + state.products.length + (state.products.length === 1 ? ' product' : ' products') + ' and all price history. Export a backup first.'
        : 'There are no products to remove.'));
    dangerRow.appendChild(dangerCopy);
    dangerRow.appendChild(makeButton({
      label: 'Remove all', icon: 'trash', className: 'btn btn-danger btn-sm',
      action: 'clear-all', disabled: !state.products.length
    }));
    danger.appendChild(dangerRow);
    grid.appendChild(danger);

    var about = settingsCard('info', 'About', 'Smart Price Drop Tracker ' + chrome.runtime.getManifest().version);
    var aboutList = node('ul', 'about-list');
    [
      'No account, backend, analytics or remote code.',
      'Product details and price history stay in this browser.',
      'Notifications are created locally by Chrome.',
      'Supported stores: Amazon India, Flipkart, Myntra, AJIO, Croma, Reliance Digital, Tata CLiQ and Meesho.'
    ].forEach(function (text) {
      var item = node('li');
      item.appendChild(icon('check'));
      item.appendChild(node('span', null, text));
      aboutList.appendChild(item);
    });
    about.appendChild(aboutList);
    about.appendChild(noteNode('shield',
      'Removing the extension deletes its local data. Export a JSON backup if you want to keep your price history.'));
    grid.appendChild(about);

    page.appendChild(grid);
    container.appendChild(page);
  }

  /* --------------------------------------------------------------------- */
  /* Export / import                                                        */
  /* --------------------------------------------------------------------- */

  function fileStamp() {
    var now = new Date();
    function pad(value) { return String(value).padStart(2, '0'); }
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  }

  function downloadFile(filename, content, mime) {
    var blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var link = node('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  async function exportJson(button) {
    if (button) setBusy(button, true, 'Preparing…');
    try {
      var payload = await Storage.exportData();
      downloadFile(
        'smart-price-tracker-backup-' + fileStamp() + '.json',
        JSON.stringify(payload, null, 2),
        'application/json'
      );
      toast('JSON backup exported.', 'success');
    } catch (error) {
      toast(normalizeError(error).message, 'error', 5200);
    } finally {
      if (button) setBusy(button, false);
    }
  }

  async function exportCsv(button) {
    if (button) setBusy(button, true, 'Preparing…');
    try {
      var csv = '\ufeff' + DM.toCsv(state.products);
      downloadFile(
        'smart-price-tracker-products-' + fileStamp() + '.csv',
        csv,
        'text/csv;charset=utf-8'
      );
      toast('CSV export ready.', 'success');
    } catch (error) {
      toast(normalizeError(error).message, 'error', 5200);
    } finally {
      if (button) setBusy(button, false);
    }
  }

  function triggerImport() {
    if (!el['import-file-input']) return;
    el['import-file-input'].value = '';
    el['import-file-input'].click();
  }

  async function handleImportFile(file) {
    if (!file) return;
    if (file.size > V.LIMITS.MAX_IMPORT_BYTES) {
      toast(V.ERROR_MESSAGES.IMPORT_TOO_LARGE, 'error', 5200);
      return;
    }
    var text;
    try {
      text = await file.text();
    } catch (_) {
      toast('The selected file could not be read.', 'error', 5200);
      return;
    }
    var raw;
    try {
      raw = JSON.parse(text);
    } catch (_) {
      toast('This file is not valid JSON.', 'error', 5200);
      return;
    }
    var validated;
    try {
      validated = DM.validateBackup(raw);
    } catch (error) {
      toast(normalizeError(error).message, 'error', 5600);
      return;
    }
    openImportModal(raw, validated, file.name);
  }

  function importStat(label, value) {
    var stat = node('div', 'import-stat');
    stat.appendChild(node('span', null, label));
    stat.appendChild(node('strong', null, value));
    return stat;
  }

  function openImportModal(raw, validated, fileName) {
    state.pendingImport = { raw: raw, validated: validated, fileName: fileName };
    var body = [];
    var intro = node('p');
    intro.appendChild(document.createTextNode('Review the backup '));
    intro.appendChild(node('strong', null, fileName));
    intro.appendChild(document.createTextNode(' before importing.'));
    body.push(intro);

    var summary = node('div', 'import-summary');
    summary.appendChild(importStat('Valid products', String(validated.products.length)));
    summary.appendChild(importStat('Skipped records', String(validated.skipped)));
    summary.appendChild(importStat('Settings', validated.settings ? 'Included' : 'None'));
    summary.appendChild(importStat('Exported',
      validated.exportedAt ? D.formatDate(validated.exportedAt, { year: true }) : 'Unknown'));
    body.push(summary);

    if (validated.errors.length) {
      var errors = node('ul', 'import-errors');
      validated.errors.forEach(function (message) {
        errors.appendChild(node('li', null, message));
      });
      body.push(errors);
    }

    var group = node('div', 'radio-group');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Import mode');
    [
      ['merge', 'Merge with existing products', 'Adds new products and skips ones already tracked.', true],
      ['replace', 'Replace everything', 'Removes current products first, then imports this backup.', false]
    ].forEach(function (option) {
      var label = node('label', 'radio-card');
      var input = node('input');
      input.type = 'radio';
      input.name = 'import-mode';
      input.value = option[0];
      input.checked = option[3];
      label.appendChild(input);
      var copy = node('div');
      copy.appendChild(node('strong', null, option[1]));
      copy.appendChild(node('small', null, option[2]));
      label.appendChild(copy);
      group.appendChild(label);
    });
    body.push(group);

    var includeLabel = node('label', 'checkbox-row');
    var include = node('input');
    include.type = 'checkbox';
    include.id = 'import-settings';
    include.checked = !!validated.settings;
    include.disabled = !validated.settings;
    includeLabel.appendChild(include);
    includeLabel.appendChild(node('span', null,
      validated.settings
        ? 'Also import settings (frequency, notifications, theme and display)'
        : 'This backup does not contain settings'));
    body.push(includeLabel);

    body.push(noteNode('alert',
      'Replace mode deletes the products currently in this browser. Export a backup first if you might need them.',
      'bad'));

    openModal({
      title: 'Import backup',
      wide: true,
      body: body,
      actions: [
        {
          label: 'Cancel',
          className: 'btn btn-secondary',
          onClick: function () { return true; }
        },
        {
          label: 'Import backup',
          className: 'btn btn-primary',
          busyLabel: 'Importing…',
          onClick: async function () {
            if (!state.pendingImport) throw new Error('The selected backup is no longer available.');
            var modeInput = el['modal-body'].querySelector('input[name="import-mode"]:checked');
            var includeInput = el['modal-body'].querySelector('#import-settings');
            var response = await sendMessage('IMPORT_BACKUP', {
              data: state.pendingImport.raw,
              mode: modeInput ? modeInput.value : 'merge',
              includeSettings: !!(includeInput && includeInput.checked)
            });
            state.pendingImport = null;
            var message = 'Imported ' + response.imported +
              (response.imported === 1 ? ' product' : ' products') + '.';
            if (response.skipped) {
              message += ' Skipped ' + response.skipped +
                (response.skipped === 1 ? ' duplicate or invalid record.' : ' duplicate or invalid records.');
            }
            toast(message, 'success', 5600);
            await refresh({ scroll: false });
            return true;
          }
        }
      ]
    });
  }

  /* --------------------------------------------------------------------- */
  /* Product and site actions                                               */
  /* --------------------------------------------------------------------- */

  function copyProductUrl(product) {
    var url = product ? U.cleanUrl(product.url) : '';
    if (!url) {
      toast('This product has no valid link.', 'error');
      return;
    }
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      toast('Clipboard access is not available in this browser.', 'error');
      return;
    }
    navigator.clipboard.writeText(url).then(function () {
      toast('Product link copied.', 'success');
    }).catch(function () {
      toast('The link could not be copied.', 'error', 4200);
    });
  }

  async function checkProduct(id, button) {
    var product = getProduct(id);
    if (!product) {
      toast(V.ERROR_MESSAGES.PRODUCT_NOT_FOUND, 'error');
      return;
    }
    setBusy(button, true, 'Checking…');
    try {
      var response = await sendMessage('MANUAL_UPDATE', { id: id });
      var report = response.report;
      if (report && report.isDrop) {
        toast('Price dropped to ' + formatPrice(report.price, product.currency) +
          ' (down ' + formatPrice(report.dropAmount, product.currency) + ').', 'success', 5400);
      } else if (report && report.changed) {
        toast('Price updated to ' + formatPrice(report.price, product.currency) + '.', 'success', 5200);
      } else {
        toast('Price checked. No change.', 'success');
      }
      await refresh({ scroll: false });
    } catch (error) {
      var info = normalizeError(error);
      if (info.code === 'PERMISSION_REQUIRED' || info.code === 'PERMISSION_DENIED') {
        openPermissionModal(product);
      } else {
        toast(info.message, 'error', 5600);
      }
    } finally {
      setBusy(button, false);
    }
  }

  async function clearTarget(product, button) {
    if (!product) return;
    setBusy(button, true, 'Clearing…');
    try {
      await sendMessage('SET_TARGET', { id: product.id, targetPrice: null });
      toast('Target price cleared.', 'success');
      await refresh({ scroll: false });
    } catch (error) {
      toast(normalizeError(error).message, 'error', 5200);
      setBusy(button, false);
    }
  }

  function requestSiteAccess(url, button) {
    // Chrome requires the permission request to start inside the user gesture.
    var request = Client.requestSitePermission(url);
    if (button) setBusy(button, true, 'Waiting for Chrome…');
    return request.then(function (result) {
      if (button) setBusy(button, false);
      if (!result.granted) {
        toast(result.error || 'Permission was not granted. Manual updates still work.', 'warning', 5200);
        return false;
      }
      return sendMessage('REBUILD_ALARMS').catch(function () {
        return null;
      }).then(function () {
        toast('Site access granted. Automatic checks will resume.', 'success', 5200);
        return refresh({ scroll: false }).then(function () { return true; });
      });
    }).catch(function (error) {
      if (button) setBusy(button, false);
      toast(normalizeError(error).message, 'error', 5200);
      return false;
    });
  }

  function openPermissionModal(product) {
    if (!product) return;
    var origin = originOf(product) || U.hostLabel(product.url);
    var body = [];
    var copy = node('p');
    copy.appendChild(document.createTextNode('Chrome needs permission to read '));
    copy.appendChild(node('strong', null, origin));
    copy.appendChild(document.createTextNode(' when an automatic check runs.'));
    body.push(copy);
    body.push(node('div', 'modal-origin', origin));
    body.push(noteNode('info',
      'Manual updates and your saved history work without this permission. Access is requested only for this store.'));
    openModal({
      title: 'Allow site access',
      body: body,
      actions: [
        {
          label: 'Not now',
          className: 'btn btn-secondary',
          onClick: function () { return true; }
        },
        {
          label: 'Allow access',
          className: 'btn btn-primary',
          busyLabel: 'Waiting for Chrome…',
          onClick: function (button) {
            return requestSiteAccess(product.url, button).then(function () { return true; });
          }
        }
      ]
    });
  }

  function removeSitePermission(origin) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.permissions.remove({ origins: [origin] }, function (removed) {
          var runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message || 'Permission could not be removed.'));
            return;
          }
          resolve(!!removed);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function openRevokeModal(site) {
    if (!site) return;
    var body = [];
    var copy = node('p');
    copy.appendChild(document.createTextNode('Automatic checks for '));
    copy.appendChild(node('strong', null, String(site.count) + (site.count === 1 ? ' product' : ' products')));
    copy.appendChild(document.createTextNode(' on '));
    copy.appendChild(node('strong', null, site.origin));
    copy.appendChild(document.createTextNode(' will stop. Saved prices and history stay in this browser.'));
    body.push(copy);
    body.push(noteNode('alert',
      'You can allow this store again later from Settings or from a product detail page.', 'warn'));
    openModal({
      title: 'Remove site access?',
      body: body,
      actions: [
        {
          label: 'Cancel',
          className: 'btn btn-secondary',
          onClick: function () { return true; }
        },
        {
          label: 'Remove access',
          className: 'btn btn-danger',
          busyLabel: 'Removing…',
          onClick: async function () {
            var removed = await removeSitePermission(site.origin);
            if (!removed) {
              toast('Chrome did not remove this permission.', 'warning', 5200);
              return false;
            }
            await sendMessage('REBUILD_ALARMS').catch(function () { return null; });
            toast('Site access removed.', 'success');
            await refresh({ scroll: false });
            return true;
          }
        }
      ]
    });
  }

  function openDeleteModal(product) {
    if (!product) return;
    var body = [];
    var copy = node('p');
    copy.appendChild(document.createTextNode('Remove '));
    copy.appendChild(node('strong', null, product.title));
    copy.appendChild(document.createTextNode(' from this browser?'));
    body.push(copy);
    body.push(noteNode('alert', 'Its entire price history will be deleted. This cannot be undone.', 'bad'));
    openModal({
      title: 'Remove product?',
      body: body,
      actions: [
        {
          label: 'Cancel',
          className: 'btn btn-secondary',
          onClick: function () { return true; }
        },
        {
          label: 'Remove product',
          className: 'btn btn-danger',
          busyLabel: 'Removing…',
          onClick: async function () {
            await sendMessage('REMOVE_PRODUCT', { id: product.id });
            toast('Product removed.', 'success');
            if (state.route.name === 'product') location.hash = '#products';
            else await refresh({ scroll: false });
            return true;
          }
        }
      ]
    });
  }

  function openClearAllModal() {
    if (!state.products.length) {
      toast('There are no products to remove.', 'info');
      return;
    }
    var body = [];
    body.push(node('p',
      'This deletes every tracked product and all price history from this browser. Your settings and site permissions are kept.'));
    body.push(noteNode('alert',
      'This cannot be undone. Export a JSON backup first if you might need the data.', 'bad'));
    var wrap = node('div', 'modal-danger-input');
    var input = node('input', 'input');
    input.type = 'text';
    input.placeholder = 'Type DELETE to confirm';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Type DELETE to confirm');
    wrap.appendChild(input);
    body.push(wrap);
    openModal({
      title: 'Remove all products?',
      body: body,
      actions: [
        {
          label: 'Cancel',
          className: 'btn btn-secondary',
          onClick: function () { return true; }
        },
        {
          label: 'Remove all products',
          className: 'btn btn-danger',
          busyLabel: 'Removing…',
          onReady: function (button) {
            button.disabled = true;
            input.addEventListener('input', function () {
              button.disabled = input.value.trim() !== 'DELETE';
            });
          },
          onClick: async function () {
            if (input.value.trim() !== 'DELETE') return false;
            var response = await sendMessage('CLEAR_ALL_PRODUCTS', {});
            state.filters.query = '';
            state.filters.filter = 'all';
            state.filters.sort = 'newest';
            toast('Removed ' + response.removed + (response.removed === 1 ? ' product.' : ' products.'), 'success');
            if (state.route.name === 'product') location.hash = '#products';
            else await refresh({ scroll: false });
            return true;
          }
        }
      ]
    });
  }

  function openAddHelpModal() {
    var body = [];
    body.push(node('p',
      'Open a product page on any shopping website, then click the Smart Price Tracker icon in your Chrome toolbar.'));
    var steps = node('div', 'modal-steps');
    [
      ['1', 'Open a product page', 'Use the actual product detail page, not a search results page.'],
      ['2', 'Click the toolbar icon', 'Review the detected title, price and store before saving.'],
      ['3', 'Confirm and relax', 'Choose a target price if you like. Automatic checks use the schedule in Settings.']
    ].forEach(function (step) {
      var item = node('div', 'modal-step');
      item.appendChild(node('span', null, step[0]));
      var copy = node('div');
      copy.appendChild(node('strong', null, step[1]));
      copy.appendChild(node('p', null, step[2]));
      item.appendChild(copy);
      steps.appendChild(item);
    });
    body.push(steps);
    body.push(noteNode('shield',
      'The extension reads a page only after you click its toolbar icon or explicitly allow automatic checks for that store.'));
    openModal({
      title: 'Add a product',
      body: body,
      actions: [{
        label: 'Got it',
        className: 'btn btn-primary',
        onClick: function () { return true; }
      }]
    });
  }

  /* --------------------------------------------------------------------- */
  /* Event handlers                                                         */
  /* --------------------------------------------------------------------- */

  function isEditing() {
    var active = document.activeElement;
    return !!active && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName);
  }

  function scheduleDataRefresh() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(function () {
      if (el['modal-root'] && !el['modal-root'].hidden) {
        state.pendingRefresh = true;
        return;
      }
      if (isEditing()) {
        state.pendingRefresh = true;
        return;
      }
      refresh({ scroll: false });
    }, 260);
  }

  function flushPendingRefresh() {
    if (!state.pendingRefresh) return;
    if (el['modal-root'] && !el['modal-root'].hidden) return;
    if (isEditing()) return;
    state.pendingRefresh = false;
    refresh({ scroll: false });
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== 'local') return;
    var keys = Object.keys(changes || {});
    if (!keys.length) return;

    if (keys.indexOf(Storage.KEY_SETTINGS) !== -1 && !state.settingsSaving) {
      var next = V.sanitizeSettings(
        changes[Storage.KEY_SETTINGS].newValue || DM.defaultSettings()
      );
      if (JSON.stringify(next) !== JSON.stringify(state.settings)) {
        state.settings = next;
        applyTheme();
        if (state.route.name === 'settings') renderRoute({ scroll: false });
      }
    }

    var dataChanged = keys.some(function (key) {
      return key.indexOf(Storage.PREFIX) === 0;
    });
    if (dataChanged) scheduleDataRefresh();
  }

  async function handleToggle(input) {
    var kind = input.dataset.toggle;
    var id = input.dataset.id;
    var enabled = input.checked;
    var types = {
      tracking: 'SET_TRACKING',
      monitoring: 'SET_MONITORING',
      notifications: 'SET_NOTIFICATIONS'
    };
    var type = types[kind];
    if (!type) return;
    input.disabled = true;
    try {
      var response = await sendMessage(type, { id: id, enabled: enabled });
      var product = response.product || getProduct(id);
      if (kind === 'monitoring' && enabled && response.needsPermission) {
        toast(V.ERROR_MESSAGES.PERMISSION_REQUIRED, 'warning', 5200);
        openPermissionModal(product);
      } else if (kind === 'tracking' && enabled && response.warning) {
        toast(response.warning, 'warning', 5200);
        openPermissionModal(product);
      } else if (response.warning) {
        toast(response.warning, 'warning', 5200);
      } else if (kind === 'tracking') {
        toast(enabled ? 'Tracking resumed.' : 'Tracking paused.', 'success');
      } else if (kind === 'monitoring') {
        toast(enabled ? 'Automatic checks are on.' : 'Automatic checks are off.', 'success');
      } else {
        toast(enabled ? 'Notifications enabled for this product.' : 'Notifications disabled for this product.', 'success');
      }
      await refresh({ scroll: false });
    } catch (error) {
      input.checked = !enabled;
      input.disabled = false;
      toast(normalizeError(error).message, 'error', 5200);
    }
  }

  async function handleFrequency(select) {
    var id = select.dataset.id;
    var frequency = Number(select.value);
    if (!id || V.VALID_FREQUENCIES.indexOf(frequency) === -1) {
      toast(V.ERROR_MESSAGES.INVALID_SETTINGS, 'error');
      return;
    }
    select.disabled = true;
    try {
      var response = await sendMessage('SET_FREQUENCY', { id: id, frequency: frequency });
      if (response.warning) toast(response.warning, 'warning', 5200);
      else toast('Check frequency updated.', 'success');
      await refresh({ scroll: false });
    } catch (error) {
      select.disabled = false;
      toast(normalizeError(error).message, 'error', 5200);
    }
  }

  function handleSettingChange(input) {
    var key = input.dataset.setting;
    if (!key) return;
    var value;
    if (input.type === 'checkbox') {
      value = input.checked;
    } else if (key === 'defaultFrequency' || key === 'maxConcurrentChecks') {
      value = Number(input.value);
    } else {
      value = input.value;
    }
    if (key === 'theme') {
      setTheme(value);
      return;
    }
    if (key === 'defaultFrequency' && V.VALID_FREQUENCIES.indexOf(value) === -1) return;
    if (key === 'maxConcurrentChecks' && (value < 1 || value > V.LIMITS.MAX_CONCURRENT_CHECKS)) return;
    state.settings[key] = value;
    if (key === 'notificationsEnabled') {
      document.querySelectorAll(
        '[data-setting="priceDropNotifications"], [data-setting="targetNotifications"]'
      ).forEach(function (item) { item.disabled = !value; });
    }
    queueSettingsSave();
  }

  async function saveTarget(form) {
    var id = form.dataset.id;
    var product = getProduct(id);
    if (!product) {
      toast(V.ERROR_MESSAGES.PRODUCT_NOT_FOUND, 'error');
      return;
    }
    var input = form.querySelector('input[name="target"]');
    var button = form.querySelector('button[type="submit"]') || form.querySelector('button');
    var raw = input ? input.value.trim() : '';
    var target = raw === '' ? null : V.asTargetPrice(raw);
    if (raw !== '' && target === null) {
      markInvalid(input, true);
      toast(V.ERROR_MESSAGES.INVALID_PRICE, 'error');
      if (input) input.focus();
      return;
    }
    markInvalid(input, false);
    setBusy(button, true, 'Saving…');
    try {
      await sendMessage('SET_TARGET', { id: id, targetPrice: target });
      toast(target === null ? 'Target price cleared.' : 'Target price saved.', 'success');
      await refresh({ scroll: false });
    } catch (error) {
      toast(normalizeError(error).message, 'error', 5200);
      setBusy(button, false);
    }
  }

  function navigateToProducts(filter) {
    state.filters.query = '';
    state.filters.filter = filter || 'all';
    if (state.route.name === 'products') renderRoute({ scroll: false });
    else location.hash = '#products';
  }

  function onClick(event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var actionEl = target.closest('[data-action]');
    if (!actionEl) return;
    var action = actionEl.dataset.action;
    var id = actionEl.dataset.id;
    if (!action) return;
    event.preventDefault();

    switch (action) {
      case 'add-help':
        openAddHelpModal();
        break;
      case 'go-products':
        location.hash = '#products';
        break;
      case 'go-settings':
        location.hash = '#settings';
        break;
      case 'reset-filters':
        state.filters.query = '';
        state.filters.filter = 'all';
        state.filters.sort = 'newest';
        renderRoute({ scroll: false });
        break;
      case 'view-drops':
        navigateToProducts('drops');
        break;
      case 'view-attention':
        navigateToProducts('attention');
        break;
      case 'retry-load':
        refresh();
        break;
      case 'check-product':
        checkProduct(id, actionEl);
        break;
      case 'delete-product':
        openDeleteModal(getProduct(id));
        break;
      case 'open-product':
        if (id) location.hash = '#product=' + encodeURIComponent(id);
        break;
      case 'copy-url':
        copyProductUrl(getProduct(id));
        break;
      case 'clear-target':
        clearTarget(getProduct(id), actionEl);
        break;
      case 'allow-product-site': {
        var product = getProduct(id);
        if (product) requestSiteAccess(product.url, actionEl);
        break;
      }
      case 'allow-site': {
        var url = actionEl.dataset.url || actionEl.dataset.origin;
        if (url) requestSiteAccess(url, actionEl);
        break;
      }
      case 'revoke-site': {
        var origin = actionEl.dataset.origin;
        var site = state.sites.find(function (entry) { return entry.origin === origin; });
        openRevokeModal(site);
        break;
      }
      case 'chart-range': {
        var range = actionEl.dataset.range;
        if (CHART_RANGES.indexOf(range) !== -1) {
          state.chartRange = range;
          renderRoute({ scroll: false });
        }
        break;
      }
      case 'export-json':
        exportJson(actionEl);
        break;
      case 'export-csv':
        exportCsv(actionEl);
        break;
      case 'import-json':
        triggerImport();
        break;
      case 'clear-all':
        openClearAllModal();
        break;
      case 'set-theme':
        setTheme(actionEl.dataset.theme);
        break;
      default:
        break;
    }
  }

  function onChange(event) {
    var target = event.target;
    if (!target || !target.closest) return;
    if (target.id === 'import-file-input') {
      var file = target.files && target.files[0];
      target.value = '';
      handleImportFile(file);
      return;
    }
    var toggle = target.closest('[data-toggle]');
    if (toggle) {
      handleToggle(toggle);
      return;
    }
    var setting = target.closest('[data-setting]');
    if (setting) {
      handleSettingChange(setting);
      return;
    }
    var change = target.closest('[data-change]');
    if (!change) return;
    if (change.dataset.change === 'frequency') {
      handleFrequency(change);
      return;
    }
    if (change.dataset.change === 'filter') {
      state.filters.filter = change.value;
      renderProductsResults();
    } else if (change.dataset.change === 'sort') {
      state.filters.sort = change.value;
      renderProductsResults();
    }
  }

  function onInput(event) {
    if (event.target && event.target.id === 'product-search') {
      state.filters.query = event.target.value;
      renderProductsResults();
    }
  }

  function onSubmit(event) {
    var form = event.target && event.target.closest
      ? event.target.closest('form[data-form="target"]')
      : null;
    if (!form) return;
    event.preventDefault();
    saveTarget(form);
  }

  function onKeyDown(event) {
    if (!el['modal-root'] || el['modal-root'].hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key !== 'Tab') return;
    var focusables = el['modal-root'].querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /* --------------------------------------------------------------------- */
  /* Initialization                                                         */
  /* --------------------------------------------------------------------- */

  async function init() {
    cacheElements();
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('input', onInput);
    document.addEventListener('submit', onSubmit);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusout', function () {
      setTimeout(flushPendingRefresh, 0);
    }, true);
    window.addEventListener('hashchange', function () { renderRoute(); });

    var skipLink = document.querySelector('[data-skip-link]');
    if (skipLink) {
      skipLink.addEventListener('click', function (event) {
        event.preventDefault();
        if (!el['page-content']) return;
        el['page-content'].focus();
        el['page-content'].scrollIntoView({ block: 'start' });
      });
    }

    if (el['theme-toggle']) el['theme-toggle'].addEventListener('click', toggleTheme);
    if (el['quick-export']) {
      el['quick-export'].addEventListener('click', function () { exportJson(el['quick-export']); });
    }
    if (el['quick-import']) el['quick-import'].addEventListener('click', triggerImport);
    if (el['modal-close']) el['modal-close'].addEventListener('click', closeModal);
    if (el['modal-root']) {
      el['modal-root'].addEventListener('click', function (event) {
        if (event.target && event.target.hasAttribute('data-modal-backdrop')) closeModal();
      });
    }
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(onStorageChanged);
    }

    try {
      await loadAll();
      applyTheme();
      updateChrome();
      renderRoute({ scroll: false });
    } catch (error) {
      renderFatal(error);
    }
  }

  init();

})(typeof globalThis !== 'undefined' ? globalThis : self);
