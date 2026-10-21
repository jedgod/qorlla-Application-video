/* Shared browser i18n: explicit UI keys, interpolation and Intl formatting. */
(function () {
  'use strict';
  var catalogs = window.QorllaLocales || {};
  var supported = ['en', 'es', 'fr', 'pt-PT'];
  function normalize(value) {
    var tag = String(value || '').toLowerCase();
    if (tag === 'pt' || tag === 'pt-pt') return 'pt-PT';
    var language = tag.split('-')[0];
    return language === 'pt' ? undefined : language;
  }
  var saved;
  try { saved = localStorage.getItem('qorlla.locale'); } catch (_) { /* Storage may be disabled. */ }
  var detected = (navigator.languages || [navigator.language]).map(normalize).find(function (l) { return supported.indexOf(l) !== -1; });
  var locale = supported.indexOf(saved) !== -1 ? saved : detected || 'en';
  function t(key, params) {
    var catalog = catalogs[locale] || {};
    var value = Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : key;
    return String(value).replace(/\{(\w+)\}/g, function (match, name) { return params && params[name] !== undefined ? String(params[name]) : match; });
  }
  function translate(root) {
    var nodes = [];
    if (root.nodeType === 1) nodes.push(root);
    if (root.querySelectorAll) nodes = nodes.concat(Array.from(root.querySelectorAll('[data-i18n], [data-i18n-placeholder], [data-i18n-title], [data-i18n-aria-label]')));
    nodes.forEach(function (el) {
      if (el.hasAttribute('data-i18n')) {
        var value = t(el.getAttribute('data-i18n'));
        if (el.textContent !== value) el.textContent = value;
      }
      ['placeholder', 'title', 'aria-label'].forEach(function (attr) {
        var key = el.getAttribute('data-i18n-' + attr);
        if (key && el.getAttribute(attr) !== t(key)) el.setAttribute(attr, t(key));
      });
    });
  }
  window.I18n = {
    locale: locale,
    t: t,
    number: function (value, options) { return new Intl.NumberFormat(locale, options).format(value); },
    date: function (value, options) { return new Intl.DateTimeFormat(locale, options).format(new Date(value)); },
    setLocale: function (value) {
      if (supported.indexOf(value) === -1) return;
      try { localStorage.setItem('qorlla.locale', value); } catch (_) { /* Continue for this page. */ }
      locale = value;
      this.locale = value;
      document.documentElement.lang = value;
      translate(document);
      document.querySelectorAll('[data-language-select]').forEach(function (select) { select.value = value; });
      window.dispatchEvent(new CustomEvent('languagechange', { detail: { locale: value } }));
    }
  };
  document.documentElement.lang = locale;
  document.addEventListener('DOMContentLoaded', function () {
    var holder = document.createElement('div');
    holder.className = 'language-control';
    holder.innerHTML = '<label><span data-i18n="Language">Language</span><select data-language-select aria-label="Language" data-i18n-aria-label="Language"><option value="en" lang="en">English</option><option value="es" lang="es">Español</option><option value="fr" lang="fr">Français</option><option value="pt-PT" lang="pt-PT">Português (Portugal)</option></select></label>';
    var host = document.querySelector('[data-language-host]') || document.querySelector('header, .card, main') || document.body;
    if (host.tagName === 'HEADER') host.append(holder);
    else host.prepend(holder);
    var select = holder.querySelector('select');
    select.value = locale;
    // Reload deliberately rerenders dynamic UI and dates consistently in the chosen locale.
    select.addEventListener('change', function () {
      var value = select.value;
      var persisted = false;
      try { localStorage.setItem('qorlla.locale', value); persisted = localStorage.getItem('qorlla.locale') === value; } catch (_) {}
      if (persisted) window.location.reload();
      else window.I18n.setLocale(value);
    });
    translate(document);
    new MutationObserver(function (records) {
      records.forEach(function (record) { record.addedNodes.forEach(function (node) { if (node.nodeType === 1) translate(node); }); });
    }).observe(document.body, { childList: true, subtree: true });
  });
})();
