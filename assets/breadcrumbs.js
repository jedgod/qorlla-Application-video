/* Qorlla breadcrumbs: ONE implementation for the whole workspace, driven by the app's own router (the hash routes of qorlla.html: #view, #view/section, #view/section/subsection).
 * It never adds a second router. Pure functions build the trail; render() paints it. Also usable by any page that has a path instead of a hash (forPath).
 *
 *   QorllaCrumbs.forRoute({ view, sub, section })  -> [{ label, href? }, ...]   in-app route
 *   QorllaCrumbs.forPath('/admin/security')        -> [{ label, href? }, ...]   path-style route
 *   QorllaCrumbs.render(navElement, items)
 *
 * Rules: the last item is the current page (no href); only parents link, and only to routes that exist; private identifiers (meeting ids, account ids, mail ids, tokens) are never used as labels or in links.
 */
(function (root) {
  'use strict';
  var HOME = { label: 'Home' }, WORKSPACE = { label: 'Workspace', href: '#home' };

  // In-app views (the keys of VIEWS in qorlla.html) and their labels.
  var VIEW_LABELS = { docs: 'Docs', mail: 'Mail', whiteboard: 'Whiteboards', calendar: 'Calendar', schedule: 'Schedule', history: 'History', phone: 'Phone', notes: 'Notes', search: 'Search', more: 'More', settings: 'Settings' };
  // Sections inside a view. slug (in the URL) -> label. The phone page is the only one with its own sections today.
  var PHONE_SUBS = { 'dial-pad': 'Dial Pad', 'join-meeting': 'Join Meeting', 'recent-calls': 'Recent Calls', contacts: 'Contacts', 'numbers-plans': 'Numbers & Plans', 'call-settings': 'Call Settings', help: 'Help' };
  var CALL_SETTINGS_SECTIONS = { calling: 'Calling & Caller ID', audio: 'Audio & Devices', 'meeting-dial-in': 'Meeting Dial-in', 'privacy-security': 'Privacy & Security', notifications: 'Notifications', 'call-history': 'Call History', 'plans-billing': 'Plans & Billing', 'admin-controls': 'Admin Controls' };
  var SUBS = { phone: PHONE_SUBS };
  // Labels for path-style routes (other pages and apps that share the feature).
  var PATH_LABELS = { phone: 'Phone', 'dial-pad': 'Dial Pad', 'join-meeting': 'Join Meeting', 'recent-calls': 'Recent Calls', contacts: 'Contacts', 'numbers-plans': 'Numbers & Plans', 'call-settings': 'Call Settings', meetings: 'Meetings', documents: 'Documents', docs: 'Documents',
    suite: 'Documents', mail: 'Mail', chat: 'Chat', calendar: 'Calendar', admin: 'Admin', security: 'Security Center', clips: 'Clips', whiteboards: 'Whiteboards', notes: 'Notes', schedule: 'Schedule', history: 'History', settings: 'Settings', app: null };
  // What a private identifier is called instead, by the segment before it ("meetings/<id>" -> "Meeting").
  var ID_NOUN = { meetings: 'Meeting', meeting: 'Meeting', accounts: 'Account', account: 'Account', users: 'Person', user: 'Person', calls: 'Call', mail: 'Message', messages: 'Message', documents: 'Document', docs: 'Document', boards: 'Whiteboard', whiteboards: 'Whiteboard', notes: 'Note', tickets: 'Ticket', numbers: 'Number', orgs: 'Organization' };

  /** True for anything that looks like an identifier rather than a page name: uuids, long digit runs (meeting numbers), hex/base64-ish tokens, prefixed ids (m_..., usr-...) with digits. */
  function looksLikeId(seg) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true;
    if (/^\d{4,}$/.test(seg)) return true;
    if (/^[0-9a-f]{16,}$/i.test(seg)) return true;
    if (seg.length >= 12 && /\d/.test(seg) && /[a-z]/i.test(seg) && /^[A-Za-z0-9_.:~-]+$/.test(seg) && !/^[a-z]+(-[a-z]+)*$/.test(seg)) return true;
    if (/^[a-z]{1,4}[_-]\w*\d\w*$/i.test(seg) && seg.length >= 8) return true;
    return false;
  }
  var prettify = function (seg) { return seg.replace(/[-_]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); };
  var safeDecode = function (s) { try { return decodeURIComponent(s); } catch (e) { return s; } };

  /** In-app route -> trail. Unknown views and unknown sections are not invented: they fall back to the nearest real page. */
  function forRoute(r) {
    var view = r && r.view || 'home', sub = r && r.sub || '', section = r && r.section || '';
    if (view === 'home') return [HOME];
    var label = VIEW_LABELS[view]; if (!label) return [HOME];
    var items = [WORKSPACE], base = '#' + view;
    if (view === 'docs' && sub && looksLikeId(sub)) { items.push({ label: label, href: base }); items.push({ label: 'Document' }); return items; }      // #docs/<id>: the id itself is never shown
    var subs = SUBS[view], subLabel = subs && Object.prototype.hasOwnProperty.call(subs, sub) ? subs[sub] : null;
    if (!subLabel) { items.push({ label: label }); return items; }
    items.push({ label: label, href: base });
    var secLabel = view === 'phone' && sub === 'call-settings' && Object.prototype.hasOwnProperty.call(CALL_SETTINGS_SECTIONS, section) && section !== 'calling' ? CALL_SETTINGS_SECTIONS[section] : null;
    if (secLabel) { items.push({ label: subLabel, href: base + '/' + sub }); items.push({ label: secLabel }); } else items.push({ label: subLabel });
    return items;
  }

  /** Path-style route -> trail (for pages that use paths). Same rules as forRoute, plus identifiers never appear. */
  function forPath(pathname) {
    var path = String(pathname || '/').split(/[?#]/)[0].replace(/\/+$/, '') || '/';
    var segs = path.split('/').filter(Boolean).map(safeDecode);
    if (!segs.length) return [HOME];
    var items = [WORKSPACE], href = '', prev = '';
    segs.forEach(function (seg, i) {
      var last = i === segs.length - 1, key = seg.toLowerCase(); href += '/' + encodeURIComponent(seg);
      var label, isId = false;
      if (Object.prototype.hasOwnProperty.call(PATH_LABELS, key)) label = PATH_LABELS[key];
      else if (looksLikeId(seg)) { isId = true; label = ID_NOUN[prev] || 'Details'; }
      else label = prettify(seg).slice(0, 40);
      prev = key;
      if (label === null) return;                                               // a path segment that is not a page (for example "app")
      var item = { label: label };
      if (!last && !isId) item.href = href.replace(/\/app(?=\/|$)/, '') || '/';  // parents link only to real pages, never to a route that contains an identifier
      items.push(item);
    });
    return items;
  }

  /** Paints the trail into <nav aria-label="Breadcrumb"><ol class="breadcrumb-list">. The last item is the current page: not a link, aria-current="page". */
  function render(nav, items) {
    if (!nav) return;
    var ol = nav.querySelector('ol'); if (!ol) { ol = document.createElement('ol'); ol.className = 'breadcrumb-list'; nav.appendChild(ol); }
    ol.textContent = '';
    items.forEach(function (it, i) {
      var current = i === items.length - 1;
      if (i > 0) { var sep = document.createElement('li'); sep.className = 'breadcrumb-separator'; sep.setAttribute('aria-hidden', 'true'); sep.textContent = '›'; ol.appendChild(sep); }
      var li = document.createElement('li'), el;
      if (!current && it.href) { el = document.createElement('a'); el.setAttribute('href', it.href); }
      else { el = document.createElement('span'); if (current) { el.setAttribute('aria-current', 'page'); el.className = 'current'; } }
      el.textContent = (root.I18n && typeof root.I18n.t === 'function') ? root.I18n.t(it.label) : it.label;
      li.appendChild(el); ol.appendChild(li);
    });
  }

  // ---------------------------------------------------------------- applications with their OWN routers (Documents, Chat, the Admin portal, ...)
  // Each application hands in its own route definitions and its own authorization test; this file holds the logic once and never owns a router.
  //   routes: [{ id, label, parent?, pattern?, href?, query?, whenQuery?, requires? }]
  //     pattern    a path such as '/app/suite' or '/app/ai/reports/:id' (":x" segments match anything and are NEVER shown)
  //     query      { tab: 'billing' }  the route applies only when these query parameters have exactly these values
  //     whenQuery  ['doc']             the route applies only when these parameters are present (their values are never shown)
  //     href       where an ANCESTOR crumb links (default: the pattern, when it has no ":x"); a route with neither is shown as text
  //     requires   a label for the application's authorize() test (for example 'signedIn', 'platformAdmin')
  //   authorize(route) -> boolean   is this destination accessible to the person looking at it? An inaccessible CURRENT page hides the trail; an inaccessible ANCESTOR is shown as text, never as a link.
  // A path that matches no route shows NO trail (nothing is guessed, so no raw segment, id or token can leak into a label).
  var normPath = function (p) { return String(p || '/').split(/[?#]/)[0].replace(/\/+$/, '') || '/'; };
  function patternMatch(pattern, path) {
    var a = normPath(pattern).split('/'), b = normPath(path).split('/'); if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) { if (a[i].charAt(0) === ':') { if (!b[i]) return false; continue; } if (a[i] !== b[i]) return false; }
    return true;
  }
  function queryOf(q) {
    if (!q) return {}; if (typeof q === 'string') { var o = {}; new URLSearchParams(q.charAt(0) === '?' ? q.slice(1) : q).forEach(function (v, k) { if (!(k in o)) o[k] = v; }); return o; }
    if (typeof q.forEach === 'function' && typeof q.get === 'function') { var r = {}; q.forEach(function (v, k) { if (!(k in r)) r[k] = v; }); return r; }
    return q;
  }
  function matchRoute(routes, path, query) {
    var best = null, bestScore = -1, q = queryOf(query);
    (routes || []).forEach(function (r) {
      if (!r || !r.pattern || !patternMatch(r.pattern, path)) return; var score = 1, ok = true;
      Object.keys(r.query || {}).forEach(function (k) { if (String(q[k] === undefined ? '' : q[k]) !== String(r.query[k])) ok = false; else score++; });
      (r.whenQuery || []).forEach(function (k) { if (!q[k]) ok = false; else score++; });
      if (ok && score > bestScore) { best = r; bestScore = score; }
    });
    return best;
  }
  var hrefOf = function (r) { return r.href || (r.pattern && r.pattern.indexOf(':') < 0 ? normPath(r.pattern) : undefined); };
  /** -> { items, visible, route }. `visible` is false when the page matches no route, or the person may not see it. */
  function build(o) {
    var routes = o.routes || [], authorize = typeof o.authorize === 'function' ? o.authorize : function () { return true; }, byId = {};
    routes.forEach(function (r) { if (r && r.id) byId[r.id] = r; });
    var current = matchRoute(routes, o.path, o.query); if (!current) return { items: [], visible: false, route: null };
    if (!authorize(current)) return { items: [], visible: false, route: current };
    var chain = [], r = current, guard = 0; while (r && guard++ < 8) { chain.unshift(r); r = r.parent ? byId[r.parent] : null; }
    var items = chain.map(function (c, i) { var it = { label: c.label }; if (i < chain.length - 1) { var h = hrefOf(c); if (h && authorize(c)) it.href = h; } return it; });
    return { items: items, visible: true, route: current };
  }
  /** Paints a trail for an application with its own router. Hides the container when there is nothing (or nothing permitted) to show. */
  function renderFor(o) {
    var res = build(o), c = o.container; if (!c) return res;
    if (!res.visible) { c.textContent = ''; var ol0 = c.querySelector('ol'); if (ol0) ol0.textContent = ''; c.hidden = true; c.classList && c.classList.add('hidden'); return res; }
    c.hidden = false; c.classList && c.classList.remove('hidden'); if (c.tagName === 'NAV') c.setAttribute('aria-label', 'Breadcrumb');
    render(c, res.items); res.duplicate = (document.querySelectorAll('nav[aria-label="Breadcrumb"]').length > 1); return res;
  }
  /** The stable interface for every application: render({ container, path, query, routes, authorize }). The older render(nav, items) form still works. */
  function renderAny(a, b) { return a && typeof a === 'object' && 'container' in a && b === undefined ? renderFor(a) : render(a, b); }

  var api = { forRoute: forRoute, forPath: forPath, render: render, looksLikeId: looksLikeId, PHONE_SUBS: PHONE_SUBS, CALL_SETTINGS_SECTIONS: CALL_SETTINGS_SECTIONS, VIEW_LABELS: VIEW_LABELS };
  var apps = { build: build, matchRoute: matchRoute, renderFor: renderFor };
  var both = {}; Object.keys(api).forEach(function (k) { both[k] = api[k]; }); Object.keys(apps).forEach(function (k) { both[k] = apps[k]; }); both.render = renderAny;
  root.QorllaCrumbs = api; root.QorllaBreadcrumbs = both;                  // QorllaCrumbs: the original surface (kept); QorllaBreadcrumbs: the same plus the per-application interface
  if (typeof module !== 'undefined' && module.exports) module.exports = Object.assign({}, both, { render: render, renderAny: renderAny });
})(typeof window !== 'undefined' ? window : globalThis);
