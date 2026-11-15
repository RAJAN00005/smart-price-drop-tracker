/**
 * Offscreen page fetch + parse worker.
 *
 * Scheduled checks use this instead of creating a browser tab. The page is
 * fetched with the user's granted host permission, parsed with DOMParser, and
 * passed to the same extraction engine used by the popup.
 */
(function () {
  'use strict';

  var FETCH_TIMEOUT_MS = 25000;
  var MAX_HTML_BYTES = 12 * 1024 * 1024;

  function failure(code, message) {
    return { ok: false, error: { code: code || 'NETWORK', message: message || 'The page could not be read.' } };
  }

  async function fetchHtml(url) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
    try {
      var response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        redirect: 'follow',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml'
        }
      });
      if (!response.ok) {
        return { ok: false, error: { code: 'NETWORK', message: 'The store returned HTTP ' + response.status + '.' } };
      }
      var html = await response.text();
      if (!html) return failure('PRICE_NOT_FOUND', 'The store returned an empty page.');
      if (html.length > MAX_HTML_BYTES) return failure('PRICE_NOT_FOUND', 'The store page was too large to read safely.');
      return { ok: true, html: html, finalUrl: response.url || url };
    } catch (error) {
      if (error && error.name === 'AbortError') return failure('NETWORK', 'The store page took too long to respond.');
      return failure('NETWORK', error && error.message ? String(error.message).slice(0, 300) : 'The store page could not be fetched.');
    } finally {
      clearTimeout(timer);
    }
  }

  function parseAndExtract(html, url) {
    try {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var engine = globalThis.SPT && globalThis.SPT.ExtractionEngine;
      if (!engine) return failure('EXTRACTION_ERROR', 'The extraction engine could not be loaded.');
      return { ok: true, data: engine.extract(doc, url, { parsed: true }) };
    } catch (error) {
      return failure('EXTRACTION_ERROR', error && error.message ? String(error.message).slice(0, 300) : 'The page could not be parsed.');
    }
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== 'OFFSCREEN_EXTRACT') return false;
    if (!sender || sender.id !== chrome.runtime.id) return false;
    (async function () {
      var fetched = await fetchHtml(message.url);
      if (!fetched.ok) {
        sendResponse(fetched);
        return;
      }
      sendResponse(parseAndExtract(fetched.html, fetched.finalUrl));
    })();
    return true;
  });
})();
