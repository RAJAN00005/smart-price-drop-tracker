/** Adapter registry. Each site has an independent adapter; generic is the fallback. */
(function (root) {
  'use strict';
  root.SPT = root.SPT || {};
  root.SPT.Extractors = root.SPT.Extractors || {};

  function getAdapter(storeId) {
    var key = storeId || 'generic';
    var adapter = root.SPT.Extractors[key];
    return adapter || root.SPT.Extractors.generic || null;
  }

  root.SPT.ExtractorRegistry = {
    getAdapter: getAdapter,
    ids: function () {
      return Object.keys(root.SPT.Extractors);
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
