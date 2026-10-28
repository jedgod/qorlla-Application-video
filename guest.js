(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var T = function (s) { return window.I18n ? window.I18n.t(s) : s; };
  // Static text is translated node by node: each text node's trimmed text is the catalog key (same catalogs as the rest of the app).
  (function translateStatic() {
    if (!window.I18n) return;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: function (n) { return n.parentNode.closest && n.parentNode.closest('script,style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } });
    var node;
    while ((node = walker.nextNode())) { var key = node.nodeValue.trim(); if (key) { var out = T(key); if (out !== key) node.nodeValue = node.nodeValue.replace(key, out); } }
    [].forEach.call(document.querySelectorAll('[aria-label]'), function (el) { el.setAttribute('aria-label', T(el.getAttribute('aria-label'))); });
  })();
  var path = location.pathname.replace(/\/+$/, '') || '/guest/welcome';
  var pre = /^\/guest\/meeting\/([^/]+)\/prejoin$/.exec(path);
  var views = { '/guest/welcome': 'welcome', '/guest': 'welcome', '/guest/join-meeting': 'join', '/guest/explore': 'explore', '/guest/help': 'help' };
  var view = pre ? 'prejoin' : (views[path] || 'welcome');
  $('v-' + view).classList.remove('hidden');
  // current-page state in the rail (Home / More / Settings); the other rail items are feature-preview links on the Explore page
  var navFor = { welcome: 'navHome', explore: 'navMore', help: 'navHelp' }[view];
  if (navFor) $(navFor).setAttribute('aria-current', 'page');
  var navEl = document.querySelector('.sidebar'); if (navEl) navEl.setAttribute('aria-label', T('Guest navigation'));
  var digits = function (s) { return String(s || '').replace(/\D/g, ''); };
  var fmt = function (d) { return d.length === 11 ? d.slice(0, 3) + ' ' + d.slice(3, 7) + ' ' + d.slice(7) : d; };
  // accepts "858 9833 3712", "85898333712" or an invitation link containing the ID (?meeting=, ?id= or a /guest/meeting/<id>/prejoin path)
  function parseMeeting(input) {
    var s = String(input || '').trim(); if (!s) return null;
    try {
      var u = new URL(s, location.origin); var q = u.searchParams.get('meeting') || u.searchParams.get('id');
      if (q && digits(q).length === 11) return digits(q);
      var m = /\/meeting\/([^/]+)\/prejoin/.exec(decodeURIComponent(u.pathname)); if (m && digits(m[1]).length === 11) return digits(m[1]);
    } catch (e) { /* not a URL: fall through to plain digits */ }
    return digits(s).length === 11 ? digits(s) : null;
  }

  if (view === 'join') {
    // ?mode=link | ?mode=id from the Welcome tile shortcuts only changes the prompt; validation is identical and server-side
    var mode = new URLSearchParams(location.search).get('mode');
    if (mode === 'link') { $('midLabel').textContent = T('Invitation link'); $('mid').placeholder = 'https://'; $('mid').type = 'url'; }
    else if (mode === 'id') { $('midLabel').textContent = T('Meeting ID'); $('mid').inputMode = 'numeric'; }
    $('mid').focus();
    $('joinForm').addEventListener('submit', function (e) {
      e.preventDefault(); var id = parseMeeting($('mid').value);
      if (!id) { $('joinMsg').textContent = T('Enter a valid 11-digit meeting ID or an invitation link.'); return; }
      location.href = '/guest/meeting/' + encodeURIComponent(fmt(id)) + '/prejoin';
    });
  }

  if (view === 'prejoin') {
    var id = fmt(digits(decodeURIComponent(pre[1]))); var stream = null, raf = 0;
    try { $('pjName').value = localStorage.getItem('zw_name') || ''; } catch (e) { /* storage unavailable */ }
    $('pjSignIn').href = '/auth/login?next=' + encodeURIComponent('/guest/meeting/' + id + '/prejoin');
    fetch('/api/guest/meetings/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meetingId: id }) }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); }).then(function (r) {
      if (!r.ok || !r.d.eligible) { $('pjTopic').textContent = T('This meeting ID is not valid or the meeting has ended.'); return; }
      $('pjTopic').textContent = T('You are joining: ') + ((r.d.meeting && r.d.meeting.topic) || 'Meeting') + ' (' + id + ')'; $('pjGo').disabled = false;
      if (r.d.passcodeRequired) $('pjPassWrap').classList.remove('hidden');
    }).catch(function () { $('pjTopic').textContent = T('Cannot reach the server. Check your connection and reload.'); });
    $('pjTest').addEventListener('click', function () {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('pjMsg').textContent = T('This browser cannot access the camera or microphone.'); $('pjMsg').className = 'msg err'; return; }
      navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(function (s) {
        stream = s; $('pjVideo').srcObject = s; $('pjVideo').classList.remove('hidden'); $('pjMeterWrap').classList.remove('hidden');
        try {
          var ctx = new (window.AudioContext || window.webkitAudioContext)(); var an = ctx.createAnalyser(); ctx.createMediaStreamSource(s).connect(an); var buf = new Uint8Array(an.frequencyBinCount);
          (function tick() { an.getByteFrequencyData(buf); var v = 0; for (var i = 0; i < buf.length; i++) v = Math.max(v, buf[i]); $('pjMeter').style.width = Math.min(100, v / 2.2) + '%'; raf = requestAnimationFrame(tick); })();
        } catch (e) { /* no audio meter */ }
        $('pjMsg').textContent = T('Camera and microphone are working. Speak to see the level.'); $('pjMsg').className = 'msg ok';
      }).catch(function () { $('pjMsg').textContent = T('Permission was denied or no device was found. You can still join without them.'); $('pjMsg').className = 'msg err'; });
    });
    $('pjForm').addEventListener('submit', function (e) {
      e.preventDefault(); var name = $('pjName').value.trim();
      if (!name) { $('pjMsg').textContent = T('Enter a display name.'); $('pjMsg').className = 'msg err'; $('pjName').focus(); return; }
      try { localStorage.setItem('zw_name', name); } catch (er) { /* storage unavailable */ }
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); cancelAnimationFrame(raf);
      // The server decides whether this person may join: it issues a short-lived session bound to this meeting (HttpOnly cookie).
      $('pjGo').disabled = true;
      fetch('/api/guest/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meetingId: id, displayName: name, passcode: $('pjPass').value || undefined }) })
        .then(function (r) { if (!r.ok) { var e = new Error('refused'); e.status = r.status; throw e; } return r.json(); })
        .then(function (d) { location.href = (d && d.meet && d.meet.url) || '/index.html?meeting=' + encodeURIComponent(id); })   // straight into the current Meet video page when Meet is available
        .catch(function (e) { $('pjGo').disabled = false; $('pjMsg').textContent = (e && (e.status === 403 || e.status === 429)) ? T(e.status === 429 ? 'Too many wrong passcodes. Try again in a few minutes.' : 'Incorrect passcode.') : T('This meeting ID is not valid or the meeting has ended.'); $('pjMsg').className = 'msg err'; });
    });
  }
})();
