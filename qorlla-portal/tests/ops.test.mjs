import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace } from './helpers.mjs';
import { startFakeStripe, WEBHOOK_SECRET } from './fake-stripe.mjs';
import { externalCallingDecision } from '../server/ops/adapters.mjs';

// Enterprise operations release tests, against a real PostgreSQL, the real portal app and MAIN's authentication contract (cookie JWT + JWKS + live session check + CSRF).
// The payment provider is tests/fake-stripe.mjs (a TEST DOUBLE): these prove OUR authorization, separation-of-duties, idempotency and fail-closed behaviour, not that a real Stripe account accepts the calls.
// Not proven: a real MAIN issuing MFA claims (it does not yet), Redis (the portal has none), load, penetration testing, the browser portals.
const key = () => 'idem-' + crypto.randomBytes(6).toString('hex');
const sql = (db, s, a = []) => db.pool.query(s, a).then((r) => r.rows);
const RANGES = JSON.stringify({ GB: ['0770090'] });

describe('enterprise operations', () => {
  let db, main, stripe, app, def, P, flaky, broken = false;
  const meetCalls = [];
  const adapters = { meetings: { getMeetingHealth: async (id) => { meetCalls.push(id); return { state: 'live', participants: 3, signalingHealthy: true, participantNames: ['Secret Person'], mediaUrl: 'https://x/y', passcode: '123456' }; } },
    shield: { authorized: true }, carrier: { certified: true } };
  const mkStaff = async (role, perms = [], { mfa = false, status = 'active', authTime } = {}) => {
    const u = await main.mint({ mfa, authTime }); await sql(db, 'INSERT INTO portal.ops_staff(user_id,display_name,team,role,permissions,employment_status) VALUES($1,$2,$3,$4,$5,$6)', [u.sub, role + ' ' + crypto.randomBytes(2).toString('hex'), 'support', role, perms, status]);
    return { u, id: u.sub, cl: app.client(u) };
  };
  const admin = (o) => mkStaff('ops_admin', [], { mfa: true, ...o });
  const customer = async () => { const u = await main.mint(); return { u, id: u.sub, cl: app.client(u) }; };
  const deliver = async (ev) => stripe.deliver(app.base, ev);
  /** a customer whose workspace really paid an invoice through the provider double */
  async function paidCustomer(seats = 2) {
    const cu = await customer(); const w = await seedWorkspace(db.pool, cu.id, 'Co ' + crypto.randomBytes(3).toString('hex'));
    const r = await cu.cl.post('/api/v1/billing/checkout', { plan: 'pro', interval: 'month', seats }); assert.equal(r.status, 201, JSON.stringify(r.body));
    const row = (await sql(db, 'SELECT * FROM portal.checkout_sessions WHERE id=$1', [r.body.checkout_id]))[0];
    const sub = stripe.subscription({ checkoutId: row.id, workspaceId: row.workspace_id, unitAmount: row.unit_amount_cents, interval: 'month', quantity: seats });
    const inv = stripe.invoice({ sub, amountPaid: row.unit_amount_cents * seats }); assert.equal((await deliver(stripe.event('invoice.paid', inv))).status, 200);
    const invoice = (await sql(db, 'SELECT id, amount_paid_cents FROM portal.invoices WHERE provider_invoice_id=$1', [inv.id]))[0];
    return { ...cu, w, invoiceId: invoice.id, paid: Number(invoice.amount_paid_cents) };
  }

  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn(); stripe = await startFakeStripe(); P = await main.mint({ mfa: true });
    flaky = { query: (s, ...a) => (broken && /ops_staff/.test(String(s)) ? Promise.reject(new Error('database down')) : db.pool.query(s, ...a)), connect: () => db.pool.connect(), on: () => {}, end: () => {} };
    const env = { BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_API_BASE: stripe.url, PLATFORM_ADMIN_USER_IDS: P.sub, OPS_ENABLED: 'true', OPS_REFUND_TWO_PERSON: 'true', OPS_APPROVED_NUMBER_RANGES: RANGES };
    const cfg = testConfig({ env, cfg: { } }, main); cfg.rateLimits.ops = 100000;
    app = await startApp({ pool: flaky, cfg, jwks: main.jwks, ops: { adapters } });
    await fetch(stripe.url + '/__control/reset', { method: 'POST' });
    for (const k of ['checkout']) await app.flags.set(k, true, null, P.sub);
    // a second app with every OPS setting at its default (nothing set): proves the shipped defaults
    const dcfg = testConfig({ env: { BILLING_ENABLED: 'false' } }, main); def = await startApp({ pool: db.pool, cfg: dcfg, jwks: main.jwks });
  });
  after(async () => { await app.close(); await def.close(); await stripe.close(); await main.close(); await db.drop(); });
  beforeEach(() => { broken = false; });

  test('1. an ordinary customer cannot reach Admin or Staff endpoints; neither can anonymous callers, non-admin staff, or suspended/terminated staff', async () => {
    const cu = await customer(), agent = await mkStaff('support_agent', ['ticket:work']), sus = await mkStaff('support_agent', ['ticket:work'], { status: 'suspended' }), fired = await mkStaff('billing_agent', ['billing:refund:request'], { status: 'terminated' });
    const S = '/api/v1/ops/staff', A = '/api/v1/ops/admin', id = crypto.randomUUID();
    const reads = [`${S}/me`, `${S}/tickets`, `${S}/refunds`, `${S}/shifts`, `${S}/time-entries`, `${A}/staff`, `${A}/refunds`, `${A}/gates`, `${A}/payroll/export?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z`];
    const writes = [[`${S}/tickets`, { customer_id: id, category: 'audio', subject: 'abc', description: 'abc' }], [`${S}/clock-in`, {}], [`${S}/refunds`, { invoice_id: id, reason: 'abc', idempotency_key: key() }], [`${S}/number-requests`, { customer_id: id, country: 'GB', range_prefix: '0770090' }], [`${A}/staff`, { user_id: id, display_name: 'x', team: 'xx', role: 'ops_admin' }], [`${A}/refunds/${id}/approve`, {}], [`${A}/refunds/process`, {}]];
    for (const who of [cu, sus, fired]) { for (const p of reads) assert.equal((await who.cl.get(p)).status, 403, 'read ' + p); for (const [p, b] of writes) assert.equal((await who.cl.post(p, b)).status, 403, 'write ' + p); }
    for (const p of reads) assert.equal((await app.client(null).get(p)).status, 401, 'anonymous ' + p);
    for (const p of reads.filter((x) => x.startsWith(A))) assert.equal((await agent.cl.get(p)).status, 403, 'non-admin staff ' + p);
    for (const [p, b] of writes.filter(([x]) => x.startsWith(A))) assert.equal((await agent.cl.post(p, b)).status, 403, 'non-admin staff ' + p);
    assert.equal((await agent.cl.get(`${S}/me`)).status, 200);
    const adm = await admin(); await sql(db, `UPDATE portal.ops_staff SET employment_status='terminated' WHERE user_id=$1`, [adm.id]); assert.equal((await adm.cl.get(`${A}/staff`)).status, 403, 'terminating staff cuts access at once');
  });

  test('admin needs MFA: no amr, stale auth_time, or a token without auth_time are refused; a fresh MFA token passes', async () => {
    const noMfa = await mkStaff('ops_admin'), stale = await mkStaff('ops_admin', [], { mfa: true, authTime: Math.floor(Date.now() / 1000) - 3600 }), ok = await admin();
    for (const w of [noMfa, stale]) { const r = await w.cl.get('/api/v1/ops/admin/staff'); assert.equal(r.status, 403); assert.equal(r.body.code, 'mfa_required'); }
    assert.equal((await ok.cl.get('/api/v1/ops/admin/staff')).status, 200);
    const sup = await mkStaff('supervisor', [], { mfa: true }); assert.equal((await sup.cl.get('/api/v1/ops/admin/staff')).status, 403, 'MFA does not make a supervisor an administrator');
  });

  test('staff directory: bootstrap by a platform admin with MFA; only a super administrator grants administrator roles; nobody edits themselves; deactivation returns cases to the queue', async () => {
    const target = crypto.randomUUID(), body = { user_id: target, display_name: 'Boot Strap', team: 'ops', role: 'super_admin', permissions: [] };
    const noMfaPlatform = await main.mint({ sub: P.sub }); assert.equal((await app.client(noMfaPlatform).post('/api/v1/ops/admin/staff', body)).status, 403, 'a platform admin without MFA cannot bootstrap');
    const bootstrap = await main.mint({ sub: P.sub, mfa: true }); const created = await app.client(bootstrap).post('/api/v1/ops/admin/staff', body); assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await app.client(bootstrap).post('/api/v1/ops/admin/staff', body)).status, 409);
    const opsAdmin = await admin(), newAdmin = crypto.randomUUID();
    assert.equal((await opsAdmin.cl.post('/api/v1/ops/admin/staff', { ...body, user_id: newAdmin, role: 'ops_admin' })).status, 403, 'an ops_admin cannot create administrators');
    const agentId = crypto.randomUUID(); assert.equal((await opsAdmin.cl.post('/api/v1/ops/admin/staff', { ...body, user_id: agentId, role: 'support_agent', permissions: ['ticket:work'] })).status, 201);
    assert.equal((await opsAdmin.cl.post('/api/v1/ops/admin/staff', { ...body, user_id: crypto.randomUUID(), role: 'support_agent', permissions: ['root'] })).status, 400, 'unknown permissions are refused');
    assert.equal((await opsAdmin.cl.patch(`/api/v1/ops/admin/staff/${opsAdmin.id}`, { role: 'super_admin' })).status, 409, 'cannot edit yourself');
    assert.equal((await opsAdmin.cl.patch(`/api/v1/ops/admin/staff/${target}`, { employment_status: 'suspended' })).status, 403, 'an ops_admin cannot change a super administrator');
    const agent = await mkStaff('support_agent', ['ticket:work', 'ticket:read']), lead = await mkStaff('supervisor');
    const t = await lead.cl.post('/api/v1/ops/staff/tickets', { customer_id: crypto.randomUUID(), category: 'audio', subject: 'No audio', description: 'cannot hear' }); await lead.cl.post(`/api/v1/ops/staff/tickets/${t.body.id}/assign`, { assignee_id: agent.id });
    const left = await opsAdmin.cl.patch(`/api/v1/ops/admin/staff/${agent.id}`, { employment_status: 'terminated' }); assert.equal(left.status, 200); assert.equal(left.body.released_tickets, 1);
    const row = (await sql(db, 'SELECT assignee_id,status FROM portal.ops_tickets WHERE id=$1', [t.body.id]))[0]; assert.deepEqual(row, { assignee_id: null, status: 'triaged' });
    assert.equal((await agent.cl.get('/api/v1/ops/staff/me')).status, 403, 'the terminated agent is out');
    assert.equal((await lead.cl.post(`/api/v1/ops/staff/tickets/${t.body.id}/assign`, { assignee_id: agent.id })).status, 409, 'a terminated person cannot be assigned work');
  });

  test('2. a staff member cannot see or touch another agent\'s cases, and restricted cases are limited to their assignee and leads; two agents claiming one ticket: one wins', async () => {
    const a = await mkStaff('support_agent', ['ticket:work', 'ticket:read']), b = await mkStaff('support_agent', ['ticket:work', 'ticket:read']), lead = await mkStaff('supervisor');
    const mk = async (category) => (await lead.cl.post('/api/v1/ops/staff/tickets', { customer_id: crypto.randomUUID(), category, subject: 'Case ' + category, description: 'details here' })).body.id;
    const own = await mk('audio'), restricted = await mk('abuse'), restrictedUnassigned = await mk('abuse'), queue = await mk('video');
    await lead.cl.post(`/api/v1/ops/staff/tickets/${own}/assign`, { assignee_id: a.id }); await lead.cl.post(`/api/v1/ops/staff/tickets/${restricted}/assign`, { assignee_id: a.id });
    const S = '/api/v1/ops/staff/tickets';
    for (const id of [own, restricted]) { assert.equal((await b.cl.get(`${S}/${id}`)).status, 404, 'another agent\'s case'); assert.equal((await b.cl.post(`${S}/${id}/status`, { status: 'in_progress' })).status, 404); assert.equal((await b.cl.post(`${S}/${id}/messages`, { body: 'hi' })).status, 404); assert.equal((await b.cl.post(`${S}/${id}/claim`)).status, 409); assert.equal((await a.cl.get(`${S}/${id}`)).status, 200); }
    const ids = (await b.cl.get(S)).body.items.map((x) => x.id); assert.ok(!ids.includes(own) && !ids.includes(restricted) && !ids.includes(restrictedUnassigned), 'not in the list'); assert.ok(ids.includes(queue), 'the open queue is visible');
    assert.equal((await b.cl.get(`${S}/${restrictedUnassigned}`)).status, 404, 'an unassigned RESTRICTED case is lead-only'); assert.equal((await b.cl.post(`${S}/${restrictedUnassigned}/claim`)).status, 409);
    assert.equal((await lead.cl.get(`${S}/${restricted}`)).status, 200); assert.equal((await b.cl.post(`${S}/${own}/assign`, { assignee_id: b.id })).status, 403, 'an agent cannot assign');
    const rs = await Promise.all([a.cl.post(`${S}/${queue}/claim`), b.cl.post(`${S}/${queue}/claim`)]); assert.deepEqual(rs.map((x) => x.status).sort(), [200, 409], 'exactly one claim wins');
    const ev = (await sql(db, `SELECT event_type FROM portal.ops_ticket_events WHERE ticket_id=$1 AND event_type='claimed'`, [queue])); assert.equal(ev.length, 1);
  });

  test('ticket workflow: state machine, assignment needs an assignee, closed is final, append-only history in the database', async () => {
    const lead = await mkStaff('supervisor'), agent = await mkStaff('support_agent', ['ticket:work', 'ticket:read']), S = '/api/v1/ops/staff/tickets';
    const id = (await lead.cl.post(S, { customer_id: crypto.randomUUID(), category: 'billing', subject: 'Invoice query', description: 'question' })).body.id;
    assert.equal((await lead.cl.post(`${S}/${id}/status`, { status: 'assigned' })).status, 400); assert.equal((await lead.cl.post(`${S}/${id}/status`, { status: 'resolved' })).status, 409, 'open -> resolved is illegal');
    assert.equal((await lead.cl.post(`${S}/${id}/assign`, { assignee_id: agent.id })).status, 200);
    assert.equal((await agent.cl.post(`${S}/${id}/status`, { status: 'in_progress' })).status, 200); assert.equal((await agent.cl.post(`${S}/${id}/status`, { status: 'resolved' })).status, 200);
    assert.equal((await lead.cl.post(`${S}/${id}/assign`, { assignee_id: agent.id })).status, 409, 'resolved tickets are not reassigned'); assert.equal((await lead.cl.post(`${S}/${id}/status`, { status: 'closed' })).status, 200); assert.equal((await lead.cl.post(`${S}/${id}/status`, { status: 'in_progress' })).status, 409, 'closed is final');
    const types = (await sql(db, 'SELECT event_type FROM portal.ops_ticket_events WHERE ticket_id=$1 ORDER BY id', [id])).map((r) => r.event_type); assert.deepEqual(types, ['created', 'assigned', 'status_changed', 'status_changed', 'status_changed']);
    await assert.rejects(db.pool.query(`UPDATE portal.ops_ticket_events SET event_type='x' WHERE ticket_id=$1`, [id]), /append-only/); await assert.rejects(db.pool.query('DELETE FROM portal.ops_ticket_events WHERE ticket_id=$1', [id]), /append-only/); await assert.rejects(db.pool.query('TRUNCATE portal.ops_ticket_events'), /append-only/);
    await assert.rejects(db.pool.query(`DELETE FROM portal.ops_audit_log`), /append-only/);
    const csrf = await agent.cl.post(`${S}/${id}/messages`, { body: 'x' }, { 'x-csrf-token': 'wrong' }); assert.equal(csrf.status, 403, 'writes need the CSRF token');
    assert.equal((await agent.cl.post(`${S}/${id}/messages`, { body: 'x' }, { origin: 'https://evil.test' })).status, 403, 'and a same-origin request');
  });

  test('3. customer replies and views never expose internal notes, staff identities or events; a customer sees only their own cases', async () => {
    const cu = await customer(), other = await customer(), agent = await mkStaff('support_agent', ['ticket:work', 'ticket:read']), lead = await mkStaff('supervisor');
    const t = await cu.cl.post('/api/v1/ops/support/tickets', { category: 'audio', subject: 'No sound on calls', description: 'My calls are silent' }); assert.equal(t.status, 201); const id = t.body.id;
    const asg = await lead.cl.post(`/api/v1/ops/staff/tickets/${id}/assign`, { assignee_id: agent.id }); assert.equal(asg.status, 200, JSON.stringify(asg.body));
    const internal = await agent.cl.post(`/api/v1/ops/staff/tickets/${id}/messages`, { body: 'INTERNAL: customer is on the fraud watchlist' }); assert.equal(internal.status, 201); assert.equal(internal.body.visibility, 'internal', 'the default is internal');
    const pub = await agent.cl.post(`/api/v1/ops/staff/tickets/${id}/messages`, { body: 'We are looking into it', visibility: 'customer' }); assert.equal(pub.status, 201);
    assert.equal((await cu.cl.post(`/api/v1/ops/support/tickets/${id}/messages`, { body: 'Thanks', visibility: 'internal' })).status, 400, 'a customer cannot choose visibility'); assert.equal((await cu.cl.post(`/api/v1/ops/support/tickets/${id}/messages`, { body: 'Thanks' })).status, 201);
    const view = await cu.cl.get(`/api/v1/ops/support/tickets/${id}`); assert.equal(view.status, 200); const text = JSON.stringify(view.body);
    assert.ok(!text.includes('INTERNAL') && !text.includes('fraud') && !text.includes(agent.id) && !('events' in view.body) && !('assignee_id' in view.body), 'nothing internal in the customer view');
    assert.deepEqual(view.body.messages.map((m) => m.body), ['We are looking into it', 'Thanks']);
    assert.equal((await other.cl.get(`/api/v1/ops/support/tickets/${id}`)).status, 404); assert.equal((await other.cl.post(`/api/v1/ops/support/tickets/${id}/messages`, { body: 'hello' })).status, 404); assert.equal((await other.cl.get('/api/v1/ops/support/tickets')).body.items.length, 0);
    assert.equal((await cu.cl.get('/api/v1/ops/support/tickets')).body.items.length, 1);
    await assert.rejects(db.pool.query(`INSERT INTO portal.ops_ticket_messages(ticket_id,author_id,author_kind,visibility,body) VALUES($1,$2,'customer','internal','x')`, [id, cu.id]), /violates check constraint/, 'the database also refuses a customer-authored internal note');
    assert.equal((await app.client(null).get('/api/v1/ops/support/tickets')).status, 401);
    assert.equal((await cu.cl.post('/api/v1/ops/support/tickets', { category: 'abuse', subject: 'Someone is harassing me', description: 'details' })).status, 201); const r = (await sql(db, `SELECT restricted FROM portal.ops_tickets WHERE category='abuse' AND customer_id=$1`, [cu.id]))[0]; assert.equal(r.restricted, true, 'abuse reports are restricted automatically');
  });

  describe('4. refunds: two people, verified payment, exactly once, reconciled', () => {
    const R = '/api/v1/ops/staff/refunds', AD = '/api/v1/ops/admin/refunds';
    test('requester cannot approve; a second administrator can; double approval and double execution are impossible', async () => {
      const biller = await mkStaff('billing_agent', ['billing:refund:request']), c = await paidCustomer(); stripe.st.refunds.length = 0;
      const req = await biller.cl.post(R, { invoice_id: c.invoiceId, amount_cents: 1000, reason: 'goodwill credit', idempotency_key: key() }); assert.equal(req.status, 201, JSON.stringify(req.body));
      const dup = await biller.cl.post(R, { invoice_id: c.invoiceId, amount_cents: 1000, reason: 'goodwill credit', idempotency_key: (await sql(db, 'SELECT idempotency_key k FROM portal.ops_refund_requests WHERE id=$1', [req.body.id]))[0].k }); assert.equal(dup.status, 200); assert.equal(dup.body.id, req.body.id);
      assert.equal((await biller.cl.post(`${AD}/${req.body.id}/approve`, {})).status, 403, 'a billing agent is not an administrator');
      const selfAdmin = await mkStaff('ops_admin', ['billing:refund:request'], { mfa: true }); const own = await selfAdmin.cl.post(R, { invoice_id: c.invoiceId, amount_cents: 500, reason: 'own request', idempotency_key: key() }); assert.equal(own.status, 201);
      const self = await selfAdmin.cl.post(`${AD}/${own.body.id}/approve`, {}); assert.equal(self.status, 409); assert.equal(self.body.code, 'separation_of_duties');
      await assert.rejects(db.pool.query(`UPDATE portal.ops_refund_requests SET status='approved', approved_by=requested_by WHERE id=$1`, [own.body.id]), /violates check constraint/, 'the database enforces two people too');
      await assert.rejects(db.pool.query(`UPDATE portal.ops_refund_requests SET status='executing' WHERE id=$1`, [own.body.id]), /must be approved/, 'nothing executes without approval');
      assert.equal((await (await admin()).cl.post(`${AD}/${own.body.id}/reject`, { note: 'no' })).status, 200);
      const a1 = await admin(), a2 = await admin(); const both = await Promise.all([a1.cl.post(`${AD}/${req.body.id}/approve`, {}), a2.cl.post(`${AD}/${req.body.id}/approve`, {})]); assert.deepEqual(both.map((x) => x.status).sort(), [200, 409], 'two simultaneous approvals: one wins');
      assert.equal((await a1.cl.post(`${AD}/${req.body.id}/approve`, {})).status, 409);
      assert.equal(stripe.st.refunds.length, 0, 'approval alone sends nothing to the provider');
      const runs = await Promise.all([a1.cl.post(`${AD}/process`, {}), a2.cl.post(`${AD}/process`, {})]); assert.equal(runs.reduce((n, r) => n + r.body.succeeded, 0), 1, 'two workers: one refund');
      assert.equal(stripe.st.refunds.length, 1); assert.equal(stripe.st.refunds[0].amount, 1000);
      assert.equal((await a1.cl.post(`${AD}/process`, {})).body.succeeded, 0); assert.equal(stripe.st.refunds.length, 1, 'executed once');
      const row = (await sql(db, 'SELECT status, provider_refund_id FROM portal.ops_refund_requests WHERE id=$1', [req.body.id]))[0]; assert.equal(row.status, 'succeeded'); assert.ok(row.provider_refund_id);
      const inv = (await sql(db, 'SELECT amount_refunded_cents, status FROM portal.invoices WHERE id=$1', [c.invoiceId]))[0]; assert.deepEqual({ ...inv, amount_refunded_cents: Number(inv.amount_refunded_cents) }, { amount_refunded_cents: 1000, status: 'partially_refunded' }, 'the billing authority recorded it');
      assert.deepEqual((await a1.cl.post(`${AD}/reconcile`, {})).body, { matched: 1, mismatch: 0, resolved: 0, needs_review: 0 }); await assert.rejects(db.pool.query(`UPDATE portal.ops_refund_requests SET status='approved' WHERE id=$1`, [req.body.id]), /already succeeded/);
      assert.ok((await sql(db, `SELECT 1 FROM portal.ops_audit_log WHERE action IN ('refund.requested','refund.approved','refund.executed')`)).length >= 3);
    });
    test('eligibility: only paid invoices, never more than remains (counting requests still in flight), failed provider calls end as failed and free the amount, the direct admin route is closed', async () => {
      const biller = await mkStaff('billing_agent', ['billing:refund:request']), c = await paidCustomer(1), ad = await admin(); stripe.st.refunds.length = 0;
      assert.equal((await biller.cl.post(R, { invoice_id: crypto.randomUUID(), reason: 'nothing', idempotency_key: key() })).status, 404);
      const big = await biller.cl.post(R, { invoice_id: c.invoiceId, amount_cents: c.paid, reason: 'whole invoice', idempotency_key: key() }); assert.equal(big.status, 201);
      const over = await biller.cl.post(R, { invoice_id: c.invoiceId, amount_cents: 1, reason: 'one more cent', idempotency_key: key() }); assert.equal(over.status, 400, 'requests in flight count against what is refundable'); assert.equal(over.body.code, 'exceeds_refundable');
      stripe.st.failRefund = true; assert.equal((await ad.cl.post(`${AD}/${big.body.id}/approve`, {})).status, 200); const failed = await ad.cl.post(`${AD}/process`, {}); assert.equal(failed.body.failed, 1); stripe.st.failRefund = false;
      assert.equal((await sql(db, 'SELECT status FROM portal.ops_refund_requests WHERE id=$1', [big.body.id]))[0].status, 'failed'); assert.equal((await ad.cl.post(`${AD}/process`, {})).body.succeeded, 0, 'a failed refund is never retried silently');
      assert.equal((await biller.cl.post(R, { invoice_id: c.invoiceId, amount_cents: 100, reason: 'again', idempotency_key: key() })).status, 201, 'the failed amount is free to request again');
      await sql(db, `UPDATE portal.invoices SET status='payment_failed' WHERE id=$1`, [c.invoiceId]); const notPaid = await biller.cl.post(R, { invoice_id: c.invoiceId, amount_cents: 100, reason: 'unpaid invoice', idempotency_key: key() }); assert.equal(notPaid.status, 409); assert.equal(notPaid.body.code, 'payment_not_eligible');
      const direct = await app.client(P).post('/api/v1/admin/billing/refunds', { invoice_id: c.invoiceId, reason: 'direct refund', idempotency_key: key() }); assert.equal(direct.status, 409); assert.equal(direct.body.code, 'two_person_approval_required'); assert.equal(stripe.st.refunds.length, 0);
      assert.equal((await biller.cl.post(R, { invoice_id: c.invoiceId, reason: 'x', idempotency_key: key(), extra: 1 })).status, 400);
    });
  });

  test('5. a payment failure cannot grant calling privileges: every condition must hold, operations has no way to activate calling, and requests only record', async () => {
    const reasonsOf = (o) => externalCallingDecision({ gates: { pstn: true }, shield: { authorized: true }, carrier: { certified: true }, invoice: { status: 'paid', amount_paid_cents: 1000, amount_refunded_cents: 0 }, ...o }).reasons;
    assert.deepEqual(reasonsOf({}), []); assert.deepEqual(reasonsOf({ invoice: { status: 'payment_failed', amount_paid_cents: 0 } }), ['payment_not_verified']); assert.deepEqual(reasonsOf({ invoice: null }), ['payment_not_verified']);
    assert.deepEqual(reasonsOf({ invoice: { status: 'refunded', amount_paid_cents: 1000, amount_refunded_cents: 1000 } }), ['payment_not_verified']); assert.deepEqual(reasonsOf({ shield: null }), ['shield_not_authorized']); assert.deepEqual(reasonsOf({ carrier: { certified: 'yes' } }), ['carrier_not_certified']); assert.deepEqual(reasonsOf({ gates: { pstn: false } }), ['pstn_disabled']);
    const agent = await mkStaff('billing_agent', ['calling:read', 'calling:request']), c = await paidCustomer(1), S = '/api/v1/ops/staff';
    const d = (await agent.cl.get(`${S}/customers/${c.id}/external-calling`)).body; assert.equal(d.allowed, false); assert.ok(d.reasons.includes('pstn_disabled'), 'the PSTN gate stays closed by default even with shield and carrier approved');
    await sql(db, `UPDATE portal.invoices SET status='payment_failed' WHERE id=$1`, [c.invoiceId]); const d2 = (await agent.cl.get(`${S}/customers/${c.id}/external-calling`)).body; assert.equal(d2.allowed, false); assert.ok(d2.reasons.includes('payment_not_verified'));
    const r = await agent.cl.post(`${S}/external-call-requests`, { customer_id: c.id, plan_code: 'INTL_10' }); assert.equal(r.status, 202); assert.equal(r.body.status, 'pending_verification'); assert.equal((await agent.cl.post(`${S}/external-call-requests`, { customer_id: c.id, plan_code: 'INTL_10' })).status, 409);
    for (const status of ['active', 'verified', 'enabled']) await assert.rejects(db.pool.query(`UPDATE portal.ops_external_call_requests SET status=$2 WHERE id=$1`, [r.body.id, status]), /violates check constraint/, 'no status means "calling is on"');
    assert.equal((await agent.cl.post(`${S}/external-call-requests/${r.body.id}/activate`, {})).status, 404); assert.equal((await agent.cl.post(`${S}/customers/${c.id}/external-calling`, { allowed: true })).status, 404);
    assert.equal((await agent.cl.post(`${S}/external-call-requests`, { customer_id: c.id, plan_code: 'ZZ_9', status: 'active' })).status, 400, 'a client cannot set status');
    assert.equal((await (await mkStaff('support_agent', ['ticket:work'])).cl.get(`${S}/customers/${c.id}/external-calling`)).status, 403);
  });

  test('6. an unapproved number range cannot be issued: by default nothing is approved, only approved prefixes can even be REQUESTED, and nothing in operations issues a number', async () => {
    const agent = await mkStaff('support_agent', ['numbers:request', 'numbers:read']), cu = crypto.randomUUID(), S = '/api/v1/ops/staff';
    for (const [country, range_prefix] of [['GB', '0771234'], ['GB', '07700'], ['GB', '0770091'], ['US', '0770090'], ['GH', '020000']]) { const r = await agent.cl.post(`${S}/number-requests`, { customer_id: cu, country, range_prefix }); assert.equal(r.status, 422, country + range_prefix); assert.equal(r.body.code, 'range_not_approved'); }
    assert.equal((await agent.cl.post(`${S}/number-requests`, { customer_id: cu, country: 'GB', range_prefix: '077009012' })).status, 400, 'prefix is 4-8 digits');
    const ok = await agent.cl.post(`${S}/number-requests`, { customer_id: cu, country: 'GB', range_prefix: '0770090' }); assert.equal(ok.status, 202); assert.equal(ok.body.status, 'pending_authority');
    for (const p of ['issue', 'assign', 'approve']) assert.equal((await agent.cl.post(`${S}/number-requests/${ok.body.id}/${p}`, {})).status, 404, 'no issuing route: ' + p);
    for (const status of ['issued', 'active', 'assigned']) await assert.rejects(db.pool.query(`UPDATE portal.ops_number_requests SET status=$2 WHERE id=$1`, [ok.body.id, status]), /violates check constraint/);
    assert.equal((await sql(db, `SELECT count(*)::int n FROM portal.ops_audit_log WHERE action='number.request.denied'`))[0].n, 5, 'every refusal is audited');
    const defStaff = await main.mint(); await sql(db, `INSERT INTO portal.ops_staff(user_id,display_name,team,role,permissions) VALUES($1,'d','support','support_agent','{numbers:request}')`, [defStaff.sub]);   // the default app: no range configured at all
    assert.equal((await def.client(defStaff).post(`${S}/number-requests`, { customer_id: cu, country: 'GB', range_prefix: '0770090' })).status, 404, 'with OPS_ENABLED unset the routes do not exist');
    assert.equal((await agent.cl.get(`${S}/customers/${cu}/number`)).status, 503, 'no Number Authority adapter: fail closed'); assert.equal((await agent.cl.get(`${S}/customers/${cu}/number`)).body.code, 'number_authority_unavailable');
  });

  test('7. an expired, revoked or forged session cannot reach protected operations; a failing session check fails closed', async () => {
    const mk = async (o) => { const u = await main.mint(o); await sql(db, `INSERT INTO portal.ops_staff(user_id,display_name,team,role,permissions) VALUES($1,'x','support','ops_admin','{}')`, [u.sub]); return app.client(u); };
    const paths = ['/api/v1/ops/staff/me', '/api/v1/ops/admin/staff', '/api/v1/ops/admin/gates', '/api/v1/ops/staff/tickets'];
    for (const [name, o] of [['revoked session', { active: false, mfa: true }], ['expired token', { mfa: true, iat: Math.floor(Date.now() / 1000) - 7200 }], ['forged signature', { mfa: true, key: main.other.privateKey }], ['wrong audience', { mfa: true, aud: 'someone-else' }]]) { const cl = await mk(o); for (const p of paths) assert.equal((await cl.get(p)).status, 401, name + ' ' + p); }
    const live = await mk({ mfa: true }); assert.equal((await live.get('/api/v1/ops/staff/me')).status, 200);
    const fresh = await mk({ mfa: true }); main.server.down = true; try { for (const p of paths) assert.equal((await fresh.get(p)).status, 503, 'session service down: ' + p); } finally { main.server.down = false; }
    assert.equal((await app.client(null).get('/api/v1/ops/staff/me', { cookie: 'qorlla_portal_session=garbage' })).status, 401);
  });

  test('8. a support agent cannot join, admit, record or otherwise act inside a meeting; diagnostics are read-only, whitelisted, audited and permissioned', async () => {
    const tech = await mkStaff('technical_agent', ['meetings:diagnose']), plain = await mkStaff('support_agent', ['ticket:work']), S = '/api/v1/ops/staff', mid = crypto.randomUUID();
    for (const p of ['join', 'admit', 'mute', 'record', 'media', 'listen', 'token']) for (const m of ['get', 'post']) assert.equal((await tech.cl[m](`${S}/meetings/${mid}/${p}`, m === 'post' ? {} : undefined)).status, 404, `${m} ${p}`);
    assert.equal((await plain.cl.get(`${S}/meetings/${mid}/diagnostics`)).status, 403, 'needs the permission'); meetCalls.length = 0;
    const d = await tech.cl.get(`${S}/meetings/${mid}/diagnostics`); assert.equal(d.status, 200); assert.deepEqual(d.body, { state: 'live', participants: 3, signalingHealthy: true }, 'only the whitelisted health fields'); assert.ok(!JSON.stringify(d.body).includes('Secret') && !JSON.stringify(d.body).includes('123456'));
    assert.deepEqual(meetCalls, [mid]); assert.equal((await sql(db, `SELECT count(*)::int n FROM portal.ops_audit_log WHERE action='meeting.diagnostics.read' AND actor_id=$1 AND resource_id=$2`, [tech.id, mid]))[0].n, 1, 'every read is audited');
    assert.equal((await tech.cl.get(`${S}/meetings/not-a-uuid/diagnostics`)).status, 400);
    const noAdapter = await mkStaff('technical_agent', ['meetings:diagnose']); const dflt = await startApp({ pool: db.pool, cfg: testConfig({ env: { OPS_ENABLED: 'true' } }, main), jwks: main.jwks });
    try { const r = await dflt.client(noAdapter.u).get(`${S}/meetings/${mid}/diagnostics`); assert.equal(r.status, 503); assert.equal(r.body.code, 'meeting_diagnostics_unavailable'); } finally { await dflt.close(); }
  });

  test('9. a database or session-service failure never bypasses authorization: protected handlers answer 503 and do nothing', async () => {
    const ad = await admin(), agent = await mkStaff('support_agent', ['ticket:work']), before = (await sql(db, 'SELECT count(*)::int n FROM portal.ops_tickets'))[0].n;
    broken = true;
    try {
      assert.equal((await agent.cl.get('/api/v1/ops/staff/tickets')).status, 503); assert.equal((await agent.cl.post('/api/v1/ops/staff/tickets', { customer_id: crypto.randomUUID(), category: 'audio', subject: 'abc', description: 'abc' })).status, 503);
      assert.equal((await ad.cl.get('/api/v1/ops/admin/staff')).status, 503); assert.equal((await ad.cl.post('/api/v1/ops/admin/refunds/process', {})).status, 503); assert.equal((await ad.cl.post(`/api/v1/ops/admin/refunds/${crypto.randomUUID()}/approve`, {})).status, 503);
    } finally { broken = false; }
    assert.equal((await sql(db, 'SELECT count(*)::int n FROM portal.ops_tickets'))[0].n, before, 'nothing was written while authority could not be checked');
    assert.equal((await agent.cl.get('/api/v1/ops/staff/me')).status, 200, 'and it recovers');
    const agent2 = await mkStaff('support_agent', ['ticket:work']), ad2 = await admin();   // fresh sessions: a session validated moments ago is cached for 5s by design
    main.server.down = true; try { assert.equal((await agent2.cl.get('/api/v1/ops/staff/me')).status, 503); assert.equal((await ad2.cl.get('/api/v1/ops/admin/gates')).status, 503); } finally { main.server.down = false; }
  });

  test('10. production defaults keep the calling and security gates closed: ops is off unless enabled, gates need the exact value, MFA and two-person refunds cannot be waived in production, and nothing can flip a gate', async () => {
    const { loadConfig } = await import('../server/config.mjs'); const base = { NODE_ENV: 'production', DATABASE_URL: 'x' };
    assert.equal(loadConfig(base).ops.enabled, false); for (const v of ['TRUE', '1', 'yes', ' true']) assert.equal(loadConfig({ ...base, OPS_ENABLED: v }).ops.enabled, false, v);
    const prod = loadConfig({ ...base, OPS_ENABLED: 'true', OPS_ADMIN_REQUIRE_MFA: 'false', OPS_REFUND_TWO_PERSON: 'false' }); assert.equal(prod.ops.requireMfa, true); assert.equal(prod.ops.refundTwoPerson, true, 'cannot be waived in production');
    for (const v of [undefined, 'false', 'TRUE', '1', 'yes', ' true', 'true ']) { const g = loadConfig({ ...base, ...(v === undefined ? {} : { VOICE_PSTN_ENABLED: v, VOICE_NUMBERS_ENABLED: v, VOICE_COUNTRY_ALIAS_ENABLED: v, VOICE_A38_ENABLED: v, PSTN_ENABLED: v }) }).ops.gates; assert.deepEqual(g, { pstn: false, numbers: false, countryAlias: false, a38: false }, String(v)); }
    assert.deepEqual(loadConfig({ ...base, VOICE_PSTN_ENABLED: 'true' }).ops.gates.pstn, true, 'only the exact value reports on'); assert.deepEqual(loadConfig({ ...base, OPS_APPROVED_NUMBER_RANGES: '{bad' }).ops.approvedRanges, {}, 'malformed ranges approve nothing'); assert.deepEqual(loadConfig({ ...base, OPS_APPROVED_NUMBER_RANGES: '{"GB":["0770090","x","12"],"gb":["0770"],"US":"1"}' }).ops.approvedRanges, { GB: ['0770090'] });
    const ad = await admin(), g = await ad.cl.get('/api/v1/ops/admin/gates'); assert.equal(g.status, 200); assert.equal(g.body.release, 'BLOCKED'); assert.deepEqual(g.body.gates, { pstn: false, numbers: false, countryAlias: false, a38: false });
    for (const m of ['put', 'post', 'patch']) assert.equal((await ad.cl[m]('/api/v1/ops/admin/gates', { pstn: true })).status, m === 'post' || m === 'put' || m === 'patch' ? 404 : 0, 'no route changes a gate');
    assert.equal((await app.client(P).get('/api/v1/admin/me')).body.platform_admin, true, 'the existing platform admin console is unchanged');
  });

  test('browser pages: served only when ops is enabled, with the strict CSP, no inline script, and no innerHTML/eval anywhere in their code', async () => {
    const fsm = await import('node:fs'), pathm = await import('node:path'), { fileURLToPath } = await import('node:url'), dir = pathm.join(pathm.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'ops');
    for (const p of ['admin', 'staff', 'support']) {
      const r = await fetch(app.base + '/ops/' + p), html = await r.text(); assert.equal(r.status, 200); assert.match(r.headers.get('content-security-policy'), /script-src 'self'/); assert.equal(r.headers.get('cache-control'), 'no-store');
      const scripts = html.match(/<script\b[^>]*>/g) || []; assert.equal(scripts.length, 1); assert.match(scripts[0], /type="module" src="\/ops\/assets\/\w+\.js"/, 'only an external module script'); assert.ok(!/\son\w+\s*=/.test(html), 'no inline handlers');
      assert.equal((await fetch(def.base + '/ops/' + p)).status, 404, 'not served when OPS_ENABLED is unset');
    }
    assert.equal((await fetch(app.base + '/ops/assets/staff.js')).status, 200); assert.equal((await fetch(def.base + '/ops/assets/staff.js')).status, 404);
    for (const f of ['ops.js', 'admin.js', 'staff.js', 'support.js']) { const code = fsm.readFileSync(pathm.join(dir, f), 'utf8'); assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(code), f + ' must insert data only with textContent'); }
  });

  test('workforce: clock in/out once, approval by a different supervisor, shifts without overlap, leave decided by someone else, payroll export of approved hours only (formula-safe)', async () => {
    const a = await mkStaff('support_agent', ['ticket:work']), lead = await mkStaff('supervisor'), lead2 = await mkStaff('supervisor'), S = '/api/v1/ops/staff';
    assert.equal((await a.cl.post(`${S}/clock-out`, {})).status, 409); assert.equal((await a.cl.post(`${S}/clock-in`, {})).status, 201); assert.equal((await a.cl.post(`${S}/clock-in`, {})).status, 409);
    const entry = (await a.cl.get(`${S}/time-entries`)).body.items[0]; assert.equal((await lead.cl.post(`${S}/time-entries/${entry.id}/approve`, {})).status, 409, 'cannot approve an open entry'); assert.equal((await a.cl.post(`${S}/clock-out`, {})).status, 200);
    await sql(db, `UPDATE portal.ops_time_entries SET started_at=now()-interval '3 hours 30 minutes' WHERE id=$1`, [entry.id]); await sql(db, `UPDATE portal.ops_time_entries SET ended_at=now()-interval '30 minutes' WHERE id=$1`, [entry.id]);
    assert.equal((await a.cl.post(`${S}/time-entries/${entry.id}/approve`, {})).status, 403, 'an agent cannot approve hours'); const self = await mkStaff('supervisor'); await self.cl.post(`${S}/clock-in`, {}); await self.cl.post(`${S}/clock-out`, {}); const mine = (await self.cl.get(`${S}/time-entries`)).body.items[0]; assert.equal((await self.cl.post(`${S}/time-entries/${mine.id}/approve`, {})).status, 409, 'nobody approves their own hours');
    assert.equal((await lead.cl.post(`${S}/time-entries/${entry.id}/approve`, {})).status, 200); assert.equal((await lead2.cl.post(`${S}/time-entries/${entry.id}/approve`, {})).status, 409, 'once');
    const from = new Date(Date.now() - 864e5).toISOString(), to = new Date(Date.now() + 864e5).toISOString(), ad = await admin();
    await sql(db, `UPDATE portal.ops_staff SET display_name='=HYPERLINK("http://evil","x")' WHERE user_id=$1`, [a.id]); const csv = await ad.cl.get(`/api/v1/ops/admin/payroll/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`); assert.equal(csv.status, 200); assert.match(csv.body, /"'=HYPERLINK/, 'formula injection is neutralised'); assert.ok(csv.body.includes(',"3"') || csv.body.includes('"3.00"') || csv.body.includes('3.00'), csv.body); assert.ok(!csv.body.includes(self.id), 'unapproved hours are not exported');
    assert.equal((await lead.cl.get(`/api/v1/ops/admin/payroll/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).status, 403);
    const sh = { staff_id: a.id, starts_at: '2030-01-01T09:00:00Z', ends_at: '2030-01-01T17:00:00Z' }; assert.equal((await lead.cl.post(`${S}/shifts`, sh)).status, 201); assert.equal((await lead.cl.post(`${S}/shifts`, { ...sh, starts_at: '2030-01-01T16:00:00Z', ends_at: '2030-01-01T20:00:00Z' })).status, 409, 'overlap'); assert.equal((await a.cl.post(`${S}/shifts`, sh)).status, 403); assert.equal((await lead.cl.post(`${S}/shifts`, { ...sh, ends_at: sh.starts_at })).status, 400);
    const lv = await a.cl.post(`${S}/leave`, { kind: 'vacation', starts_on: '2030-02-01', ends_on: '2030-02-05' }); assert.equal(lv.status, 201); assert.equal((await a.cl.post(`${S}/leave/${lv.body.id}/approve`, {})).status, 403, 'an agent cannot decide leave');
    const sl = await lead.cl.post(`${S}/leave`, { kind: 'sick', starts_on: '2030-03-01', ends_on: '2030-03-01' }); assert.equal((await lead.cl.post(`${S}/leave/${sl.body.id}/approve`, {})).status, 409, 'not your own leave'); assert.equal((await lead2.cl.post(`${S}/leave/${sl.body.id}/approve`, {})).status, 200);
    assert.equal((await lead.cl.post(`${S}/leave/${lv.body.id}/approve`, {})).status, 200); assert.equal((await lead.cl.post(`${S}/leave/${lv.body.id}/reject`, {})).status, 409, 'decided once'); assert.equal((await a.cl.post(`${S}/leave`, { kind: 'vacation', starts_on: '2030-02-05', ends_on: '2030-02-01' })).status, 400);
    assert.deepEqual((await a.cl.get(`${S}/leave`)).body.items.map((x) => x.staff_id), [a.id], 'an agent sees only their own leave');
  });
});
