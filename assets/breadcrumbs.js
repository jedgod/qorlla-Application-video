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
  var VIEW_LABELS = { mail: 'Mail', whiteboard: 'Whiteboards', calendar: 'Calendar', schedule: 'Schedule', history: 'History', phone: 'Phone', notes: 'Notes', search: 'Search', more: 'More', settings: 'Settings' };
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

  var api = { forRoute: forRoute, forPath: forPath, render: render, looksLikeId: looksLikeId, PHONE_SUBS: PHONE_SUBS, CALL_SETTINGS_SECTIONS: CALL_SETTINGS_SECTIONS, VIEW_LABELS: VIEW_LABELS };
  root.QorllaCrumbs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
