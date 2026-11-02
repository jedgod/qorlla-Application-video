/* Small progressive enhancements; application behavior remains in the page modules. */
(function () {
  'use strict';
  function init() {
    var tabs = document.querySelector('[role="tablist"]');
    if (tabs) tabs.addEventListener('keydown', function (event) {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      var items = Array.from(tabs.querySelectorAll('[role="tab"]'));
      var current = items.indexOf(document.activeElement);
      if (current === -1) return;
      event.preventDefault();
      var next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowLeft' ? -1 : 1) + items.length) % items.length;
      items[next].click(); items[next].focus();
    });
    var emptyNew = document.getElementById('emptyNewChat');
    if (emptyNew) emptyNew.addEventListener('click', function () {
      var trigger = document.getElementById('plusBtn');
      if (trigger) { trigger.click(); trigger.focus(); }
    });
    var drawer = document.getElementById('zoom-chat-sidebar-drawer');
    var previousFocus = null;
    var activePanel = null;
    function syncPanels() {
      if (drawer) {
        var hidden = drawer.classList.contains('translate-x-full');
        drawer.inert = hidden;
        drawer.setAttribute('aria-hidden', String(hidden));
      }
      var modal = document.querySelector('.modal-backdrop:not(.hidden)');
      var panel = modal || (drawer && !drawer.classList.contains('translate-x-full') ? drawer : null);
      if (panel === activePanel) return;
      if (panel) {
        if (!activePanel) previousFocus = document.activeElement;
        activePanel = panel;
        var first = panel.querySelector('input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex="0"]');
        if (first) first.focus();
      } else {
        activePanel = null;
        if (previousFocus && previousFocus.isConnected) previousFocus.focus();
        previousFocus = null;
      }
    }
    if (drawer || document.querySelector('.modal-backdrop')) {
      syncPanels();
      var observer = new MutationObserver(syncPanels);
      [drawer].concat(Array.from(document.querySelectorAll('.modal-backdrop'))).filter(Boolean).forEach(function (panel) {
        observer.observe(panel, { attributes:true, attributeFilter:['class'] });
      });
      document.addEventListener('keydown', function (event) {
        if (event.key !== 'Tab' || !activePanel) return;
        var items = Array.from(activePanel.querySelectorAll('button, input, textarea, select, a[href], [tabindex="0"]')).filter(function (el) { return !el.disabled && el.getClientRects().length; });
        if (!items.length) return;
        var first = items[0], last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || !activePanel.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !activePanel.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
