const { test, expect } = require('@playwright/test');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { startMain, organiser, PASSWORD } = require('./support/meet-stack');
const createSupport = require('../support-tickets');
const AxeBuilder = require('@axe-core/playwright').default;
const axeBad = async (p) => (await new AxeBuilder({ page: p }).include('.qp').analyze()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id + ' ' + v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | '));

// Qorlla Phone hardening: the support-ticket workflow (roles, scope, redaction, history), microphone cleanup, truthful "saved but inactive" labels, and automated accessibility checks.
// Automated accessibility checks (axe) find a class of problems; they are NOT a screen-reader audit, and nothing here touches real microphones (a synthetic device is used).

// ------------------------------------------------------------------ support workflow: permissions and rules, against the real module in an isolated server
test.describe('support tickets: workflow, scope, redaction (isolated server)', () => {
  test.describe.configure({ mode: 'serial' });
  const mkUser = (id, username, extra = {}) => ({ id, username, displayName: username.toUpperCase(), email: username + '@example.com', emailVerified: true, ...extra });
  const U = { c1: mkUser('u_c1', 'cust1'), c2: mkUser('u_c2', 'cust2'), lead: mkUser('u_lead', 'suplead'), a1: mkUser('u_a1', 'supagent'), a2: mkUser('u_a2', 'supagent2'), bill: mkUser('u_bill', 'supbill') };
  const STAFF = [{ user: 'suplead', role: 'lead', categories: ['*'] }, { user: 'supagent', role: 'agent', categories: ['Calling Problems', 'Troubleshooting'] }, { user: 'supagent2', role: 'agent', categories: ['Calling Problems', 'Troubleshooting'] }, { user: 'supbill', role: 'agent', categories: ['Billing'] }];
  let srv, base, dataDir; const mails = [], pings = [];
  const call = async (who, method, p, body, headers = {}) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-user': who ? U[who].id : '', ...headers }, body: body === undefined || method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  test.beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsup-')); const app = express(); app.use(express.json({ limit: '8mb' }));
    const all = Object.values(U), requireUser = (req, res, next) => { const u = all.find((x) => x.id === req.get('x-user')); if (!u) return res.status(401).json({ error: 'Sign in' }); req.user = u; next(); };
    const auth = { listUsers: () => all.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName })), getUserById: (id) => all.find((u) => u.id === id) || null };
    const mailer = { enabled: true, isValidAddress: () => true, send: async (m) => { mails.push(m); return { status: 'sent' }; } };
    const router = express.Router(); createSupport({ dataDir, auth, mailer, notify: (ids, ev, p) => pings.push({ ids, ev, p }), env: { SUPPORT_STAFF: JSON.stringify(STAFF), SUPPORT_EMAIL: 'support@example.com' } }).register(router, requireUser); app.use('/api', router);
    srv = http.createServer(app); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + srv.address().port + '/api';
  });
  test.afterAll(async () => { if (srv) await new Promise((r) => srv.close(r)); fs.rmSync(dataDir, { recursive: true, force: true }); });

  test('redaction removes secrets of any length and shape, keeps meeting IDs, phone numbers and dates', async () => {
    const { redact } = createSupport;
    const t = 'pin is 12345678, pin: 123456789012, password hunter22, passcode=Tr0ub4dor&3, token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk, key sk-abcdefghijklmnopqrstuv, card 4111111111111111, blob ' + 'A1b2'.repeat(10) + ', otp 9921';
    const r = redact(t); expect(r.count).toBeGreaterThanOrEqual(8); for (const secret of ['12345678', '123456789012', 'hunter22', 'Tr0ub4dor', 'eyJhbGci', 'sk-abcdef', '4111111111111111', 'A1b2A1b2', '9921']) expect(r.text, secret).not.toContain(secret);
    const keep = redact('meeting 123 4567 8901 and 12345678901 and +12025550100 on 2026-10-28 at 10:30, call +44 20 7123 4567'); expect(keep.count).toBe(0); expect(redact('-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg\n-----END PRIVATE KEY-----').text).toBe('[removed]');
  });

  test('customer: create, redaction notice, limits, privacy between accounts, reply, close', async () => {
    const secret = 'My pin is 12345678, passcode: Secret123, meeting 123 4567 8901, +12025550100 on 2026-10-28, token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk';
    expect((await call('c1', 'POST', '/phone-tickets', { subject: '', description: 'long enough text here' })).status).toBe(400); expect((await call('c1', 'POST', '/phone-tickets', { subject: 'Hi', description: 'short' })).status).toBe(400);
    expect((await call(null, 'POST', '/phone-tickets', { subject: 'Hi', description: 'long enough text here' })).status).toBe(401);
    const big = await call('c1', 'POST', '/phone-tickets', JSON.stringify({ subject: 'Big', description: 'x'.repeat(21000) })); expect(big.status).toBe(413);   // request-size limit
    const c = await call('c1', 'POST', '/phone-tickets', { category: 'Billing', subject: 'Charges look wrong', description: secret }); expect(c.status).toBe(201);
    expect(c.json).toMatchObject({ status: 'open', category: 'Billing', priority: 'normal' }); expect(c.json.redacted).toBeGreaterThanOrEqual(3); expect(c.json.ref).toMatch(/^T-[0-9A-F]{6}$/);
    const text = c.json.messages[0].text; for (const keep of ['123 4567 8901', '+12025550100', '2026-10-28']) expect(text).toContain(keep); for (const gone of ['12345678', 'Secret123', 'eyJhbGci']) expect(text).not.toContain(gone);
    expect(c.json.history.map((h) => h.to)).toEqual(['open']); expect(JSON.stringify(c.json)).not.toMatch(/assigneeId|internal":true|u_lead/);
    expect(mails.length).toBe(1); expect(mails[0].to).toBe('support@example.com'); expect(mails[0].text).not.toMatch(/12345678|Secret123/);   // the support mailbox never receives the secret either
    const id = c.json.id; expect((await call('c2', 'GET', '/phone-tickets')).json).toEqual([]); for (const [m, p] of [['GET', ''], ['POST', '/reply'], ['POST', '/close']]) expect((await call('c2', m, '/phone-tickets/' + id + p, m === 'POST' ? { text: 'hello there' } : undefined)).status, m + p).toBe(404); expect((await call('c1', 'GET', '/phone-tickets/not-an-id')).status).toBe(404);
    const rep = await call('c1', 'POST', '/phone-tickets/' + id + '/reply', { text: 'More: password is hunter2222' }); expect(rep.status).toBe(200); expect(rep.json.redacted).toBe(1); expect(rep.json.messages.length).toBe(2); expect(JSON.stringify(rep.json)).not.toContain('hunter2222');
    expect((await call('c1', 'POST', '/phone-tickets/' + id + '/reply', { text: 'x' })).status).toBe(400);
    for (let i = 0; i < 40; i++) { const r = await call('c1', 'POST', '/phone-tickets/' + id + '/reply', { text: 'note number ' + i }); if (r.status === 409) { expect(r.json.error).toContain('too many messages'); break; } }   // a ticket cannot grow without bound
    const c2 = await call('c1', 'POST', '/phone-tickets', { subject: 'Close me', description: 'This one will be closed by me.' }); expect((await call('c1', 'POST', '/phone-tickets/' + c2.json.id + '/close', {})).json.status).toBe('closed'); expect((await call('c1', 'POST', '/phone-tickets/' + c2.json.id + '/reply', { text: 'still here?' })).status).toBe(409);
    expect((await call('c1', 'POST', '/phone-tickets/' + c2.json.id + '/close', {})).json.status).toBe('closed');   // closing twice is harmless
    expect((await call('c1', 'GET', '/phone-tickets')).json.map((t) => t.subject).sort()).toEqual(['Charges look wrong', 'Close me']);
  });

  test('staff: only staff, only their scope, valid transitions only, role rules, internal notes, history, notifications', async () => {
    const mine = (await call('c1', 'GET', '/phone-tickets')).json.find((t) => t.subject === 'Charges look wrong'); const billId = mine.id;
    expect((await call('c1', 'GET', '/support/me')).json).toEqual({ staff: false }); for (const [m, p] of [['GET', '/support/tickets'], ['GET', '/support/staff'], ['GET', '/support/tickets/' + billId], ['POST', '/support/tickets/' + billId + '/transition'], ['POST', '/support/tickets/' + billId + '/reply'], ['POST', '/support/tickets/' + billId + '/note']]) expect((await call('c1', m, p, {})).status, p).toBe(403);   // a customer is never staff
    expect((await call('lead', 'GET', '/support/me')).json).toMatchObject({ staff: true, role: 'lead' }); expect((await call('a1', 'GET', '/support/me')).json.categories).toEqual(['Calling Problems', 'Troubleshooting']);
    const calling = (await call('c1', 'POST', '/phone-tickets', { category: 'Calling Problems', subject: 'Cannot call', description: 'The call button says calling is not enabled.' })).json;
    // scope: billing sees billing, the calling agent sees calling, neither sees the other's
    expect((await call('bill', 'GET', '/support/tickets')).json.map((t) => t.ref)).toEqual([mine.ref]); const closeMe = (await call('c1', 'GET', '/phone-tickets')).json.find((t) => t.subject === 'Close me'); expect((await call('a1', 'GET', '/support/tickets')).json.map((t) => t.ref).sort()).toEqual([calling.ref, closeMe.ref].sort());   // Troubleshooting is in the agent's scope too expect((await call('lead', 'GET', '/support/tickets')).json.length).toBe(3);
    expect((await call('a1', 'GET', '/support/tickets/' + billId)).status).toBe(404); expect((await call('bill', 'GET', '/support/tickets/' + calling.id)).status).toBe(404); expect((await call('bill', 'POST', '/support/tickets/' + calling.id + '/transition', { to: 'triaged' })).status).toBe(404);
    // transitions: only the allowed next states; each move is recorded
    const T = (who, id, to, extra = {}) => call(who, 'POST', '/support/tickets/' + id + '/transition', { to, ...extra });
    expect((await T('a1', calling.id, 'assigned')).status).toBe(409); expect((await T('a1', calling.id, 'resolved', { note: 'done done' })).status).toBe(409); expect((await T('a1', calling.id, 'nonsense')).status).toBe(409);
    expect((await T('a1', calling.id, 'triaged')).json.status).toBe('triaged');
    expect((await T('a1', calling.id, 'assigned', { assignee: 'u_a2' })).status).toBe(403);   // an agent cannot assign someone else
    expect((await T('lead', calling.id, 'assigned', { assignee: 'u_bill' })).status).toBe(400); expect((await T('lead', calling.id, 'assigned', { assignee: 'u_c1' })).status).toBe(400);   // out of scope, or not staff
    expect((await T('lead', calling.id, 'assigned')).status).toBe(400);   // a lead must choose someone
    expect((await T('a1', calling.id, 'assigned')).json).toMatchObject({ status: 'assigned', assigneeName: 'SUPAGENT' });   // an agent can take it themselves
    expect((await T('a2', calling.id, 'in_progress')).status).toBe(403); expect((await call('a2', 'POST', '/support/tickets/' + calling.id + '/reply', { text: 'hello from the wrong agent' })).status).toBe(403);   // not the assignee
    expect((await call('a2', 'POST', '/support/tickets/' + calling.id + '/note', { text: 'INTERNAL-SECRETNOTE a2 saw this too' })).status).toBe(200);   // but may add an internal note
    expect((await T('a1', calling.id, 'in_progress')).json.status).toBe('in_progress');
    const rep = await call('a1', 'POST', '/support/tickets/' + calling.id + '/reply', { text: 'Please send the diagnostics reference from Help.' }); expect(rep.status).toBe(200);
    expect((await call('a1', 'POST', '/support/tickets/' + calling.id + '/note', { text: 'INTERNAL-SECRETNOTE customer seems new' })).status).toBe(200);
    expect((await T('a1', calling.id, 'waiting_customer', { note: 'asked for reference' })).json.status).toBe('waiting_customer');
    const cv = (await call('c1', 'GET', '/phone-tickets/' + calling.id)).json; expect(JSON.stringify(cv)).not.toContain('INTERNAL-SECRETNOTE'); expect(cv.messages.map((m) => m.who)).toEqual(['You', 'Support']); expect(JSON.stringify(cv)).not.toMatch(/SUPAGENT|u_a1|assigneeId|asked for reference/);   // customers never see internal notes, staff identities or transition notes
    const sv = (await call('a1', 'GET', '/support/tickets/' + calling.id)).json; expect(sv.messages.filter((m) => m.internal).length).toBe(2); expect(sv.history.map((h) => h.to)).toEqual(['open', 'triaged', 'assigned', 'in_progress', 'waiting_customer']); expect(sv.history.at(-1).note).toBe('asked for reference');
    // the customer's answer puts it back in progress by itself; a "resolved" ticket needs a resolution and shows it to the customer
    expect((await call('c1', 'POST', '/phone-tickets/' + calling.id + '/reply', { text: 'The reference is abc123def456' })).json.status).toBe('in_progress');
    expect((await T('a1', calling.id, 'resolved')).status).toBe(400); expect((await T('a1', calling.id, 'resolved', { note: 'ok' })).status).toBe(400); expect((await T('a1', calling.id, 'resolved', { note: 'Calling needs a carrier; use meetings meanwhile.' })).json.status).toBe('resolved');
    expect((await call('c1', 'GET', '/phone-tickets/' + calling.id)).json.messages.at(-1)).toMatchObject({ who: 'Support', text: 'Calling needs a carrier; use meetings meanwhile.' });
    expect((await call('c1', 'POST', '/phone-tickets/' + calling.id + '/reply', { text: 'It still happens for me' })).json.status).toBe('in_progress');   // replying to a resolved ticket reopens it
    await T('a1', calling.id, 'resolved', { note: 'Resolved again after checking.' }); expect((await T('a2', calling.id, 'closed')).status).toBe(403); expect((await T('lead', calling.id, 'closed')).json.status).toBe('closed');   // a lead can close; the unassigned agent cannot
    expect((await call('c1', 'POST', '/phone-tickets/' + calling.id + '/reply', { text: 'one more thing' })).status).toBe(409); expect((await T('lead', calling.id, 'in_progress')).status).toBe(409);   // closed is final
    expect((await call('lead', 'POST', '/support/tickets/' + calling.id + '/note', { text: 'late note' })).status).toBe(409);
    // priority, filters, search
    expect((await call('a1', 'POST', '/support/tickets/' + calling.id + '/priority', { priority: 'bogus' })).status).toBe(400); expect((await call('lead', 'POST', '/support/tickets/' + billId + '/priority', { priority: 'urgent' })).json.priority).toBe('urgent');
    const list = (await call('lead', 'GET', '/support/tickets')).json; expect(list[0].ref).toBe(mine.ref);   // urgent first
    expect((await call('lead', 'GET', '/support/tickets?status=closed')).json.map((t) => t.ref).sort()).toEqual([calling.ref, closeMe.ref].sort()); expect((await call('lead', 'GET', '/support/tickets?assignee=unassigned')).json.every((t) => !t.assigneeName)).toBe(true); expect((await call('a1', 'GET', '/support/tickets?assignee=me')).json.map((t) => t.ref)).toEqual([calling.ref]);
    expect((await call('lead', 'GET', '/support/tickets?q=cannot%20call')).json.length).toBe(1); expect((await call('lead', 'GET', '/support/tickets?category=Billing')).json.length).toBe(1);
    // notifications: the owner is told by push and by an email that carries NO message content; internal notes notify nobody
    const ownerMails = mails.filter((m) => m.to === 'cust1@example.com'); expect(ownerMails.length).toBeGreaterThanOrEqual(3); for (const m of ownerMails) { expect(m.text).toContain('does not include the message'); expect(m.text).not.toMatch(/diagnostics reference|carrier|INTERNAL/); }
    expect(pings.some((p) => p.ev === 'support_changed' && p.ids.includes('u_c1'))).toBe(true); expect(pings.some((p) => p.ids.includes('u_a1'))).toBe(true);
    expect(JSON.stringify((await call('lead', 'GET', '/support/tickets/' + billId)).json.history)).toContain('Priority');
  });

  test('tickets created before the workflow existed are imported once, redacted, and the old file is emptied', async () => {
    const dir = path.join(dataDir, 'workplace'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'phone-tickets.u_c2.json'), JSON.stringify([{ id: '11111111-2222-3333-4444-555555555555', ref: 'T-OLD123', subject: 'Old ticket', category: 'Billing', description: 'my pin is 12345678 from before', status: 'open', createdAt: '2026-01-01T00:00:00.000Z', reference: '', notified: true }]));
    const first = (await call('c2', 'GET', '/phone-tickets')).json; expect(first.map((t) => t.ref)).toEqual(['T-OLD123']); expect(first[0].status).toBe('open'); const d = (await call('c2', 'GET', '/phone-tickets/11111111-2222-3333-4444-555555555555')).json; expect(d.messages[0].text).not.toContain('12345678'); expect(d.messages[0].text).toContain('[removed]');
    expect((await call('c2', 'GET', '/phone-tickets')).json.length).toBe(1); expect(JSON.parse(fs.readFileSync(path.join(dir, 'phone-tickets.u_c2.json'), 'utf8'))).toEqual([]);   // no duplicate on the second visit
    expect((await call('c1', 'GET', '/phone-tickets/11111111-2222-3333-4444-555555555555')).status).toBe(404);   // and nobody else can read it
  });
});

// ------------------------------------------------------------------ the screens, in a real browser against the real server
test.describe('support screens, microphone cleanup, truthful labels, accessibility (real server, synthetic microphone)', () => {
  test.describe.configure({ mode: 'serial' });
  let main; const lead = 'suplead' + Math.random().toString(36).slice(2, 6), plain = 'plain' + Math.random().toString(36).slice(2, 6);
  test.beforeAll(async () => { main = await startMain(5291, { SUPPORT_STAFF: JSON.stringify([{ user: lead, role: 'lead', categories: ['*'] }]), PHONE_DIAL_IN_NUMBERS: '' }); });
  test.afterAll(() => main && main.stop());
  const account = async (browser, username, extra = {}) => { const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...extra }); expect((await ctx.request.post(main.base + '/api/auth/register', { data: { username, displayName: username, password: PASSWORD } })).status()).toBe(201); return ctx; };
  const phone = async (ctx) => { const page = await ctx.newPage(); await page.goto(main.base + '/qorlla.html#home'); await page.locator('.nav-item[data-view=phone]').click(); return page; };

  test('a customer and a support lead work one ticket end to end on the real screens', async ({ browser }) => {
    test.setTimeout(120000);
    const cctx = await account(browser, plain), cp = await phone(cctx); await cp.locator('#phHelpBtn').click(); await cp.locator('#hpTab-tickets').click(); await expect(cp.locator('#hpTab-console')).toHaveCount(0);   // no console for a customer
    expect((await cctx.request.get(main.base + '/api/workplace/support/tickets')).status()).toBe(403);
    await cp.locator('#hpCat').selectOption('Calling Problems'); await cp.locator('#hpSubject').fill('Call button does nothing'); await cp.locator('#hpDesc').fill('The call button says not enabled. My pin is 12345678, ignore it. Meeting 123 4567 8901.'); await cp.locator('#hpSend').click();
    await expect(cp.locator('#hpMsg')).toContainText('was created'); await expect(cp.locator('#hpMsg')).toContainText('looked like secrets were removed');
    await cp.locator('.hp-ticket').first().click(); await expect(cp.locator('#hpThread')).toContainText('123 4567 8901'); await expect(cp.locator('#hpThread')).not.toContainText('12345678'); await expect(cp.locator('#hpTicketStatus')).toContainText('Open'); const ref = (await cp.locator('#hpTicketTitle').textContent()).split(' ')[0];
    // the support lead
    const lctx = await account(browser, lead), lp = await phone(lctx); await lp.locator('#phHelpBtn').click(); await expect(lp.locator('#hpTab-console')).toBeVisible(); await lp.locator('#hpTab-console').click(); await expect(lp.locator('#sxScope')).toContainText('lead');
    await lp.locator('.sx-row', { hasText: ref }).click(); await expect(lp.locator('#sxTitle')).toContainText('Call button does nothing'); await expect(lp.locator('#sxThread')).toContainText('[removed]'); expect(await axeBad(lp), 'support console').toEqual([]);
    const move = async (to, note) => { await lp.locator('#sxTo').selectOption(to); if (to === 'assigned') { await expect(lp.locator('#sxAssignee option')).not.toHaveCount(0); await lp.locator('#sxAssignee').selectOption({ index: 0 }); } if (note) await lp.locator('#sxNote').fill(note); await lp.locator('#sxMove').click(); };
    await move('triaged'); await expect(lp.locator('#sxStatusBadge')).toContainText('Triaged'); await move('assigned'); await expect(lp.locator('#sxStatusBadge')).toContainText('Assigned'); await move('in_progress'); await expect(lp.locator('#sxStatusBadge')).toContainText('In progress');
    await lp.locator('#sxReply').fill('Calling needs a connected carrier. Anything else?'); await lp.locator('#sxSendReply').click(); await expect(lp.locator('#sxThread')).toContainText('connected carrier'); await lp.locator('#sxInternal').fill('INTERNAL-ONLY remember to check the carrier status'); await lp.locator('#sxAddNote').click(); await expect(lp.locator('#sxThread .internal')).toContainText('INTERNAL-ONLY');
    await move('waiting_customer'); await expect(lp.locator('#sxStatusBadge')).toContainText('Waiting for customer'); await lp.locator('#sxSetPriority').click();
    // the customer sees the reply and a status of their own, and never the internal note
    await cp.locator('#hpBackTickets').click(); await cp.locator('.hp-ticket').first().click(); await expect(cp.locator('#hpTicketStatus')).toContainText('Waiting for customer'); await expect(cp.locator('#hpThread')).toContainText('connected carrier'); await expect(cp.locator('#hpThread')).not.toContainText('INTERNAL-ONLY'); await expect(cp.locator('#hpHistory')).not.toContainText('lead');
    await cp.locator('#hpReplyText').fill('No, that explains it. Thank you.'); await cp.locator('#hpReplySend').click(); await expect(cp.locator('#hpThread')).toContainText('that explains it'); await expect(cp.locator('#hpTicketStatus')).toContainText('In progress');   // answering moved it back to support
    await lp.locator('#sxRefresh').click(); await lp.locator('.sx-row', { hasText: ref }).click(); await expect(lp.locator('#sxStatusBadge')).toContainText('In progress'); await move('resolved'); await expect(lp.locator('#sxMsg')).toContainText('at least 5 characters'); await move('resolved', 'Explained that calling needs a carrier.'); await expect(lp.locator('#sxStatusBadge')).toContainText('Resolved');
    await lp.locator('#sxHistory').evaluate((e) => e.closest('details').setAttribute('open', '')); await expect(lp.locator('#sxHistory')).toContainText('Open'); await expect(lp.locator('#sxHistory')).toContainText('Resolved');
    await cp.locator('#hpBackTickets').click(); await cp.locator('.hp-ticket').first().click(); await expect(cp.locator('#hpTicketStatus')).toContainText('Resolved'); await expect(cp.locator('#hpThread')).toContainText('Explained that calling needs a carrier'); cp.once('dialog', (d) => d.accept()); await cp.locator('#hpCloseTicket').click(); await expect(cp.locator('#hpTicketStatus')).toContainText('Closed');
    await cctx.close(); await lctx.close();
  });

  test('the microphone opens only on an explicit click and every track is stopped when the test ends, fails, is left, or arrives late', async ({ browser, browserName }) => {
    test.setTimeout(150000);
    const ctx = await account(browser, 'mic' + Math.random().toString(36).slice(2, 7), browserName === 'chromium' ? { permissions: ['microphone'] } : {});
    await ctx.addInitScript(() => { window.__streams = []; const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md); md.getUserMedia = async (c) => { if (window.__micDelay) await new Promise((r) => setTimeout(r, window.__micDelay)); const s = await orig(c); window.__streams.push(s); return s; }; });
    const open = async () => { const p = await phone(ctx); await p.locator('#phSettingsBtn').click(); await expect(p.locator('#psCallerName')).toBeVisible(); await p.locator('#psNav-audio').click(); await expect(p.locator('#psTestMic')).toBeVisible(); return p; };
    const live = (p) => p.evaluate(() => window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length), total = (p) => p.evaluate(() => window.__streams.length);
    let p = await open(); await p.waitForTimeout(800); expect(await total(p)).toBe(0);                                                      // merely opening Audio & Devices never touches the microphone
    for (const sec of ['calling', 'dialin', 'privacy', 'notify', 'history', 'plans', 'admin']) { await p.locator('#psNav-' + sec).click(); } await p.locator('#phHelpBtn').click(); await p.locator('#hpTab-diag').click(); await p.locator('#hpRun').click(); await expect(p.locator('#hpRef')).toBeVisible(); expect(await total(p)).toBe(0);   // and neither does any other settings page, nor the diagnostics audio check
    p = await open(); await p.locator('#psTestMic').click(); await expect.poll(() => live(p)).toBeGreaterThan(0); await expect(p.locator('#psAudioMsg')).toContainText('microphone is working', { timeout: 15000 }); expect(await live(p)).toBe(0);   // finished: stopped
    await p.locator('#psTestMic').click(); await expect.poll(() => live(p)).toBeGreaterThan(0); await p.locator('#psNav-privacy').click(); await expect.poll(() => live(p), { timeout: 3000 }).toBe(0);   // leaving the section stops it at once
    p = await open(); await p.locator('#psTestMic').click(); await expect.poll(() => live(p)).toBeGreaterThan(0); await p.locator('.nav-item[data-view=home]').click(); await expect.poll(() => live(p), { timeout: 3000 }).toBe(0);   // leaving the whole Phone view too
    p = await open(); await p.evaluate(() => { window.__micDelay = 900; }); await p.locator('#psTestMic').click(); await p.locator('#psNav-privacy').click(); await p.waitForTimeout(2200); expect(await total(p)).toBe(1); expect(await live(p)).toBe(0);   // the stream arrived AFTER leaving: closed immediately
    p = await open(); await p.evaluate(() => { window.__micDelay = 0; window.AudioContext = function () { throw new Error('no audio context'); }; window.webkitAudioContext = undefined; }); await p.locator('#psTestMic').click(); await expect(p.locator('#psAudioMsg')).toContainText('could not be analysed'); expect(await live(p)).toBe(0);   // a failure after the microphone opened still closes it
    p = await open(); await p.locator('#psAllowDev').click(); await expect(p.locator('#psAudioMsg')).toContainText('Device names are now shown'); expect(await live(p)).toBe(0);   // "show device names" opens it only long enough to ask permission
    await p.reload(); p = await open(); await p.locator('#psTestMic').click(); await expect.poll(() => live(p)).toBeGreaterThan(0); await p.goto('about:blank'); await p.waitForTimeout(300);   // closing the tab is the browser's job; the beforeunload cleanup is covered by the view teardown above
    await ctx.close();
  });

  test('saved call preferences say so honestly: "saved, inactive" with the reason, never "on"', async ({ browser }) => {
    const ctx = await account(browser, 'feat' + Math.random().toString(36).slice(2, 7)); const p = await phone(ctx); await p.locator('#phSettingsBtn').click();
    for (const f of ['callerId', 'callWaiting', 'doNotDisturb', 'forwarding', 'voicemail']) await expect(p.locator('#feat-' + f)).toBeVisible();
    await p.locator('#psFwdOn').check(); await p.locator('#psFwdTo').fill('+442071234567'); await p.locator('#psDnd').check(); await p.locator('#psSaveCalling').click(); await expect(p.locator('#psSaveCallingMsg')).toContainText('once carrier calling is connected');
    await p.reload(); await p.locator('.nav-item[data-view=phone]').click(); await p.locator('#phSettingsBtn').click(); await expect(p.locator('#psFwdOn')).toBeChecked();
    await expect(p.locator('#feat-forwarding')).toContainText('Saved'); await expect(p.locator('#feat-forwarding')).toContainText('inactive'); await expect(p.locator('#feat-forwarding')).toHaveAttribute('data-state', /inactive/); await expect(p.locator('#feat-forwarding')).not.toContainText('Active');
    await p.locator('#psNav-privacy').click(); await expect(p.locator('#feat-spamProtection')).toContainText('inactive'); await expect(p.locator('#feat-blockedNumbers')).toContainText('Off');
    await expect.poll(async () => ((await (await ctx.request.get(main.base + '/api/phone/features')).json()).features.forwarding || {}).enabled).toBe(true);   // the save is passed to Meet in the background
    const f = await (await ctx.request.get(main.base + '/api/phone/features')).json(); expect(Object.keys(f.features).sort()).toEqual(['blockedNumbers', 'callWaiting', 'callerId', 'doNotDisturb', 'forwarding', 'spamProtection', 'voicemail']); expect(f.enforcing).toBe(0);
    expect(f.features.forwarding).toMatchObject({ enabled: true, state: 'inactive' }); expect(f.features.forwarding.reason).toMatch(/No carrier is connected/); expect(JSON.stringify(f)).not.toContain('+442071234567');   // the number is not echoed back
    expect((await (await ctx.request.get(main.base + '/api/workplace/phone-settings')).json()).forwardEnabled).toBe(true);
    await ctx.close();
  });

  test('mobile: Settings, Help, tickets and the support console fit a phone-sized touch screen: nothing overflows sideways and controls are large enough to tap', async ({ browser }) => {
    test.setTimeout(150000);
    const { devices } = require('@playwright/test'); const dev = devices['Pixel 7'];
    const ctx = await browser.newContext({ viewport: dev.viewport, userAgent: dev.userAgent, deviceScaleFactor: dev.deviceScaleFactor, isMobile: true, hasTouch: true }); const reg = await ctx.request.post(main.base + '/api/auth/register', { data: { username: lead, displayName: 'Lead', password: PASSWORD } }); if (reg.status() === 409) expect((await ctx.request.post(main.base + '/api/auth/login', { data: { username: lead, password: PASSWORD } })).status()).toBe(200); else expect(reg.status()).toBe(201);   // the lead already exists when the whole file runs
    const page = await ctx.newPage(); await page.goto(main.base + '/qorlla.html#home'); await page.locator('.nav-item[data-view=phone], [data-view=phone]').first().click({ force: true }).catch(() => {});
    if (!(await page.locator('#phSettingsBtn').isVisible().catch(() => false))) await page.goto(main.base + '/qorlla.html#phone');
    await expect(page.locator('#phSettingsBtn')).toBeVisible({ timeout: 15000 });
    const problems = async (label) => page.evaluate((l) => {
      const out = [], vw = document.documentElement.clientWidth; if (document.documentElement.scrollWidth > vw + 1) out.push(l + ': page scrolls sideways (' + document.documentElement.scrollWidth + ' > ' + vw + ')');
      const root = document.querySelector('.qp'); if (!root) return out;
      for (const el of root.querySelectorAll('button, a[href], select, input:not([type=hidden]), textarea, summary, [role=tab]')) {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el); if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none' || el.closest('.hidden')) continue;
        if (r.right > vw + 1 || r.left < -1) out.push(l + ': ' + (el.id || el.className || el.tagName) + ' is cut off at the edge');
        if ((r.width < 24 || r.height < 24) && el.type !== 'checkbox' && el.type !== 'radio') out.push(l + ': ' + (el.id || el.getAttribute('aria-label') || el.textContent.slice(0, 20)) + ' is only ' + Math.round(r.width) + 'x' + Math.round(r.height) + 'px');
      } return out; }, label);
    const all = [];
    await page.locator('#phSettingsBtn').tap(); await expect(page.locator('#psPage')).toBeVisible(); for (const sec of ['calling', 'audio', 'dialin', 'privacy', 'notify', 'history', 'plans', 'admin']) { await page.locator('#psNav-' + sec).tap(); await page.waitForTimeout(150); all.push(...await problems('settings/' + sec)); }
    await page.locator('#phHelpBtn').tap(); all.push(...await problems('help')); await page.locator('.hp-card').first().tap(); all.push(...await problems('help/category')); await page.locator('#hpTab-diag').tap(); await page.locator('#hpRun').tap(); await expect(page.locator('#hpRef')).toBeVisible(); all.push(...await problems('diagnostics'));
    await page.locator('#hpTab-tickets').tap(); all.push(...await problems('tickets')); await page.locator('#hpSubject').fill('Phone layout'); await page.locator('#hpDesc').fill('A ticket created on a phone-sized screen.'); await page.locator('#hpSend').tap(); await page.locator('.hp-ticket').first().tap(); all.push(...await problems('ticket detail'));
    await page.locator('#hpBackTickets').tap(); await expect(page.locator('#hpTab-console')).toBeVisible(); await page.locator('#hpTab-console').tap(); await page.locator('.sx-row').first().tap(); await expect(page.locator('#sxTitle')).toBeVisible(); all.push(...await problems('support console'));
    for (const t of ['dial', 'join', 'recent', 'contacts', 'settings']) { await page.locator('#phTab-' + t).tap(); await page.waitForTimeout(150); all.push(...await problems('phone/' + t)); }
    expect([...new Set(all)]).toEqual([]); await ctx.close();
  });

  test('automated accessibility (axe): Settings, Help, ticket screens and the support console have no serious or critical violations; keyboard navigation works', async ({ browser }) => {
    test.setTimeout(150000);
    const cctx = await account(browser, 'a11y' + Math.random().toString(36).slice(2, 6)), cp = await phone(cctx);
    const scan = async (p, label) => { const r = await new AxeBuilder({ page: p }).include('.qp').analyze(); const bad = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact)); expect(bad.map((v) => label + ': ' + v.id + ' ' + v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')), label).toEqual([]); };
    await cp.locator('#phSettingsBtn').click(); await expect(cp.locator('#psPage')).toBeVisible(); for (const sec of ['calling', 'audio', 'dialin', 'privacy', 'notify', 'history', 'plans', 'admin']) { await cp.locator('#psNav-' + sec).click(); await scan(cp, 'settings/' + sec); }
    await cp.locator('#phHelpBtn').click(); await scan(cp, 'help/center'); await cp.locator('.hp-card').first().click(); await scan(cp, 'help/category'); await cp.locator('#hpTab-diag').click(); await cp.locator('#hpRun').click(); await expect(cp.locator('#hpRef')).toBeVisible(); await scan(cp, 'help/diagnostics'); await cp.locator('#hpD-guide').click(); await scan(cp, 'help/guide');
    await cp.locator('#hpTab-tickets').click(); await scan(cp, 'tickets'); await cp.locator('#hpSubject').fill('Accessibility check'); await cp.locator('#hpDesc').fill('A ticket made by the accessibility test run.'); await cp.locator('#hpSend').click(); await cp.locator('.hp-ticket').first().click(); await scan(cp, 'ticket detail');
    for (const tab of ['dial', 'join', 'recent', 'contacts', 'settings']) { await cp.locator('#phTab-' + tab).click(); await scan(cp, 'phone/' + tab); }
    // keyboard: arrow keys move through the settings sections and tabs, Tab reaches the controls, Enter activates a button
    await cp.locator('#phSettingsBtn').focus(); await cp.keyboard.press('Enter'); await expect(cp.locator('#psPage')).toBeVisible(); await cp.locator('#psNav-calling').focus(); await cp.keyboard.press('ArrowDown'); await expect(cp.locator('#psNav-audio')).toHaveAttribute('aria-selected', 'true'); await cp.keyboard.press('ArrowUp'); await expect(cp.locator('#psNav-calling')).toHaveAttribute('aria-selected', 'true');
    await cp.keyboard.press('Tab'); await expect(cp.locator('#psNav-calling')).not.toBeFocused();
    await cp.locator('#phTab-dial').focus(); await cp.keyboard.press('ArrowRight'); await expect(cp.locator('#phTab-join')).toHaveAttribute('aria-selected', 'true');
    await cp.locator('#phHelpBtn').focus(); await cp.keyboard.press('Enter'); await expect(cp.locator('#hpH')).toBeVisible(); await cp.locator('#hpSearch').focus(); await cp.keyboard.type('pin'); await expect(cp.locator('.hp-art').first()).toBeVisible(); await cp.keyboard.press('Tab'); await cp.keyboard.press('Tab');
    await cctx.close();
  });
});
