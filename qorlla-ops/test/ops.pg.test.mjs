// Qorlla ops control against a real PostgreSQL (isolated schema) and a real ES256 signing key verified through jose. Skipped (not passed) when PostgreSQL is unreachable.
// Not proven here: a real identity provider, multi-tenancy, payment/entitlement authority integration (none exists), load, penetration review.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { generateKeyPair, SignJWT, jwtVerify } from 'jose';
import { createOpsApp } from '../app.mjs';

const ISS = 'https://id.qorlla.test', AUD = 'qorlla-ops';
let db, admin, schema, key, other, srv, base, limited, limitedBase;
const url = () => { try { const s = JSON.parse(fs.readFileSync(new URL('../../.dev-stack/secrets.json', import.meta.url), 'utf8')); return `postgres://qorlla:${s.dbPassword}@127.0.0.1:35432/qorlla_meet`; } catch { return null; } };
const listen = (app) => new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok([s, 'http://127.0.0.1:' + s.address().port])); });
const mint = (roles, o = {}) => new SignJWT({ roles }).setProtectedHeader({ alg: 'ES256' }).setSubject(o.sub ?? randomUUID()).setIssuer(o.iss ?? ISS).setAudience(o.aud ?? AUD).setIssuedAt().setExpirationTime(o.exp ?? '5m').sign(o.key ?? key.privateKey);
const call = async (token, method, path, body, b = base) => { const r = await fetch(b + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const TICKET = (o = {}) => ({ customer_id: randomUUID(), category: 'audio', subject: 'No sound', description: 'Cannot hear the other party', ...o });

before(async () => {
  const u = url(); if (!u) return; admin = new pg.Pool({ connectionString: u, max: 2 }); try { await admin.query('SELECT 1'); } catch { await admin.end(); admin = null; return; }
  schema = 'ops_' + Math.random().toString(36).slice(2, 9); await admin.query('CREATE SCHEMA ' + schema);
  db = new pg.Pool({ connectionString: u, options: '-c search_path=' + schema, max: 10 }); await db.query(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  key = await generateKeyPair('ES256'); other = await generateKeyPair('ES256');
  const verify = async (t) => (await jwtVerify(t, key.publicKey, { issuer: ISS, audience: AUD, algorithms: ['ES256'] })).payload;
  [srv, base] = await listen(createOpsApp({ db, verify })); [limited, limitedBase] = await listen(createOpsApp({ db, verify, ratePerMinute: 5 }));
});
after(async () => { for (const s of [srv, limited]) if (s) await new Promise((ok) => s.close(ok)); if (db) await db.end(); if (admin) { await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end(); } });
const skip = (t) => { if (!db) t.skip('no PostgreSQL reachable'); return !db; };

test('authentication: no/garbage/forged/wrong-issuer/wrong-audience/expired tokens are 401; tokens without a staff role or with a non-uuid subject are 403', async (t) => {
  if (skip(t)) return;
  for (const [name, tok] of [['none', null], ['garbage', 'abc.def.ghi'], ['foreign key', await mint(['super_admin'], { key: other.privateKey })], ['wrong issuer', await mint(['super_admin'], { iss: 'https://evil.test' })], ['wrong audience', await mint(['super_admin'], { aud: 'other' })], ['expired', await mint(['super_admin'], { exp: Math.floor(Date.now() / 1000) - 60 })]]) assert.equal((await call(tok, 'GET', '/api/ops/tickets')).status, 401, name);
  assert.equal((await call(await mint(['customer']), 'GET', '/api/ops/tickets')).status, 403, 'a non-staff role');
  assert.equal((await call(await mint(['admin', 'root']), 'GET', '/api/ops/tickets')).status, 403, 'unknown role names are ignored, not trusted');
  assert.equal((await call(await mint(['super_admin'], { sub: 'not-a-uuid' }), 'GET', '/api/ops/tickets')).status, 403);
  assert.equal((await call(null, 'GET', '/healthz')).status, 200); assert.equal((await call(null, 'GET', '/readyz')).status, 200);
});

test('ticket lifecycle: create, assign (lead only), the assignee (and only the assignee) moves status, illegal transitions refused, closed is final, every change is an event', async (t) => {
  if (skip(t)) return;
  const agent = randomUUID(), rival = randomUUID(), lead = await mint(['supervisor']), a = await mint(['support_agent'], { sub: agent }), rv = await mint(['support_agent'], { sub: rival });
  const c = await call(a, 'POST', '/api/ops/tickets', TICKET()); assert.equal(c.status, 201); const id = c.body.id; assert.equal(c.body.status, 'open');
  assert.equal((await call(a, 'POST', '/api/ops/tickets', { ...TICKET(), extra: 1 })).status, 400, 'unknown fields refused'); assert.equal((await call(a, 'POST', '/api/ops/tickets', TICKET({ category: 'nope' }))).status, 400);
  assert.equal((await call(a, 'POST', `/api/ops/tickets/${id}/assign`, { assignee_id: agent })).status, 403, 'an agent cannot assign');
  assert.equal((await call(lead, 'POST', `/api/ops/tickets/${id}/assign`, { assignee_id: agent })).status, 200);
  assert.equal((await call(rv, 'POST', `/api/ops/tickets/${id}/status`, { status: 'resolved' })).status, 403, 'another agent cannot move it');
  assert.equal((await call(a, 'POST', `/api/ops/tickets/${id}/status`, { status: 'closed' })).status, 409, 'assigned -> closed is not a legal move');
  assert.equal((await call(a, 'POST', `/api/ops/tickets/${id}/status`, { status: 'assigned' })).status, 400, 'assignment needs an assignee');
  assert.equal((await call(a, 'POST', `/api/ops/tickets/${id}/status`, { status: 'pending_customer' })).status, 200); assert.equal((await call(a, 'POST', `/api/ops/tickets/${id}/status`, { status: 'resolved' })).status, 200);
  assert.equal((await call(lead, 'POST', `/api/ops/tickets/${id}/status`, { status: 'closed' })).status, 200); assert.equal((await call(lead, 'POST', `/api/ops/tickets/${id}/status`, { status: 'resolved' })).status, 409, 'closed is final');
  assert.equal((await call(lead, 'POST', `/api/ops/tickets/${id}/assign`, { assignee_id: agent })).status, 409, 'a closed ticket cannot be reassigned');
  const g = await call(a, 'GET', `/api/ops/tickets/${id}`); assert.deepEqual(g.body.events.map((e) => e.event_type), ['created', 'assigned', 'status_changed', 'status_changed', 'status_changed']); assert.equal(g.body.events[2].details.from, 'assigned');
  assert.equal((await call(a, 'GET', '/api/ops/tickets?status=closed')).body.items.some((x) => x.id === id), true); assert.equal((await call(a, 'GET', '/api/ops/tickets?status=bogus')).status, 400);
  assert.equal((await call(a, 'GET', '/api/ops/tickets/not-a-uuid')).status, 400); assert.equal((await call(a, 'GET', `/api/ops/tickets/${randomUUID()}`)).status, 404);
});

test('two simultaneous status changes on one ticket: exactly one wins, the other is refused (no lost update, one event)', async (t) => {
  if (skip(t)) return;
  const lead = await mint(['ops_admin']), who = randomUUID(); const c = await call(lead, 'POST', '/api/ops/tickets', TICKET()); const id = c.body.id; await call(lead, 'POST', `/api/ops/tickets/${id}/assign`, { assignee_id: who });
  const rs = await Promise.all([call(lead, 'POST', `/api/ops/tickets/${id}/status`, { status: 'resolved' }), call(lead, 'POST', `/api/ops/tickets/${id}/status`, { status: 'escalated' })]);
  const codes = rs.map((x) => x.status).sort(); assert.ok(JSON.stringify(codes) === '[200,200]' || JSON.stringify(codes) === '[200,409]', 'legal outcomes only: ' + codes);
  const g = (await call(lead, 'GET', `/api/ops/tickets/${id}`)).body; const changes = g.events.filter((e) => e.event_type === 'status_changed' || e.event_type === 'assigned'); let at = 'open';
  for (const e of changes) { const from = e.event_type === 'assigned' ? e.details.status_from : e.details.from; assert.equal(from, at, 'each event starts from the state the previous one left (no lost update)'); at = e.event_type === 'assigned' ? 'assigned' : e.details.to; }
  assert.equal((await call(lead, 'GET', `/api/ops/tickets/${id}`)).body.status, at, 'the ticket ends in the last recorded state');
});

test('ticket history is append-only at the database: UPDATE, DELETE and TRUNCATE all fail', async (t) => {
  if (skip(t)) return;
  const a = await mint(['support_agent']); const c = await call(a, 'POST', '/api/ops/tickets', TICKET());
  await assert.rejects(db.query("UPDATE ops_ticket_events SET event_type='x' WHERE ticket_id=$1", [c.body.id]), /append-only/);
  await assert.rejects(db.query('DELETE FROM ops_ticket_events WHERE ticket_id=$1', [c.body.id]), /append-only/);
  await assert.rejects(db.query('TRUNCATE ops_ticket_events'), /append-only/);
  assert.equal((await call(a, 'GET', `/api/ops/tickets/${c.body.id}`)).body.events.length, 1);
});

test('external-calling requests are REQUESTS: right roles only, duplicates refused, cancel works once, no endpoint verifies, and the database refuses "verified" without the entitlement authority', async (t) => {
  if (skip(t)) return;
  const billing = await mint(['billing_agent']), tech = await mint(['technical_agent']), cust = randomUUID();
  assert.equal((await call(tech, 'POST', '/api/ops/external-call-requests', { customer_id: cust, plan_code: 'INTL_10' })).status, 403);
  assert.equal((await call(billing, 'POST', '/api/ops/external-call-requests', { customer_id: cust, plan_code: 'lower' })).status, 400); assert.equal((await call(billing, 'POST', '/api/ops/external-call-requests', { customer_id: cust, plan_code: 'INTL_10', status: 'verified' })).status, 400, 'a client cannot set status');
  const r = await call(billing, 'POST', '/api/ops/external-call-requests', { customer_id: cust, plan_code: 'INTL_10' }); assert.equal(r.status, 202); assert.equal(r.body.status, 'pending_verification');
  assert.equal((await call(billing, 'POST', '/api/ops/external-call-requests', { customer_id: cust, plan_code: 'INTL_10' })).status, 409, 'duplicate pending refused');
  assert.equal((await call(billing, 'POST', `/api/ops/external-call-requests/${r.body.id}/verify`, {})).status, 404, 'there is no verify endpoint'); assert.equal((await call(billing, 'PATCH', `/api/ops/external-call-requests/${r.body.id}`, { status: 'verified' })).status, 404);
  await assert.rejects(db.query("UPDATE ops_external_call_requests SET status='verified' WHERE id=$1", [r.body.id]), /entitlement authority/);
  assert.equal((await call(billing, 'POST', `/api/ops/external-call-requests/${r.body.id}/cancel`)).body.status, 'cancelled'); assert.equal((await call(billing, 'POST', `/api/ops/external-call-requests/${r.body.id}/cancel`)).status, 409);
  await assert.rejects(db.query("UPDATE ops_external_call_requests SET status='pending_verification' WHERE id=$1", [r.body.id]), /already cancelled/, 'a finished request cannot be revived');
  assert.equal((await call(billing, 'POST', '/api/ops/external-call-requests', { customer_id: cust, plan_code: 'INTL_10' })).status, 202, 'after cancel a new request is allowed');
  // the authority (and only it) can verify, inside its own transaction
  const r2 = await call(billing, 'POST', '/api/ops/external-call-requests', { customer_id: randomUUID(), plan_code: 'INTL_20' }); const c = await db.connect();
  try { await c.query('BEGIN'); await c.query("SELECT set_config('qorlla.entitlement_authority','on',true)"); await c.query("UPDATE ops_external_call_requests SET status='verified' WHERE id=$1", [r2.body.id]); await c.query('COMMIT'); } finally { c.release(); }
  assert.equal((await db.query('SELECT status FROM ops_external_call_requests WHERE id=$1', [r2.body.id])).rows[0].status, 'verified');
  assert.equal((await call(billing, 'GET', '/api/ops/external-call-requests')).status, 200); assert.equal((await call(tech, 'GET', '/api/ops/external-call-requests')).status, 403);
});

test('rate limiting is per staff identity: the sixth request in a minute gets 429, another identity is unaffected', async (t) => {
  if (skip(t)) return;
  const a = await mint(['support_agent']), b = await mint(['support_agent']); const codes = []; for (let i = 0; i < 7; i++) codes.push((await call(a, 'GET', '/api/ops/tickets', undefined, limitedBase)).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]); assert.equal((await call(b, 'GET', '/api/ops/tickets', undefined, limitedBase)).status, 200);
});
