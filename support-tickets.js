'use strict';
// Qorlla Phone support tickets: a real workflow instead of tickets that stay "open" forever.
//   open -> triaged -> assigned -> in_progress -> waiting_customer -> resolved -> closed
// Customers see only their own tickets and only public messages. Support staff (SUPPORT_STAFF, a JSON list set by the server owner) see only the categories they are scoped to.
// Internal notes never reach a customer. Everything free-text is run through secret redaction before it is stored. Status changes are kept as an audit history.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { CATEGORIES } = require('./phone-help');

const STATES = ['open', 'triaged', 'assigned', 'in_progress', 'waiting_customer', 'resolved', 'closed'];
const NEXT = { open: ['triaged'], triaged: ['assigned'], assigned: ['in_progress', 'triaged'], in_progress: ['waiting_customer', 'resolved', 'assigned'], waiting_customer: ['in_progress', 'resolved'], resolved: ['closed', 'in_progress'], closed: [] };
const PRIORITIES = ['low', 'normal', 'high', 'urgent'], PRANK = { urgent: 0, high: 1, normal: 2, low: 3 };
const MAX_TEXT = 2000, MAX_SUBJECT = 120, MAX_MESSAGES = 40, MAX_TICKETS_PER_USER = 50, MAX_BODY_BYTES = 20000;
const UUID = /^[0-9a-f-]{36}$/i;

// Redaction: PINs, passcodes, passwords, tokens, keys and long digit or character runs are replaced before anything is stored or shown to staff. It cannot be perfect:
// it is a safety net, and the form also tells people never to include secrets. Meeting IDs (11 digits, or spaced) and E.164 phone numbers are deliberately kept: support needs them.
function redact(input) {
  let text = String(input == null ? '' : input), count = 0;
  const sub = (re, fn) => { text = text.replace(re, (...a) => { count++; return fn ? fn(...a) : '[removed]'; }); };
  sub(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g);
  sub(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g);
  sub(/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g);
  sub(/\b(pin|passcode|pass code|password|passwd|pwd|secret|token|api[ _-]?key|otp|security code|verification code|host key)\b(\s*(?:is|are|was|=|:|-)?\s*)(["']?)([^\s"',;]{3,})/gi, (m, key, sep, q) => key + sep + q + '[removed]');
  sub(/(?<![\d\-:/.])(?:\d{6,10}|\d{12,19})(?![\d\-:/.])/g);
  sub(/\b[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9])/g);
  return { text, count };
}

function createSupport({ dataDir, auth, mailer, notify, env = process.env }) {
  const dir = path.join(dataDir, 'workplace'), file = path.join(dir, 'phonesupport.json');
  const load = () => store.readJson(file, null) || { tickets: [] };
  const save = (db) => { fs.mkdirSync(dir, { recursive: true }); store.writeJson(file, db); };
  const now = () => new Date().toISOString();
  const httpErr = (status, message) => Object.assign(new Error(message), { status });
  const ping = (ids, payload) => { if (typeof notify === 'function') try { notify([...new Set(ids.filter(Boolean))], 'support_changed', payload || {}); } catch (e) { /* never break a request over a push */ } };

  // ---- staff configuration (server owner's list; never from the browser)
  function staffList() {
    let raw; try { raw = JSON.parse(env.SUPPORT_STAFF || '[]'); } catch (e) { raw = []; }
    return (Array.isArray(raw) ? raw : []).filter((x) => x && typeof x.user === 'string').map((x) => ({ user: x.user.toLowerCase(), role: x.role === 'lead' ? 'lead' : 'agent', categories: new Set(Array.isArray(x.categories) && x.categories.length ? x.categories : ['*']) }));
  }
  const staffOf = (u) => staffList().find((s) => s.user === String((u && u.username) || '').toLowerCase()) || null;
  const inScope = (s, t) => s.categories.has('*') || s.categories.has(t.category);
  const staffAccounts = () => { const by = new Map(auth.listUsers().map((u) => [u.username.toLowerCase(), u])); return staffList().map((s) => ({ ...s, account: by.get(s.user) })).filter((s) => s.account); };
  const nameOf = (id) => { const u = auth.listUsers().find((x) => x.id === id); return u ? u.displayName : 'Unknown'; };

  // ---- views
  const pub = (t) => ({ id: t.id, ref: t.ref, subject: t.subject, category: t.category, status: t.status, priority: t.priority, createdAt: t.createdAt, updatedAt: t.updatedAt, assigned: !!t.assigneeId, reference: t.reference || '', notified: !!t.notified });
  const customerView = (t) => ({ ...pub(t), messages: t.messages.filter((m) => !m.internal).map((m) => ({ id: m.id, at: m.at, role: m.role, who: m.role === 'staff' ? 'Support' : 'You', text: m.text })), history: t.history.map((h) => ({ at: h.at, to: h.to, role: h.role })), next: { canReply: t.status !== 'closed', canClose: t.status !== 'closed' } });
  const staffSummary = (t) => ({ ...pub(t), ownerName: nameOf(t.ownerId), assigneeId: t.assigneeId || null, assigneeName: t.assigneeId ? nameOf(t.assigneeId) : null });
  const staffView = (t, staff, actor) => ({ ...staffSummary(t), messages: t.messages.map((m) => ({ id: m.id, at: m.at, role: m.role, internal: !!m.internal, who: m.role === 'customer' ? nameOf(t.ownerId) : nameOf(m.by), text: m.text })),
    history: t.history.map((h) => ({ at: h.at, from: h.from, to: h.to, role: h.role, by: nameOf(h.by), note: h.note || '' })),
    allowed: NEXT[t.status].filter((to) => to === 'triaged' || to === 'assigned' ? true : (staff.role === 'lead' || t.assigneeId === actor.id)), canAssignOthers: staff.role === 'lead' });

  const addMessage = (t, m) => { if (t.messages.length >= MAX_MESSAGES) throw httpErr(409, 'This ticket has too many messages. Open a new ticket.'); t.messages.push({ id: crypto.randomUUID(), at: now(), ...m }); t.updatedAt = now(); };
  const addHistory = (t, h) => { t.history.push({ at: now(), ...h }); t.updatedAt = now(); };
  const clean = (v, max, field) => { const r = redact(String(v == null ? '' : v).replace(/\r/g, '').slice(0, max + 500)); return { text: r.text.slice(0, max).trim(), removed: r.count, field }; };
  async function mailOwner(t, status) {
    if (!mailer || !mailer.enabled) return; const u = auth.getUserById && auth.getUserById(t.ownerId); if (!u || !u.emailVerified || !u.email) return;
    try { await mailer.send({ to: u.email, subject: '[Qorlla Phone ' + t.ref + '] Update on your ticket', text: 'There is an update on your support ticket ' + t.ref + ' (now: ' + status.replace(/_/g, ' ') + ').\nOpen Qorlla Phone, Help, Support tickets to read it.\n\nFor your privacy this email does not include the message.' }); } catch (e) { /* mail is best effort */ }
  }

  function importLegacy(user) {     // tickets created before the workflow existed lived in one file per account
    const lf = path.join(dir, 'phone-tickets.' + user.id + '.json'); let old; try { old = store.readJson(lf, null); } catch (e) { return; } if (!Array.isArray(old) || !old.length) return;
    const db = load();
    for (const o of old) { if (!o || !o.id || db.tickets.some((t) => t.id === o.id)) continue;
      const at = o.createdAt || now(), r = redact(String(o.description || '')).text.slice(0, MAX_TEXT);
      db.tickets.push({ id: String(o.id), ref: String(o.ref || 'T-' + crypto.randomBytes(3).toString('hex').toUpperCase()), ownerId: user.id, subject: redact(String(o.subject || 'Ticket')).text.slice(0, MAX_SUBJECT), category: CATEGORIES.includes(o.category) ? o.category : 'Troubleshooting', priority: 'normal', status: 'open', assigneeId: null, reference: /^[a-f0-9]{6,20}$/.test(o.reference || '') ? o.reference : '', notified: !!o.notified, createdAt: at, updatedAt: at,
        messages: [{ id: crypto.randomUUID(), at, role: 'customer', by: user.id, text: r, internal: false }], history: [{ at, from: null, to: 'open', role: 'customer', by: user.id }] }); }
    save(db); store.writeJson(lf, []);
  }

  function register(router, requireUser) {
    const small = (req, res, next) => (Number(req.get('content-length') || 0) > MAX_BODY_BYTES ? res.status(413).json({ error: 'That request is too large.' }) : next());
    const wrap = (fn) => async (req, res) => { try { const out = await fn(req, res); if (out !== undefined && !res.headersSent) res.set('Cache-Control', 'no-store').json(out); } catch (e) { const s = e.status || 500; if (s === 500) console.error('[support]', e.message); if (!res.headersSent) res.status(s).json({ error: s === 500 ? 'The request failed.' : e.message }); } };
    const mine = (req) => { if (!UUID.test(req.params.id)) throw httpErr(404, 'Not found.'); const db = load(), t = db.tickets.find((x) => x.id === req.params.id && x.ownerId === req.user.id); if (!t) throw httpErr(404, 'Not found.'); return { db, t }; };

    // ---- customers
    router.get('/phone-tickets', requireUser, wrap((req) => { importLegacy(req.user); return load().tickets.filter((t) => t.ownerId === req.user.id).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(pub); }));
    router.post('/phone-tickets', requireUser, small, wrap(async (req, res) => {
      const b = req.body || {}, subject = clean(b.subject, MAX_SUBJECT), desc = clean(b.description, MAX_TEXT);
      if (!subject.text) throw httpErr(400, 'Add a short subject.'); if (desc.text.length < 10) throw httpErr(400, 'Describe the problem in a few words (at least 10 characters).');
      const db = load(); if (db.tickets.filter((t) => t.ownerId === req.user.id && t.status !== 'closed').length >= MAX_TICKETS_PER_USER) throw httpErr(409, 'You have 50 open tickets. Close some before sending more.');
      const t = { id: crypto.randomUUID(), ref: 'T-' + crypto.randomBytes(3).toString('hex').toUpperCase(), ownerId: req.user.id, subject: subject.text, category: CATEGORIES.includes(b.category) ? b.category : 'Troubleshooting', priority: 'normal', status: 'open', assigneeId: null, reference: /^[a-f0-9]{6,20}$/.test(String(b.reference || '')) ? String(b.reference) : '', notified: false, createdAt: now(), updatedAt: now(), messages: [], history: [] };
      addMessage(t, { role: 'customer', by: req.user.id, text: desc.text, internal: false }); addHistory(t, { from: null, to: 'open', role: 'customer', by: req.user.id });
      const to = env.SUPPORT_EMAIL || '';
      if (mailer && mailer.enabled && mailer.isValidAddress(to)) { try { const r = await mailer.send({ to, subject: '[Qorlla Phone ' + t.ref + '] ' + t.subject, replyTo: req.user.emailVerified && req.user.email ? req.user.email : undefined, text: 'From: ' + req.user.displayName + ' (@' + req.user.username + ')\nCategory: ' + t.category + (t.reference ? '\nDiagnostics reference: ' + t.reference : '') + '\n\n' + desc.text }); t.notified = r.status === 'sent'; } catch (e) { t.notified = false; } }
      db.tickets.push(t); save(db); ping(staffAccounts().filter((s) => inScope(s, t)).map((s) => s.account.id), { ref: t.ref });
      res.status(201); return { ...customerView(t), redacted: subject.removed + desc.removed };
    }));
    router.get('/phone-tickets/:id', requireUser, wrap((req) => customerView(mine(req).t)));
    router.post('/phone-tickets/:id/reply', requireUser, small, wrap(async (req) => {
      const { db, t } = mine(req); if (t.status === 'closed') throw httpErr(409, 'This ticket is closed. Open a new ticket.'); const m = clean((req.body || {}).text, MAX_TEXT); if (m.text.length < 2) throw httpErr(400, 'Write a reply.');
      addMessage(t, { role: 'customer', by: req.user.id, text: m.text, internal: false });
      if (t.status === 'waiting_customer' || t.status === 'resolved') { addHistory(t, { from: t.status, to: 'in_progress', role: 'customer', by: req.user.id }); t.status = 'in_progress'; }     // an answer, or a reply to a "resolved" ticket, puts it back with support
      save(db); ping([t.assigneeId], { ref: t.ref }); return { ...customerView(t), redacted: m.removed };
    }));
    router.post('/phone-tickets/:id/close', requireUser, wrap((req) => { const { db, t } = mine(req); if (t.status === 'closed') return customerView(t); addHistory(t, { from: t.status, to: 'closed', role: 'customer', by: req.user.id }); t.status = 'closed'; save(db); ping([t.assigneeId], { ref: t.ref }); return customerView(t); }));

    // ---- support staff (SUPPORT_STAFF): only their own scope
    const asStaff = (req) => { const s = staffOf(req.user); if (!s) throw httpErr(403, 'Support staff only.'); return s; };
    const scoped = (req) => { const s = asStaff(req); if (!UUID.test(req.params.id)) throw httpErr(404, 'Not found.'); const db = load(), t = db.tickets.find((x) => x.id === req.params.id); if (!t || !inScope(s, t)) throw httpErr(404, 'Not found.'); return { s, db, t }; };
    router.get('/support/me', requireUser, wrap((req) => { const s = staffOf(req.user); return s ? { staff: true, role: s.role, categories: [...s.categories], states: STATES, priorities: PRIORITIES } : { staff: false }; }));
    router.get('/support/staff', requireUser, wrap((req) => { asStaff(req); return staffAccounts().map((s) => ({ id: s.account.id, username: s.account.username, displayName: s.account.displayName, role: s.role, categories: [...s.categories] })); }));
    router.get('/support/tickets', requireUser, wrap((req) => {
      const s = asStaff(req), q = String(req.query.q || '').toLowerCase().slice(0, 60), st = String(req.query.status || ''), as = String(req.query.assignee || ''), cat = String(req.query.category || '');
      return load().tickets.filter((t) => inScope(s, t) && (!st || t.status === st) && (!cat || t.category === cat) && (!as || (as === 'me' ? t.assigneeId === req.user.id : as === 'unassigned' ? !t.assigneeId : t.assigneeId === as)) && (!q || (t.ref + ' ' + t.subject + ' ' + nameOf(t.ownerId)).toLowerCase().includes(q)))
        .sort((a, b) => (PRANK[a.priority] - PRANK[b.priority]) || String(a.updatedAt).localeCompare(String(b.updatedAt))).slice(0, 200).map(staffSummary);
    }));
    router.get('/support/tickets/:id', requireUser, wrap((req) => { const { s, t } = scoped(req); return staffView(t, s, req.user); }));
    router.post('/support/tickets/:id/transition', requireUser, small, wrap(async (req) => {
      const { s, db, t } = scoped(req), b = req.body || {}, to = String(b.to || ''), lead = s.role === 'lead', own = t.assigneeId === req.user.id;
      if (!STATES.includes(to) || !NEXT[t.status].includes(to)) throw httpErr(409, 'A ticket cannot move from ' + t.status.replace(/_/g, ' ') + ' to ' + to.replace(/_/g, ' ') + '.');
      const note = clean(b.note, 500);
      if (to === 'assigned') {
        const target = String(b.assignee || (lead ? '' : req.user.id)); if (!target) throw httpErr(400, 'Choose who to assign it to.'); if (!lead && target !== req.user.id) throw httpErr(403, 'Only a support lead can assign tickets to someone else.');
        const acct = staffAccounts().find((x) => x.account.id === target && inScope(x, t)); if (!acct) throw httpErr(400, 'That person is not support staff for this category.'); t.assigneeId = target;
      } else if (to !== 'triaged' && !lead && !own) throw httpErr(403, 'Only the assigned agent or a support lead can do this.');
      if (to === 'resolved' && note.text.length < 5) throw httpErr(400, 'Describe the resolution (at least 5 characters).');
      const from = t.status; if (to === 'triaged' && from === 'assigned') t.assigneeId = null;
      addHistory(t, { from, to, role: 'staff', by: req.user.id, note: note.text }); t.status = to;
      if (to === 'resolved') addMessage(t, { role: 'staff', by: req.user.id, text: note.text, internal: false });
      save(db); ping([t.ownerId, t.assigneeId], { ref: t.ref }); if (['waiting_customer', 'resolved', 'closed'].includes(to)) await mailOwner(t, to); return staffView(t, s, req.user);
    }));
    const staffMessage = (internal) => wrap(async (req) => {
      const { s, db, t } = scoped(req); if (t.status === 'closed') throw httpErr(409, 'This ticket is closed.'); if (!internal && s.role !== 'lead' && t.assigneeId !== req.user.id) throw httpErr(403, 'Only the assigned agent or a support lead can reply to the customer.');
      const m = clean((req.body || {}).text, MAX_TEXT); if (m.text.length < 2) throw httpErr(400, 'Write a message.'); addMessage(t, { role: 'staff', by: req.user.id, text: m.text, internal }); save(db);
      if (!internal) { ping([t.ownerId], { ref: t.ref }); await mailOwner(t, t.status); } return { ...staffView(t, s, req.user), redacted: m.removed };
    });
    router.post('/support/tickets/:id/reply', requireUser, small, staffMessage(false));
    router.post('/support/tickets/:id/note', requireUser, small, staffMessage(true));
    router.post('/support/tickets/:id/priority', requireUser, small, wrap((req) => { const { s, db, t } = scoped(req), p = String((req.body || {}).priority || ''); if (!PRIORITIES.includes(p)) throw httpErr(400, 'Choose low, normal, high or urgent.'); if (s.role !== 'lead' && t.assigneeId !== req.user.id && t.assigneeId) throw httpErr(403, 'Only the assigned agent or a support lead can change the priority.'); addHistory(t, { from: t.status, to: t.status, role: 'staff', by: req.user.id, note: 'Priority ' + t.priority + ' to ' + p }); t.priority = p; save(db); return staffView(t, s, req.user); }));
  }
  return { register, redact, staffOf };
}
module.exports = createSupport; module.exports.redact = redact; module.exports.STATES = STATES; module.exports.NEXT = NEXT;
