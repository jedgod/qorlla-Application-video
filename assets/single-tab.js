/* One tab per signed-in account in a browser (workspace and chat share one lock per account). The first tab holds a Web Lock named for the account; a second tab cannot
   get it and is blocked with a notice. "Use Qorlla here" asks the holder (BroadcastChannel) to let go, which pauses that tab. A blocked or paused tab also waits in line for
   the lock, so when the holder closes or crashes (the browser frees its lock) the waiting tab takes over by itself: there is no stale lock to clean up.
   Different accounts, or a different browser, are not affected. This is a convenience for the person, NOT a security boundary: sessions, revocation and authorization stay on
   the server. Where the browser has no Web Locks (an insecure http origin on a LAN address, an old browser) nothing is enforced and nothing says it is:
   status() returns 'unsupported' and <html data-single-tab> says so (other values: active = starting, holder, blocked, paused). Meeting rooms are deliberately not covered: joining a meeting from a second tab is normal. */
(function () {
  'use strict';
  var current = null;                                                  // { userId, stop }
  function t(k) { return window.I18n && window.I18n.t ? window.I18n.t(k) : k; }
  function mark(v) { try { document.documentElement.setAttribute('data-single-tab', v); } catch (e) { /* no document */ } }
  var supported = function () { return !!(window.isSecureContext !== false && navigator.locks && typeof navigator.locks.request === 'function'); };

  function start(userId, opts) {
    if (!userId) return;
    if (current && current.userId === userId) return;                  // same account: nothing to do
    if (current) { current.stop(); current = null; }                   // another account signed in on this page: let go of the old one first
    if (!supported()) { mark('unsupported'); return; }
    mark('active');
    var name = 'qorlla-tab:' + userId, root = opts && opts.root, release = null, overlay = null, stopped = false, waiting = false;
    var bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null;
    if (bc) bc.onmessage = function (e) { if (e.data === 'takeover' && release) { var r = release; release = null; r(); } };

    function inertApp(on) { var el = root && document.querySelector(root); if (el) { if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert'); } }
    function hide() { if (overlay) { overlay.remove(); overlay = null; } inertApp(false); }
    function show(title, text, withClose) {
      hide(); inertApp(true);
      overlay = document.createElement('div'); overlay.id = 'singleTabNotice'; overlay.setAttribute('role', 'alertdialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', 'stTitle'); overlay.setAttribute('aria-describedby', 'stText');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(19,26,42,.72);font-family:inherit';
      var box = document.createElement('div'); box.style.cssText = 'max-width:420px;width:100%;background:#fff;color:#131a2a;border-radius:18px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.35)';
      var h = document.createElement('h2'); h.id = 'stTitle'; h.textContent = title; h.style.cssText = 'margin:0 0 8px;font-size:20px';
      var p = document.createElement('p'); p.id = 'stText'; p.textContent = text; p.style.cssText = 'margin:0 0 18px;font-size:14px;line-height:1.5;color:#667189';
      var row = document.createElement('div'); row.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end';
      function btn(label, primary, fn) { var b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.style.cssText = 'min-height:48px;padding:0 18px;border-radius:12px;font:inherit;font-weight:700;cursor:pointer;border:1px solid ' + (primary ? '#2563ff' : '#e4e9f2') + ';background:' + (primary ? '#2563ff' : '#fff') + ';color:' + (primary ? '#fff' : '#131a2a'); b.onclick = fn; return b; }
      var use = btn(t('Use Qorlla here'), true, function () { use.disabled = true; use.textContent = t('Waiting for the other tab…'); if (bc) bc.postMessage('takeover'); queue(); });
      row.appendChild(use); if (withClose) row.appendChild(btn(t('Close this tab'), false, function () { window.close(); }));
      box.appendChild(h); box.appendChild(p); box.appendChild(row); overlay.appendChild(box); document.body.appendChild(overlay); use.focus();
    }
    // Holds the lock until a takeover message (or stop()) lets go; then pauses this tab and goes back in line.
    function held() { hide(); mark('holder'); return new Promise(function (r) { release = r; }); }
    function yielded() { if (stopped) return; mark('paused'); show(t('Qorlla is now open in another tab'), t('This tab is paused so your account is only open in one tab of this browser.')); queue(); }
    // One place in line per tab. It is granted when the holder lets go, closes or crashes.
    function queue() {
      if (waiting || stopped) return; waiting = true;
      navigator.locks.request(name, function () { waiting = false; if (stopped) return null; return held().then(yielded); });
    }
    function attempt(n) {
      if (stopped) return;
      navigator.locks.request(name, { ifAvailable: true }, function (lock) {
        if (!lock) return false;
        return held().then(function () { yielded(); return true; });
      }).then(function (got) {
        if (got !== false || stopped) return;
        if (n < 6) setTimeout(function () { attempt(n + 1); }, 250);     // a page that just navigated in this tab may still be letting go
        else { mark('blocked'); show(t('Qorlla is already open in another tab'), t('Your account is open in another tab of this browser. Use it there, or switch to this tab.'), true); queue(); }
      });
    }
    current = { userId: userId, stop: function () { stopped = true; hide(); if (release) { var r = release; release = null; r(); } if (bc) bc.close(); } };
    attempt(0);
  }
  window.QorllaSingleTab = { start: start, status: function () { return current ? 'active' : (supported() ? 'idle' : 'unsupported'); } };
})();
