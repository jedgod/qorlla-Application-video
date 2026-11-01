/* Which way into Qorlla suits this device, for someone who followed a meeting link: the Qorlla app where one exists (Android; desktop on Windows, macOS, Linux),
   otherwise an account in the browser. Nothing here joins or downloads anything: it only decides which options to show and which one to recommend. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.QorllaAppChoice = api;
})(this, function () {
  'use strict';
  /** 'in-app' (already inside a Qorlla app), 'android', 'ios', 'windows', 'macos', 'linux' or 'other'. */
  function detect(ua, platform, maxTouchPoints) {
    ua = String(ua || ''); platform = String(platform || ''); var both = ua + ' ' + platform;
    if (/Electron\/|QorllaMobile\//i.test(ua)) return 'in-app';
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua) || (/^Mac/i.test(platform) && maxTouchPoints > 1)) return 'ios';   // iPadOS reports a Mac with a touch screen
    if (/CrOS/i.test(ua)) return 'other';
    if (/Windows|Win32|Win64/i.test(both)) return 'windows';
    if (/Macintosh|MacIntel/i.test(both)) return 'macos';
    if (/Linux|X11/i.test(both)) return 'linux';
    return 'other';
  }
  var APP = { android: 'Android', windows: 'desktop', macos: 'desktop', linux: 'desktop' };
  /** links: { android, windows, macos, linux } https URLs the operator published (any may be missing). meetingDigits: the 11 digits of this meeting. */
  function plan(kind, links, meetingDigits) {
    links = links || {};
    if (kind === 'in-app') return { kind: kind, show: false, recommended: null, app: null, download: null, account: true };
    var hasApp = Object.prototype.hasOwnProperty.call(APP, kind), id = /^[0-9]{11}$/.test(meetingDigits || '') ? meetingDigits : null;
    var download = hasApp && /^https:\/\//.test(links[kind] || '') ? links[kind] : null;
    return {
      kind: kind, show: true, account: true,
      app: hasApp && id ? { href: 'qorlla://join?meeting=' + id, flavour: APP[kind] } : null,
      download: download ? { href: download, flavour: APP[kind] } : null,
      recommended: hasApp && id ? 'app' : 'account'
    };
  }
  return { detect: detect, plan: plan };
});
