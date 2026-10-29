// One number authority: the REAL Numbers & Plans service (qorlla-meet-video/server/telephony) on real PostgreSQL, synchronized through its transactional outbox to the REAL voice engine over HTTP with real
// signed workload credentials. The carrier is a controllable stand-in (the Twilio adapter has not been run against real Twilio; that is a separate certification step).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID, generateKeyPairSync, randomBytes } from 'node:crypto';
import { exportJWK, importSPKI } from 'jose';
import { isolatedDb, identityProvider, testDbUrl } from './helpers.mjs';
import { harness } from './harness.mjs';
import { TelephonyService } from '../../qorlla-meet-video/server/telephony/service.mjs';
import { createEngineSink, signWorkloadJwt } from '../../qorlla-meet-video/server/telephony/number-sync.mjs';
import { classifyProviderError } from '../../qorlla-meet-video/server/telephony/number-authority.mjs';

const sql = (f) => readFileSync(new URL('../../qorlla-meet-video/sql/' + f, import.meta.url), 'utf8');
const ADMIN = { id: 'ops1', admin: true }, USER = { id: 'alice', admin: false };
let db, idp, h, r, svc, carrier, sink, pem, jwksSrv, jwksUrl;

/** A controllable carrier. `mode` decides what the NEXT mutating call does; `owned` is the carrier's real inventory. */
class StubCarrier {
  constructor() { this.owned = new Map(); this.n = 0; this.mode = 'ok'; this.name = 'stub'; this.configured = true; }
  fail(kind, status) { throw Object.assign(new Error(kind), { code: kind, providerStatus: status }); }
  async listAvailableNumbers(country) { return [{ e164: '+1415555' + String(2000 + ++this.n), locality: '', region: '', voice: true }]; }
  async provisionNumber({ e164 }) {
    const sid = 'PN' + randomBytes(12).toString('hex'), mode = this.mode; this.mode = 'ok';
    if (mode === 'ok') { this.owned.set(sid, e164); return { providerNumberId: sid, e164 }; }
    if (mode === 'timeout-after-effect') { this.owned.set(sid, e164); this.fail('PROVIDER_UNREACHABLE', 0); }
    if (mode === 'timeout-no-effect') this.fail('PROVIDER_UNREACHABLE', 0);
    this.fail('PROVIDER_REJECTED', 400);
  }
  async releaseNumber(sid) {
    const mode = this.mode; this.mode = 'ok';
    if (mode === 'ok') { this.owned.delete(sid); return { released: true }; }
    if (mode === 'timeout-after-effect') { this.owned.delete(sid); this.fail('PROVIDER_UNREACHABLE', 0); }
    if (mode === 'timeout-no-effect' || mode === '5xx') this.fail('PROVIDER_REJECTED', 503);
    if (mode === 'gone') { this.owned.delete(sid); this.fail('PROVIDER_REJECTED', 404); }
    this.fail('PROVIDER_REJECTED', 403);
  }
  async numberExists(sid) { if (this.down) this.fail('PROVIDER_UNREACHABLE', 0); return { exists: this.owned.has(sid) }; }
  async findOwnedByE164(e164) { if (this.down) this.fail('PROVIDER_UNREACHABLE', 0); const hit = [...this.owned].find(([, v]) => v === e164); return hit ? { providerNumberId: hit[0], e164 } : null; }
}

async function workload() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = { ...(await exportJWK(await importSPKI(publicKey.export({ type: 'spki', format: 'pem' }), 'ES256'))), kid: 'w1', alg: 'ES256', use: 'sig' };
  const srv = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); }); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), srv, url: 'http://127.0.0.1:' + srv.address().port + '/jwks.json' };
}
const wk = async (sub, method, path, body, o = {}) => { const res = await fetch(r.base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signWorkloadJwt({ privateKeyPem: pem, issuer: 'qorlla-workload', subject: sub, ...(o.jwt || {}) }) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => ({})) }; };
const q = (text, p) => db.pool.query(text, p);
const pump = async () => { let total = 0; for (let i = 0; i < 20; i++) { const x = await svc.deliverOutbox(sink); total += x.sent; if (!x.sent && !x.failed) break; await q("UPDATE qphone_number_outbox SET next_attempt_at=now() WHERE delivered_at IS NULL"); if (!x.sent) break; } return total; };
const account = (id, verified = true, suspended = false) => svc.syncAccount({ accountId: id, verified, suspended, orgId: 'orgA' });
/** Buys a number for `to` through the real workflow and returns its row (carrier, workflow, outbox untouched by the test). */
async function provision(to, kind = 'personal') {
  await account(to); const req = await svc.requestNumber(ADMIN, { country: 'US', kind, assignTo: to, idempotencyKey: 'k-' + randomUUID().slice(0, 12) }); assert.equal(await svc.runProvisioning(), 1);
  return (await q('SELECT * FROM qphone_numbers WHERE id = (SELECT number_id FROM qphone_provisioning_requests WHERE id=$1)', [req.id])).rows[0];
}
const ID = (n) => ({ id: n.id });

before(async () => {
  db = await isolatedDb(); if (!db) return; idp = await identityProvider(); const w = await workload(); pem = w.pem; jwksSrv = w.srv; jwksUrl = w.url;
  await q(sql('v4_14_telephony.sql')); await q(sql('v4_16_number_authority.sql')); await q(sql('v4_18_billing_hold.sql'));
  h = harness({ db, idp });
  r = await h.replica({ env: { SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_WORKLOAD_JWKS_URL: jwksUrl, SHIELD_WORKLOAD_ISSUER: 'qorlla-workload', SHIELD_WORKLOAD_ALLOWED: 'svc:numbers-plans=numbers.sync;svc:admin=shield.admin;svc:pstn=pstn.authorize|pstn.consume|pstn.settle;svc:other=guest.admit', SHIELD_PSTN_RESERVE_CENTS: '100' } });
  carrier = new StubCarrier(); svc = new TelephonyService({ db: db.pool, carrier, bridge: { ready: false }, audio: { ready: false }, env: { PHONE_ALLOWED_COUNTRIES: 'US,CA,GB' } });
  await q("INSERT INTO qphone_provider_status(provider, health_ok, health_checked_at) VALUES('stub', true, now())");
  sink = createEngineSink({ url: r.base, privateKeyPem: pem, issuer: 'qorlla-workload', kid: 'w1' });
  await wk('svc:admin', 'PUT', '/v1/shield/admin/orgs', { orgId: 'orgA', pstnEnabled: true, allowedCountries: ['US'], maxActiveCalls: 5, maxCallsHour: 100, spendLimitCents: 100000 });
});
after(async () => { if (h) await h.closeAll(); if (idp) await idp.close(); if (jwksSrv) await new Promise((ok) => jwksSrv.close(ok)); if (db) await db.drop(); });
const skip = (t) => !db && t.skip('no PostgreSQL reachable');
const principal = (accountId, verified = true) => wk('svc:admin', 'PUT', '/v1/shield/admin/principals', { accountId, orgId: 'orgA', verified });
const pstn = (accountId, callerId, destination = '+16502530000') => wk('svc:pstn', 'POST', '/v1/shield/pstn/authorize', { requestId: randomUUID(), accountId, destination, callerId });

test('A1 MIGRATION is non-destructive: existing duplicates are reported (not deleted), outbox snapshots are written, the uniqueness rule starts only once they are resolved, and re-running changes nothing', async (t) => {
  if (skip(t)) return;
  const schema = 'qv_mig_' + randomBytes(3).toString('hex'); await db.admin.query('CREATE SCHEMA ' + schema);
  const c = await db.admin.connect();
  try {
    await c.query('SET search_path TO ' + schema); await c.query(sql('v4_14_telephony.sql'));
    for (const [e, sid, who, kind] of [['+14155550001', 'PNaaaaaaaa01', 'dup', 'personal'], ['+14155550002', 'PNaaaaaaaa02', 'dup', 'personal'], ['+14155550003', 'PNaaaaaaaa03', 'solo', 'personal'], ['+14155550004', 'PNaaaaaaaa04', null, 'dialin']])
      await c.query("INSERT INTO qphone_numbers(e164, provider, provider_number_id, country, kind, assigned_to, state) VALUES($1,'twilio',$2,'US',$3,$4,'active')", [e, sid, kind, who]);
    await c.query(sql('v4_16_number_authority.sql'));
    assert.equal((await c.query('SELECT count(*)::int AS n FROM qphone_numbers')).rows[0].n, 4, 'no number deleted');
    assert.equal((await c.query("SELECT count(*)::int AS n FROM qphone_number_outbox WHERE type='number.snapshot'")).rows[0].n, 4, 'every existing number has a snapshot event');
    assert.deepEqual((await c.query('SELECT account_id, cardinality(number_ids) AS n FROM qphone_assignment_conflicts WHERE resolved_at IS NULL')).rows, [{ account_id: 'dup', n: 2 }], 'the duplicate is reported');
    assert.equal((await c.query("SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname=$1 AND indexname='qphone_one_live_personal'", [schema])).rows[0].n, 0, 'uniqueness NOT enforced while duplicates exist');
    await c.query(sql('v4_16_number_authority.sql')); assert.equal((await c.query('SELECT count(*)::int AS n FROM qphone_assignment_conflicts')).rows[0].n, 1, 're-running does not duplicate the report');
    assert.equal((await c.query("SELECT count(*)::int AS n FROM qphone_number_outbox")).rows[0].n, 4);
    // an operator resolves it by transferring one number; the conflict is closed; the rule is then enforced
    await c.query("UPDATE qphone_numbers SET assigned_to='other' WHERE provider_number_id='PNaaaaaaaa02'"); await c.query("UPDATE qphone_assignment_conflicts SET resolved_at=now(), resolution='transferred' WHERE resolved_at IS NULL");
    await c.query(sql('v4_16_number_authority.sql'));
    assert.equal((await c.query("SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname=$1 AND indexname='qphone_one_live_personal'", [schema])).rows[0].n, 1);
    await assert.rejects(c.query("UPDATE qphone_numbers SET assigned_to='dup' WHERE provider_number_id='PNaaaaaaaa03'"), /unique|duplicate/i);
    await assert.rejects(c.query("UPDATE qphone_numbers SET assigned_to='x' WHERE provider_number_id='PNaaaaaaaa04'"), /dial-in/);
    await assert.rejects(c.query("UPDATE qphone_numbers SET e164='+14155559999' WHERE provider_number_id='PNaaaaaaaa03'"), /immutable/);
  } finally { await c.query('SET search_path TO public').catch(() => {}); c.release(); await db.admin.query('DROP SCHEMA ' + schema + ' CASCADE'); }
});

test('A2 SYNC: Numbers & Plans is the only way a number reaches the engine; events are authenticated, validated, de-duplicated, ordered; the number is usable only when authority AND shield agree', async (t) => {
  if (skip(t)) return;
  await r.admin('POST', '/identities', { accountId: 'alice' });
  const n = await provision('alice');
  assert.equal(n.state, 'active'); assert.equal(Number(n.authority_version) >= 1, true);
  assert.equal((await q('SELECT count(*)::int AS c FROM voice_number_projection')).rows[0].c, 0, 'nothing reaches the engine until the outbox is delivered');
  // before delivery, before the shield knows the person: nothing is usable
  assert.equal(await pump() >= 1, true);
  const proj = (await q('SELECT * FROM voice_number_projection WHERE provider_number_id=$1', [n.provider_number_id])).rows[0]; assert.equal(proj.account_id, 'alice'); assert.equal(Number(proj.authority_version), Number(n.authority_version));
  assert.equal((await r.api('alice', 'GET', '/v1/voice/numbers/me')).status, 401, 'enforcement on and the shield has never heard of alice: refused');
  await principal('alice', false); const unv = await r.api('alice', 'GET', '/v1/voice/numbers/me'); assert.equal(unv.status, 200); assert.equal(unv.body.number, null); assert.equal(unv.body.state, 'unverified', 'an unverified account sees and uses no number');
  await principal('alice', true); const ok = await r.api('alice', 'GET', '/v1/voice/numbers/me'); assert.equal(ok.body.number.e164, n.e164);
  // transport safety
  const ev = { eventId: randomUUID(), providerNumberId: n.provider_number_id, version: Number(n.authority_version), type: 'number.changed', payload: { providerNumberId: n.provider_number_id, e164: n.e164, country: 'US', kind: 'personal', accountId: 'alice', state: 'active', callerIdVerified: false, hold: false, version: Number(n.authority_version) } };
  assert.equal((await fetch(r.base + '/v1/shield/numbers/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev) })).status, 401, 'no workload credential');
  assert.equal((await wk('svc:other', 'POST', '/v1/shield/numbers/events', ev)).status, 403, 'a workload without the numbers.sync scope');
  const jti = randomUUID() + randomUUID(); assert.equal((await wk('svc:numbers-plans', 'POST', '/v1/shield/numbers/status', {}, { jwt: { subject: 'svc:numbers-plans' } })).status, 200);
  assert.equal((await wk('svc:numbers-plans', 'POST', '/v1/shield/numbers/events', { ...ev, payload: { ...ev.payload, version: 99 } })).body.error, 'payload_mismatch', 'a payload cannot describe another version than its envelope');
  assert.equal((await wk('svc:numbers-plans', 'POST', '/v1/shield/numbers/events', { ...ev, payload: { ...ev.payload, kind: 'dialin' } })).body.error, 'dialin_cannot_be_assigned');
  assert.equal((await wk('svc:numbers-plans', 'POST', '/v1/shield/numbers/events', { ...ev, providerNumberId: 'short' })).status, 400);
  // replay / stale / gap
  const dupe = await wk('svc:numbers-plans', 'POST', '/v1/shield/numbers/events', { ...ev, eventId: randomUUID() }); assert.equal(dupe.body.result, 'stale', 'the same version again under a new id is stale');
  const first = (await q('SELECT event_id FROM voice_number_events WHERE provider_number_id=$1 ORDER BY version LIMIT 1', [n.provider_number_id])).rows[0].event_id;
  assert.equal((await wk('svc:numbers-plans', 'POST', '/v1/shield/numbers/events', { ...ev, eventId: first })).body.result, 'duplicate', 'a redelivered event id is a duplicate');
  const next = Number(n.authority_version) + 2, jump = { ...ev, eventId: randomUUID(), version: next, payload: { ...ev.payload, version: next, state: 'suspended' } };
  const gap = await wk('svc:numbers-plans', 'POST', '/v1/shield/numbers/events', jump); assert.equal(gap.status, 409); assert.equal(gap.body.result, 'gap'); assert.equal(gap.body.expected, Number(n.authority_version) + 1);
  assert.equal((await q('SELECT state FROM voice_number_projection WHERE provider_number_id=$1', [n.provider_number_id])).rows[0].state, 'active', 'a gap changes nothing');
  assert.equal((await q('SELECT count(*)::int AS c FROM voice_number_gaps WHERE resolved_at IS NULL')).rows[0].c, 1);
  // the real authority moves through the versions in order: the outbox heals the gap by delivering the missing version first
  await svc.setNumberState(ADMIN, n.id, 'suspended'); await svc.setNumberState(ADMIN, n.id, 'active'); await pump();
  assert.equal(Number((await q('SELECT authority_version FROM voice_number_projection WHERE provider_number_id=$1', [n.provider_number_id])).rows[0].authority_version), Number((await q('SELECT authority_version FROM qphone_numbers WHERE id=$1', [n.id])).rows[0].authority_version));
  assert.equal((await q('SELECT count(*)::int AS c FROM voice_number_gaps WHERE resolved_at IS NULL')).rows[0].c, 0, 'gap resolved');
});

test('OUTBOX: at least once, head-of-line per number, retried with backoff; a failing consumer never lets version N+1 overtake N', async (t) => {
  if (skip(t)) return;
  await account('olivia'); await principal('olivia'); await r.admin('POST', '/identities', { accountId: 'olivia' });
  const n = await provision('olivia'); await pump();
  await svc.setNumberState(ADMIN, n.id, 'suspended'); await svc.setNumberState(ADMIN, n.id, 'active');
  const seen = []; let failNext = true;
  const flaky = async (e) => { if (e.providerNumberId === n.provider_number_id) { seen.push(e.version); if (failNext) { failNext = false; throw new Error('consumer down'); } } return sink(e); };
  const a = await svc.deliverOutbox(flaky); assert.equal(a.failed >= 1, true);
  const pend = (await q('SELECT version, attempts, delivered_at FROM qphone_number_outbox WHERE provider_number_id=$1 AND delivered_at IS NULL ORDER BY version', [n.provider_number_id])).rows;
  assert.equal(pend.length, 2, 'both later versions still wait'); assert.equal(pend[0].attempts, 1);
  await svc.deliverOutbox(flaky); assert.equal((await q('SELECT count(*)::int AS c FROM qphone_number_outbox WHERE provider_number_id=$1 AND delivered_at IS NULL', [n.provider_number_id])).rows[0].c, 2, 'backoff: this number is not retried before next_attempt_at');
  await q('UPDATE qphone_number_outbox SET next_attempt_at=now()'); await svc.deliverOutbox(flaky); await svc.deliverOutbox(flaky);   // strictly one version per number per pass: v3 only becomes eligible once v2 is delivered
  assert.deepEqual(seen, [...seen].sort((x, y) => x - y), 'versions were offered in order');
  assert.equal((await q('SELECT count(*)::int AS c FROM qphone_number_outbox WHERE provider_number_id=$1 AND delivered_at IS NULL', [n.provider_number_id])).rows[0].c, 0);
  assert.equal((await q('SELECT authority_version FROM voice_number_projection WHERE provider_number_id=$1', [n.provider_number_id])).rows[0].authority_version, (await q('SELECT authority_version FROM qphone_numbers WHERE id=$1', [n.id])).rows[0].authority_version);
  // two dispatchers at once: one wins, the other is told it is busy (no double delivery storm)
  await svc.setNumberState(ADMIN, n.id, 'suspended'); await svc.setNumberState(ADMIN, n.id, 'active');
  const both = await Promise.all([svc.deliverOutbox(sink), svc.deliverOutbox(sink)]); assert.equal(both.filter((x) => x.busy).length <= 1, true); await pump();
});

test('DUPLICATE OWNERSHIP + UNAUTHORIZED REASSIGNMENT: one live personal number per account; transfers need an administrator, a reason, a verified active target, a movable number; dial-in numbers are never personal', async (t) => {
  if (skip(t)) return;
  for (const a of ['dora', 'ed', 'frank']) { await account(a); await principal(a); await r.admin('POST', '/identities', { accountId: a }); }
  const dora = await provision('dora');
  await assert.rejects(svc.requestNumber(ADMIN, { country: 'US', assignTo: 'dora', idempotencyKey: 'dup-' + randomUUID().slice(0, 8) }), (e) => e.code === 'DUPLICATE_OWNERSHIP');
  await assert.rejects(svc.requestNumber(ADMIN, { country: 'US', assignTo: 'nobody-known', idempotencyKey: 'unk-' + randomUUID().slice(0, 8) }), (e) => e.code === 'TARGET_NOT_ELIGIBLE');
  const ed = await provision('ed');
  await assert.rejects(svc.reassignNumber(ADMIN, ed.id, 'dora', 'fixing a mistake'), (e) => e.code === 'DUPLICATE_OWNERSHIP', 'target already owns a number');
  await assert.rejects(svc.reassignNumber(USER, ed.id, 'frank', 'I want it'), (e) => e.code === 'FORBIDDEN', 'not an administrator');
  await assert.rejects(svc.reassignNumber(ADMIN, ed.id, 'frank', ''), (e) => e.code === 'REASON_REQUIRED');
  await assert.rejects(svc.reassignNumber(ADMIN, ed.id, 'stranger', 'because'), (e) => e.code === 'TARGET_NOT_ELIGIBLE', 'unknown target'); await account('gus', false); await assert.rejects(svc.reassignNumber(ADMIN, ed.id, 'gus', 'because'), (e) => e.code === 'TARGET_NOT_ELIGIBLE', 'unverified target');
  await account('hana', true, true); await assert.rejects(svc.reassignNumber(ADMIN, ed.id, 'hana', 'because'), (e) => e.code === 'TARGET_NOT_ELIGIBLE', 'suspended target');
  await svc.requestNumber(ADMIN, { country: 'US', kind: 'dialin', idempotencyKey: 'dial-' + randomUUID().slice(0, 8) }); await svc.runProvisioning();
  const dialin = (await q("SELECT * FROM qphone_numbers WHERE kind='dialin' LIMIT 1")).rows[0]; assert.ok(dialin);
  await assert.rejects(svc.reassignNumber(ADMIN, dialin.id, 'frank', 'because'), (e) => e.code === 'NOT_TRANSFERABLE');
  await assert.rejects(q('UPDATE qphone_numbers SET assigned_to=$2 WHERE id=$1', [dialin.id, 'frank']), /dial-in/, 'the database refuses it too');
  await assert.rejects(q("UPDATE qphone_numbers SET assigned_to='dora' WHERE id=$1", [ed.id]), /unique|duplicate/i, 'and the database is the final backstop against two live numbers');
  // the legitimate transfer: audited, caller ID verification reset, new version, engine follows
  await pump(); const before = Number((await q('SELECT authority_version FROM qphone_numbers WHERE id=$1', [ed.id])).rows[0].authority_version);
  await q("UPDATE qphone_numbers SET caller_id_verified=true WHERE id=$1", [ed.id]);
  const moved = await svc.reassignNumber(ADMIN, ed.id, 'frank', 'employee left the company'); assert.equal(moved.callerIdVerified, false);
  const row = (await q('SELECT * FROM qphone_numbers WHERE id=$1', [ed.id])).rows[0]; assert.equal(row.assigned_to, 'frank'); assert.equal(Number(row.authority_version) > before, true);
  assert.deepEqual((await q("SELECT detail FROM qphone_audit WHERE action='number.reassigned' AND subject=$1", [ed.id])).rows[0].detail.to, 'frank');
  await pump(); assert.equal((await q('SELECT account_id FROM voice_number_projection WHERE provider_number_id=$1', [ed.provider_number_id])).rows[0].account_id, 'frank');
  assert.equal((await r.api('ed', 'GET', '/v1/voice/numbers/me')).body.number, null, 'the previous owner no longer has it');
  // the engine refuses to project a second live number for one account even if the authority were wrong
  const sid = 'PN' + randomBytes(10).toString('hex'), bad = { providerNumberId: sid, e164: '+14155557777', country: 'US', kind: 'personal', accountId: 'dora', state: 'active', callerIdVerified: true, hold: false, version: 1 };
  assert.equal((await wk('svc:numbers-plans', 'POST', '/v1/shield/numbers/events', { eventId: randomUUID(), providerNumberId: sid, version: 1, type: 'number.changed', payload: bad })).body.result, 'conflict');
  assert.equal((await q('SELECT conflict FROM voice_number_projection WHERE provider_number_id=$1', [sid])).rows[0].conflict, true); assert.equal((await r.api('dora', 'GET', '/v1/voice/numbers/me')).body.number.e164, dora.e164, 'her real number is unaffected');
  assert.equal((await pstn('dora', '+14155557777')).body.reason, 'CALLER_ID_NOT_OWNED', 'a conflicting projection is never a valid caller ID');
});

test('RELEASE CRASH WINDOW: intent is durable before the carrier is called; a timeout never means "did not happen": the number is locked, reconciled against the carrier, and only then released, reverted or reused', async (t) => {
  if (skip(t)) return;
  for (const a of ['rita', 'sam', 'tess', 'uma', 'vic']) { await account(a); await principal(a); await r.admin('POST', '/identities', { accountId: a }); }
  const num = async (a) => { const n = await provision(a); await q('UPDATE qphone_numbers SET caller_id_verified=true WHERE id=$1', [n.id]); await pump(); return n; };
  // 1. timeout AFTER the carrier released it
  let n = await num('rita'); carrier.mode = 'timeout-after-effect';
  let out = await svc.releaseNumber(ADMIN, n.id); assert.equal(out.outcome, 'uncertain'); let row = (await q('SELECT * FROM qphone_numbers WHERE id=$1', [n.id])).rows[0];
  assert.equal(row.state, 'releasing'); assert.equal(row.hold_reason, 'release_outcome_uncertain');
  assert.equal((await q("SELECT state FROM qphone_provider_operations WHERE kind='release' AND number_id=$1", [n.id])).rows[0].state, 'uncertain');
  await assert.rejects(svc.reassignNumber(ADMIN, n.id, 'sam', 'reuse it'), (e) => e.code === 'NUMBER_LOCKED', 'no reassignment while the outcome is unknown');
  await assert.rejects(svc.releaseNumber(ADMIN, n.id), (e) => e.code === 'OUTCOME_UNCERTAIN', 'no blind retry');
  await assert.rejects(svc.setNumberState(ADMIN, n.id, 'active'), (e) => e.code === 'NUMBER_LOCKED');
  await assert.rejects(q("UPDATE qphone_numbers SET assigned_to='sam' WHERE id=$1", [n.id]), /locked/, 'the database refuses reuse of a locked number');
  await pump(); assert.equal((await pstn('rita', n.e164)).body.reason, 'CALLER_ID_NOT_OWNED', 'a held number is not a valid caller ID in the engine');
  carrier.down = true; assert.equal((await svc.reconcileOperations()).unresolved, 1, 'carrier cannot be asked: NOTHING changes'); assert.equal((await q('SELECT state FROM qphone_numbers WHERE id=$1', [n.id])).rows[0].state, 'releasing'); carrier.down = false;
  assert.equal((await svc.reconcileOperations()).confirmed, 1); row = (await q('SELECT * FROM qphone_numbers WHERE id=$1', [n.id])).rows[0]; assert.equal(row.state, 'released'); assert.equal(row.hold_reason, null);
  await pump(); assert.equal((await q('SELECT state FROM voice_number_projection WHERE provider_number_id=$1', [n.provider_number_id])).rows[0].state, 'released');
  await assert.rejects(q("UPDATE qphone_numbers SET state='active' WHERE id=$1", [n.id]), /final/, 'a released number is final');
  // 2. timeout where the carrier did NOT release it
  n = await num('sam'); carrier.mode = 'timeout-no-effect'; out = await svc.releaseNumber(ADMIN, n.id); assert.equal(out.outcome, 'uncertain'); assert.equal((await svc.reconcileOperations()).reverted, 1);
  row = (await q('SELECT * FROM qphone_numbers WHERE id=$1', [n.id])).rows[0]; assert.equal(row.state, 'active'); assert.equal(row.hold_reason, null); assert.equal((await q('SELECT state FROM qphone_provider_operations WHERE kind=\'release\' AND number_id=$1 ORDER BY created_at DESC', [n.id])).rows[0].state, 'failed');
  // 3. a definitive refusal (403): known not to have happened, reverted at once, retry allowed
  carrier.mode = 'refuse'; out = await svc.releaseNumber(ADMIN, n.id); assert.equal(out.outcome, 'failed'); assert.equal((await q('SELECT state FROM qphone_numbers WHERE id=$1', [n.id])).rows[0].state, 'active');
  // 4. a 5xx is NOT a refusal
  carrier.mode = '5xx'; out = await svc.releaseNumber(ADMIN, n.id); assert.equal(out.outcome, 'uncertain'); await svc.reconcileOperations();
  // 5. 404: the carrier says it is already gone => confirmed
  n = await num('tess'); carrier.mode = 'gone'; out = await svc.releaseNumber(ADMIN, n.id); assert.equal(out.outcome, 'confirmed'); assert.equal((await q('SELECT state FROM qphone_numbers WHERE id=$1', [n.id])).rows[0].state, 'released');
  // 6. a process that died after step 1: the operation is 'in_flight' with no outcome; once stale, reconcile asks the carrier
  n = await num('uma'); await q("UPDATE qphone_numbers SET state='releasing', state_before_release='active' WHERE id=$1", [n.id]);
  await q("INSERT INTO qphone_provider_operations(kind, state, number_id, provider_number_id, e164, attempts, updated_at) VALUES('release','in_flight',$1,$2,$3,1, now() - interval '10 minutes')", [n.id, n.provider_number_id, n.e164]);
  carrier.owned.delete(n.provider_number_id); assert.equal((await svc.reconcileOperations()).confirmed, 1); assert.equal((await q('SELECT state FROM qphone_numbers WHERE id=$1', [n.id])).rows[0].state, 'released');
  // classification rules
  assert.equal(classifyProviderError({ providerStatus: 0 }, 'release'), 'uncertain'); assert.equal(classifyProviderError({}, 'release'), 'uncertain'); assert.equal(classifyProviderError({ providerStatus: 408 }, 'release'), 'uncertain');
  assert.equal(classifyProviderError({ providerStatus: 400 }, 'provision'), 'failed'); assert.equal(classifyProviderError({ providerStatus: 404 }, 'provision'), 'uncertain');
});

test('PROVISIONING uncertainty: a purchase whose answer was lost is recorded by reconciliation (never lost, never double-assigned); a purchase that did not happen is closed', async (t) => {
  if (skip(t)) return;
  for (const a of ['walt', 'xena']) { await account(a); await principal(a); }
  await account('walt'); const req = await svc.requestNumber(ADMIN, { country: 'US', assignTo: 'walt', idempotencyKey: 'u-' + randomUUID().slice(0, 8) });
  carrier.mode = 'timeout-after-effect'; await svc.runProvisioning();
  assert.equal((await q('SELECT count(*)::int AS c FROM qphone_numbers WHERE assigned_to=$1', ['walt'])).rows[0].c, 0, 'not recorded yet'); assert.equal((await q('SELECT error_code FROM qphone_provisioning_requests WHERE id=$1', [req.id])).rows[0].error_code, 'PROVIDER_OUTCOME_UNCERTAIN');
  assert.equal((await q("SELECT state FROM qphone_provider_operations WHERE request_id=$1", [req.id])).rows[0].state, 'uncertain');
  await assert.rejects(svc.requestNumber(ADMIN, { country: 'US', assignTo: 'walt', idempotencyKey: 'again-' + randomUUID().slice(0, 8) }), (e) => e.code === 'DUPLICATE_OWNERSHIP', 'no second purchase while the first is unresolved');
  assert.equal((await svc.reconcileOperations()).recorded, 1); const got = (await q('SELECT * FROM qphone_numbers WHERE assigned_to=$1', ['walt'])).rows[0]; assert.ok(got && got.state === 'active'); assert.equal((await q('SELECT state FROM qphone_provisioning_requests WHERE id=$1', [req.id])).rows[0].state, 'provisioned');
  await pump(); assert.equal((await q('SELECT account_id FROM voice_number_projection WHERE provider_number_id=$1', [got.provider_number_id])).rows[0].account_id, 'walt');
  await account('xena'); const r2 = await svc.requestNumber(ADMIN, { country: 'US', assignTo: 'xena', idempotencyKey: 'v-' + randomUUID().slice(0, 8) }); carrier.mode = 'timeout-no-effect'; await svc.runProvisioning();
  assert.equal((await svc.reconcileOperations()).reverted, 1); assert.equal((await q('SELECT state, error_code FROM qphone_provisioning_requests WHERE id=$1', [r2.id])).rows[0].error_code, 'NOT_PURCHASED');
});

test('CALLER-ID SPOOFING, SUSPENSION AND TENANT ISOLATION across the integrated services', async (t) => {
  if (skip(t)) return;
  for (const a of ['yan', 'zed']) { await account(a); await principal(a); await r.admin('POST', '/identities', { accountId: a }); }
  const yan = await provision('yan'), zed = await provision('zed'); await pump();
  assert.equal((await pstn('yan', yan.e164)).body.reason, 'CALLER_ID_NOT_OWNED', 'a number whose caller ID was never verified is refused');
  await svc.setCallerIdVerified(ADMIN, yan.id, true); await svc.setCallerIdVerified(ADMIN, zed.id, true); await pump();
  const ok = await pstn('yan', yan.e164); assert.equal(ok.body.allow, true, JSON.stringify(ok.body));
  assert.equal((await pstn('yan', zed.e164)).body.reason, 'CALLER_ID_NOT_OWNED', "someone else's number");
  assert.equal((await pstn('yan', '+14155550999')).body.reason, 'CALLER_ID_NOT_OWNED', 'a number the carrier never gave us');
  const dialin = (await q("SELECT * FROM qphone_numbers WHERE kind='dialin' LIMIT 1")).rows[0]; assert.equal((await pstn('yan', dialin.e164)).body.reason, 'CALLER_ID_NOT_OWNED', 'a shared dial-in number is never a personal caller ID');
  await assert.rejects(svc.setCallerIdVerified(ADMIN, dialin.id, true), (e) => e.code === 'NOT_ELIGIBLE');
  await account('zed', true, true); await assert.rejects(svc.setCallerIdVerified(ADMIN, zed.id, true), (e) => e.code === 'OWNER_NOT_ELIGIBLE', 'a suspended owner cannot get a verified caller ID');
  // unverified in the shield: protected features refused even with a perfect number
  await principal('zed', false); assert.equal((await pstn('zed', zed.e164)).body.reason, 'IDENTITY_UNVERIFIED'); await principal('zed', true);
  // emergency suspension during an active PSTN call: the gateway is told to hang up, the number is no longer usable, the outcome is recorded
  const live = (await pstn('yan', yan.e164)).body; assert.equal((await wk('svc:pstn', 'POST', '/v1/shield/pstn/consume', { authorizationId: live.authorizationId, accountId: 'yan', destination: '+16502530000', callerId: yan.e164 })).body.valid, true);
  const sus = await wk('svc:admin', 'POST', '/v1/shield/admin/principals/yan/suspend', {}); assert.deepEqual(sus.body.terminate, [live.authorizationId]);
  assert.deepEqual((await wk('svc:pstn', 'POST', '/v1/shield/pstn/terminations', {})).body.terminate, [live.authorizationId]);
  assert.equal((await wk('svc:pstn', 'POST', '/v1/shield/pstn/settle', { authorizationId: live.authorizationId, actualCents: 7 })).body.settled, true, 'the gateway reports the terminated call');
  assert.equal((await q("SELECT state, actual_cents FROM shield_authorizations WHERE id=$1", [live.authorizationId])).rows[0].state, 'ended');
  assert.ok((await q("SELECT 1 FROM shield_events WHERE action='principal.suspend' AND actor='yan'")).rowCount >= 1, 'recorded');
  assert.equal((await pstn('yan', yan.e164)).body.reason, 'SUSPENDED');
  // tenant isolation: another organization's workload-registered principal cannot use or see this number
  await wk('svc:admin', 'PUT', '/v1/shield/admin/orgs', { orgId: 'orgB', pstnEnabled: true, allowedCountries: ['US'], maxActiveCalls: 2, maxCallsHour: 10, spendLimitCents: 1000 }); await wk('svc:admin', 'PUT', '/v1/shield/admin/principals', { accountId: 'mal', orgId: 'orgB', verified: true });
  assert.equal((await pstn('mal', zed.e164)).body.reason, 'CALLER_ID_NOT_OWNED'); await r.admin('POST', '/identities', { accountId: 'mal' }); assert.equal((await r.api('mal', 'GET', '/v1/voice/numbers/me')).body.number, null);
});

test('PROVENANCE: a structurally valid number event from a workload that is not the Numbers & Plans authority is refused, even with the numbers.sync scope', async (t) => {
  if (skip(t)) return;
  // svc:other is a perfectly valid workload; give it the scope in a second engine and watch it be refused anyway
  const r2 = await h.replica({ env: { SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_WORKLOAD_JWKS_URL: jwksUrl, SHIELD_WORKLOAD_ISSUER: 'qorlla-workload', SHIELD_WORKLOAD_ALLOWED: 'svc:numbers-plans=numbers.sync;svc:rogue=numbers.sync' } });
  const sid = 'PN' + randomBytes(10).toString('hex'), ev = { providerNumberId: sid, e164: '+14155557001', country: 'US', kind: 'personal', accountId: 'rogue-target', state: 'active', callerIdVerified: true, hold: false, version: 1 };
  const send = (sub, path = '/v1/shield/numbers/events', body = { eventId: randomUUID(), providerNumberId: sid, version: 1, type: 'number.changed', payload: ev }) => fetch(r2.base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signWorkloadJwt({ privateKeyPem: pem, issuer: 'qorlla-workload', subject: sub, kid: 'w1' }) }, body: JSON.stringify(body) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => ({})) }));
  const bad = await send('svc:rogue'); assert.equal(bad.status, 403); assert.equal(bad.body.error, 'event_provenance');
  assert.equal((await send('svc:rogue', '/v1/shield/numbers/reconcile', { numbers: [{ ...ev, version: 1 }] })).status, 403, 'and a forged full snapshot');
  assert.equal((await q('SELECT count(*)::int AS c FROM voice_number_projection WHERE provider_number_id=$1', [sid])).rows[0].c, 0, 'nothing was written');
  assert.ok((await q("SELECT 1 FROM shield_events WHERE action='numbers.sync' AND decision='DENY' AND reason='number_event_wrong_origin' AND actor='svc:rogue'")).rowCount, 'and the attempt is recorded');
  assert.equal((await send('svc:numbers-plans')).body.result, 'applied', 'the real authority is accepted');
});

test('BILLING HOLD: a held or delinquent account cannot receive, lose or verify a number, and cannot authorize PSTN calls; lifting the hold restores them', async (t) => {
  if (skip(t)) return;
  for (const a of ['hank', 'hilda', 'hugo']) { await account(a); await principal(a); await r.admin('POST', '/identities', { accountId: a }); }
  const hank = await provision('hank'); await svc.setCallerIdVerified(ADMIN, hank.id, true); await pump();
  assert.equal((await pstn('hank', hank.e164)).body.allow, true, 'in good standing');
  await svc.syncAccount({ accountId: 'hank', verified: true, suspended: false, billingHold: true }); await wk('svc:admin', 'PUT', '/v1/shield/admin/principals', { accountId: 'hank', billingHold: true });
  assert.equal((await pstn('hank', hank.e164)).body.reason, 'BILLING_HOLD', 'the engine refuses PSTN for a held account');
  await assert.rejects(svc.reassignNumber(ADMIN, hank.id, 'hilda', 'moving the number'), (e) => e.code === 'BILLING_HOLD', 'cannot move a held owner\'s number away');
  await assert.rejects(svc.setCallerIdVerified(ADMIN, hank.id, true), (e) => e.code === 'BILLING_HOLD');
  const hilda = await provision('hilda'); await svc.syncAccount({ accountId: 'hugo', verified: true, suspended: false, billingHold: true });
  await assert.rejects(svc.requestNumber(ADMIN, { country: 'US', assignTo: 'hugo', idempotencyKey: 'hold-' + randomUUID().slice(0, 8) }), (e) => e.code === 'BILLING_HOLD', 'a held account cannot be given a number');
  await assert.rejects(svc.reassignNumber(ADMIN, hilda.id, 'hugo', 'moving the number'), (e) => e.code === 'BILLING_HOLD', 'nor receive a transfer');
  await svc.syncAccount({ accountId: 'hank', verified: true, suspended: false }); assert.equal((await q("SELECT billing_hold FROM qphone_accounts WHERE account_id='hank'")).rows[0].billing_hold, true, 'a sync that does not mention billing leaves the hold in place');
  await svc.syncAccount({ accountId: 'hank', verified: true, suspended: false, billingHold: false }); await wk('svc:admin', 'PUT', '/v1/shield/admin/principals', { accountId: 'hank', billingHold: false });
  assert.equal((await pstn('hank', hank.e164)).body.allow, true, 'hold lifted');
  await svc.syncAccount({ accountId: 'hugo', verified: true, suspended: false, billingHold: false }); const moved = await svc.reassignNumber(ADMIN, hank.id, 'hugo', 'hugo took over'); assert.equal(moved.assignedTo, 'hugo');
});

test('RECONCILIATION: a snapshot heals lost events, makes numbers the authority no longer lists unusable, never moves the projection backwards, and reports disagreement at the same version', async (t) => {
  if (skip(t)) return;
  await account('rex'); await principal('rex'); await r.admin('POST', '/identities', { accountId: 'rex' });
  const n = await provision('rex'); await q('UPDATE qphone_numbers SET caller_id_verified=true WHERE id=$1', [n.id]);                       // events never delivered: the engine knows nothing
  assert.equal((await q('SELECT count(*)::int AS c FROM voice_number_projection WHERE provider_number_id=$1', [n.provider_number_id])).rows[0].c, 0);
  let snap = await svc.numberSnapshot(); const rec = await sink.reconcile(snap); assert.equal(rec.applied >= 1, true);
  assert.equal((await q('SELECT caller_id_verified FROM voice_number_projection WHERE provider_number_id=$1', [n.provider_number_id])).rows[0].caller_id_verified, true);
  // a row the authority does not list is quarantined
  await q("INSERT INTO voice_number_projection(provider_number_id, e164, kind, account_id, state, authority_version) VALUES('PNorphan0001','+14155558888','personal','ghosty','active',1)");
  snap = await svc.numberSnapshot(); const rec2 = await sink.reconcile(snap); assert.ok(rec2.orphans.includes('PNorphan0001')); assert.equal((await q("SELECT stale FROM voice_number_projection WHERE provider_number_id='PNorphan0001'")).rows[0].stale, true);
  // disagreement at the same version is reported, not silently overwritten
  await q("UPDATE voice_number_projection SET state='suspended' WHERE provider_number_id=$1", [n.provider_number_id]); const rec3 = await sink.reconcile(await svc.numberSnapshot()); assert.ok(rec3.mismatched.includes(n.provider_number_id));
  // an older snapshot never moves the projection backwards
  await q("UPDATE voice_number_projection SET authority_version = authority_version + 5, state='active' WHERE provider_number_id=$1", [n.provider_number_id]); const rec4 = await sink.reconcile(await svc.numberSnapshot()); assert.ok(rec4.mismatched.includes(n.provider_number_id), 'projection ahead of the authority is reported');
  assert.equal((await wk('svc:numbers-plans', 'POST', '/v1/shield/numbers/status', {})).body.stale >= 1, true);
});

test('AUDIT INTEGRITY: Numbers & Plans audit is append-only (UPDATE, DELETE, TRUNCATE) and the application role cannot change it, truncate anything, or delete numbers', async (t) => {
  if (skip(t)) return;
  assert.ok((await q('SELECT count(*)::int AS c FROM qphone_audit')).rows[0].c > 5);
  for (const stmt of ["UPDATE qphone_audit SET action='x'", 'DELETE FROM qphone_audit', 'TRUNCATE qphone_audit']) await assert.rejects(q(stmt), /append-only/);
  const role = 'qv_np_' + randomBytes(4).toString('hex'); await db.admin.query(`CREATE ROLE ${role} NOLOGIN`);
  const ac = await db.admin.connect();
  try {
    const s = db.schema, block = sql('005_app_role.sql').split('-- Numbers & Plans authority (v4.16)')[1].replace(/^[^\n]*\n/, '').replaceAll('public.', s + '.').replaceAll('qorlla_meet_app', role);
    await ac.query(`GRANT USAGE ON SCHEMA ${s} TO ${role}; GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA ${s} TO ${role}`);
    await ac.query(`SET search_path TO ${s}`); await ac.query(block);
    const has = async (table, priv) => (await ac.query('SELECT has_table_privilege($1, $2, $3) AS ok', [role, s + '.' + table, priv])).rows[0].ok;
    for (const p of ['UPDATE', 'DELETE', 'TRUNCATE']) assert.equal(await has('qphone_audit', p), false, 'audit ' + p); assert.equal(await has('qphone_audit', 'INSERT'), true);
    for (const t2 of ['qphone_numbers', 'qphone_number_outbox', 'qphone_provider_operations']) { assert.equal(await has(t2, 'DELETE'), false, t2 + ' DELETE'); assert.equal(await has(t2, 'TRUNCATE'), false, t2 + ' TRUNCATE'); }
    assert.equal(await has('qphone_number_outbox', 'UPDATE'), true, 'marking events delivered is still possible');
  } finally { await ac.query('SET search_path TO public').catch(() => {}); ac.release(); await db.admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`).catch(() => {}); }
});
