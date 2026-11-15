/**
 * Supported retailer catalog. Adding a retailer involves adding an entry here
 * and a matching extractor adapter in extractors/.
 */
(function (root) {
  'use strict';

  var STORES = [
    {
      id: 'amazon',
      name: 'Amazon India',
      hostSuffixes: ['amazon.in'],
      currency: 'INR',
      accent: '#FF9900',
      initials: 'A'
    },
    {
      id: 'flipkart',
      name: 'Flipkart',
      hostSuffixes: ['flipkart.com'],
      currency: 'INR',
      accent: '#2874F0',
      initials: 'F'
    },
    {
      id: 'myntra',
      name: 'Myntra',
      hostSuffixes: ['myntra.com'],
      currency: 'INR',
      accent: '#FF3F6C',
      initials: 'M'
    },
    {
      id: 'ajio',
      name: 'AJIO',
      hostSuffixes: ['ajio.com'],
      currency: 'INR',
      accent: '#B08D57',
      initials: 'AJ'
    },
    {
      id: 'croma',
      name: 'Croma',
      hostSuffixes: ['croma.com'],
      currency: 'INR',
      accent: '#00A6A6',
      initials: 'C'
    },
    {
      id: 'reliance',
      name: 'Reliance Digital',
      hostSuffixes: ['reliancedigital.in'],
      currency: 'INR',
      accent: '#E4252B',
      initials: 'RD'
    },
    {
      id: 'tatacliq',
      name: 'Tata CLiQ',
      hostSuffixes: ['tatacliq.com'],
      currency: 'INR',
      accent: '#DA1C5C',
      initials: 'TC'
    },
    {
      id: 'meesho',
      name: 'Meesho',
      hostSuffixes: ['meesho.com'],
      currency: 'INR',
      accent: '#9F2089',
      initials: 'ME'
    }
  ];

  var GENERIC = {
    id: 'generic',
    name: 'Online store',
    hostSuffixes: [],
    currency: 'INR',
    accent: '#6D5EFC',
    initials: 'ST'
  };

  function getUrlUtils() {
    return root.SPT && root.SPT.UrlUtils ? root.SPT.UrlUtils : null;
  }

  function hostnameOf(url) {
    var utils = getUrlUtils();
    if (utils) {
      var parsed = utils.parseHttpUrl(url);
      return parsed ? parsed.hostname.toLowerCase() : '';
    }
    try {
      var u = new URL(url);
      return u.hostname.toLowerCase();
    } catch (_) {
      return '';
    }
  }

  function matchesHost(hostname, suffix) {
    return hostname === suffix || hostname.endsWith('.' + suffix);
  }

  function detect(url) {
    var hostname = hostnameOf(url);
    if (!hostname) return null;
    var cleanHost = hostname.replace(/^www\./, '');
    for (var i = 0; i < STORES.length; i++) {
      var store = STORES[i];
      for (var j = 0; j < store.hostSuffixes.length; j++) {
        if (matchesHost(cleanHost, store.hostSuffixes[j])) {
          return {
            id: store.id,
            name: store.name,
            hostname: cleanHost,
            currency: store.currency,
            accent: store.accent,
            initials: store.initials,
            known: true,
            supported: true
          };
        }
      }
    }
    return {
      id: GENERIC.id,
      name: cleanHost,
      hostname: cleanHost,
      currency: 'INR',
      accent: GENERIC.accent,
      initials: (cleanHost.charAt(0) || 'S').toUpperCase(),
      known: false,
      supported: true
    };
  }

  function getById(id) {
    for (var i = 0; i < STORES.length; i++) {
      if (STORES[i].id === id) {
        return {
          id: STORES[i].id,
          name: STORES[i].name,
          currency: STORES[i].currency,
          accent: STORES[i].accent,
          initials: STORES[i].initials,
          known: true,
          supported: true
        };
      }
    }
    return Object.assign({}, GENERIC, { supported: true });
  }

  function isKnownStore(url) {
    var detected = detect(url);
    return !!detected && detected.known;
  }

  function permissionOriginsFor(url) {
    var utils = getUrlUtils();
    if (!utils) return [];
    var pattern = utils.originPattern(url);
    return pattern ? [pattern] : [];
  }

  function all() {
    return STORES.map(function (store) {
      return {
        id: store.id,
        name: store.name,
        currency: store.currency,
        accent: store.accent,
        initials: store.initials
      };
    });
  }

  root.SPT = root.SPT || {};
  root.SPT.SiteCatalog = {
    detect: detect,
    getById: getById,
    isKnownStore: isKnownStore,
    permissionOriginsFor: permissionOriginsFor,
    all: all,
    GENERIC_ID: GENERIC.id
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
