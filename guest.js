(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var path = location.pathname.replace(/\/+$/, '') || '/guest/welcome';
  var pre = /^\/guest\/meeting\/([^/]+)\/prejoin$/.exec(path);
  var views = { '/guest/welcome': 'welcome', '/guest': 'welcome', '/guest/join-meeting': 'join', '/guest/explore': 'explore', '/guest/help': 'help' };
  var view = pre ? 'prejoin' : (views[path] || 'welcome');
  $('v-' + view).classList.remove('hidden');
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
    $('joinForm').addEventListener('submit', function (e) {
      e.preventDefault(); var id = parseMeeting($('mid').value);
      if (!id) { $('joinMsg').textContent = 'Enter a valid 11-digit meeting ID or an invitation link.'; return; }
      location.href = '/guest/meeting/' + encodeURIComponent(fmt(id)) + '/prejoin';
    });
  }

  if (view === 'prejoin') {
    var id = fmt(digits(decodeURIComponent(pre[1]))); var stream = null, raf = 0;
    try { $('pjName').value = localStorage.getItem('zw_name') || ''; } catch (e) { /* storage unavailable */ }
    $('pjSignIn').href = '/auth/login?next=' + encodeURIComponent('/guest/meeting/' + id + '/prejoin');
    fetch('/api/meetings/validate/' + encodeURIComponent(id)).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); }).then(function (r) {
      if (!r.ok || !r.d.isValid) { $('pjTopic').textContent = 'This meeting ID is not valid or the meeting has ended.'; return; }
      $('pjTopic').textContent = 'You are joining: ' + (r.d.topic || 'Meeting') + ' (' + id + ')'; $('pjGo').disabled = false;
    }).catch(function () { $('pjTopic').textContent = 'Cannot reach the server. Check your connection and reload.'; });
    $('pjTest').addEventListener('click', function () {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('pjMsg').textContent = 'This browser cannot access the camera or microphone.'; $('pjMsg').className = 'msg err'; return; }
      navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(function (s) {
        stream = s; $('pjVideo').srcObject = s; $('pjVideo').classList.remove('hidden'); $('pjMeterWrap').classList.remove('hidden');
        try {
          var ctx = new (window.AudioContext || window.webkitAudioContext)(); var an = ctx.createAnalyser(); ctx.createMediaStreamSource(s).connect(an); var buf = new Uint8Array(an.frequencyBinCount);
          (function tick() { an.getByteFrequencyData(buf); var v = 0; for (var i = 0; i < buf.length; i++) v = Math.max(v, buf[i]); $('pjMeter').style.width = Math.min(100, v / 2.2) + '%'; raf = requestAnimationFrame(tick); })();
        } catch (e) { /* no audio meter */ }
        $('pjMsg').textContent = 'Camera and microphone are working. Speak to see the level.'; $('pjMsg').className = 'msg ok';
      }).catch(function () { $('pjMsg').textContent = 'Permission was denied or no device was found. You can still join without them.'; $('pjMsg').className = 'msg err'; });
    });
    $('pjForm').addEventListener('submit', function (e) {
      e.preventDefault(); var name = $('pjName').value.trim();
      if (!name) { $('pjMsg').textContent = 'Enter a display name.'; $('pjMsg').className = 'msg err'; $('pjName').focus(); return; }
      try { localStorage.setItem('zw_name', name); } catch (er) { /* storage unavailable */ }
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); cancelAnimationFrame(raf);
      location.href = '/index.html?meeting=' + encodeURIComponent(id);
    });
  }
})();
