import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto, { generateKeyPairSync } from 'node:crypto';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, here } from './helpers.mjs';
import { createSbacs } from '../server/sbacs.mjs';
import { createSbacsClient } from '../../qorlla-meet-video/server/sbacs-client.mjs';
import { createEnforcement } from '../../qorlla-meet-video/server/sbacs-enforce.mjs';

// Meet's REAL client and enforcement code against the REAL portal API and PostgreSQL (the two services live in separate packages; this is the contract test between them).
// A stoppable proxy stands in for the network so outages and recovery are real connection failures, not mocks.
const MIB = 1024 * 1024;
const NAMES = ['meet', 'storage'];
const ID = Object.fromEntries(NAMES.map((n) => [n, generateKeyPairSync('ed25519')]));
const PUB = NAMES.map((n) => `${n}=${ID[n].publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`).join(',');
const pem = (n) => ID[n].privateKey.export({ type: 'pkcs8', format: 'pem' });

function proxy(targetBase) {
  let server = null, port = 0;
  const handler = (req, res) => { const pr = http.request(new URL(req.url, targetBase), { method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); pr.on('error', () => { res.statusCode = 502; res.end(); }); req.pipe(pr); };
  const start = () => new Promise((resolve) => { server = http.createServer(handler); server.listen(port, '127.0.0.1', () => { port = server.address().port; resolve(); }); });
  const stop = () => new Promise((resolve) => { if (!server) return resolve(); server.closeAllConnections?.(); server.close(() => resolve()); server = null; });
  return { start, stop, get url() { return `http://127.0.0.1:${port}`; } };
}

describe('Meet <-> SBACS: service client, enforcement points and failure behaviour', () => {
  let pdb, mdb, main, app, px, sbacs, uPro, uFree, WPro, WFree;
  const logs = [];
  const log = (lvl, msg, o) => logs.push({ lvl, msg, ...o });
  const sql = (q, a) => pdb.pool.query(q, a);
  const msql = (q, a) => mdb.pool.query(q, a);
  const mkClients = (over = {}) => ({
    meetClient: createSbacsClient({ mode: 'enforce', baseUrl: px.url, service: 'meet', privateKeyPem: pem('meet'), log, timeoutMs: 1500, ...over }),
    storageClient: createSbacsClient({ mode: 'enforce', baseUrl: px.url, service: 'storage', privateKeyPem: pem('storage'), log, timeoutMs: 1500, ...over })
  });
  const mkEnf = (over = {}, cl = mkClients(over)) => createEnforcement({ mode: over.mode || 'enforce', db: mdb.pool, ...cl, graceMib: over.graceMib ?? 4, log });
  const meeting = async (account) => (await msql('INSERT INTO meetings(host_account_id) VALUES($1) RETURNING id', [account])).rows[0].id;
  const usedOf = async (ws, f) => (await sql(`SELECT used::int, reserved::int FROM portal.subscription_usage WHERE workspace_id=$1 AND feature=$2`, [ws, f])).rows[0] || { used: 0, reserved: 0 };
  const ceiling = (ws, f, q) => sql(`INSERT INTO portal.entitlement_overrides(workspace_id,feature,enabled,quota,reason,created_by) VALUES($1,$2,true,$3,'test ceiling',$4) ON CONFLICT (workspace_id,feature) DO UPDATE SET quota=$3, enabled=true`, [ws, f, q, crypto.randomUUID()]);

  before(async () => {
    pdb = await freshDatabase(); main = await startMainStandIn(); sbacs = createSbacs({ pool: pdb.pool });
    app = await startApp({ pool: pdb.pool, cfg: testConfig({ env: { SBACS_SERVICE_PUBLIC_KEYS: PUB } }, main), jwks: main.jwks });
    px = proxy(app.base); await px.start();
    mdb = await freshDatabase({ migrate: false });
    await msql('CREATE TABLE meetings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), host_account_id text)'); await msql(fs.readFileSync(path.join(here, '..', '..', 'qorlla-meet-video', 'sql', 'v4_23_sbacs_outbox.sql'), 'utf8'));
    uPro = await main.mint(); uFree = await main.mint(); WPro = await seedWorkspace(pdb.pool, uPro.sub, 'Pro'); WFree = await seedWorkspace(pdb.pool, uFree.sub, 'Free');
    await sql(`UPDATE portal.subscriptions SET plan_slug='pro',status='active',billing_interval='month',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [WPro]);
  });
  after(async () => { await px.stop(); await app.close(); await main.close(); await mdb.drop(); await pdb.drop(); });

  test('modes: off never calls; shadow calls but never refuses; enforce refuses, tells quota from denial, and a bad configuration stops the service at start-up', async () => {
    const calls = []; const spy = (url, init) => { calls.push(url); return fetch(url, init); };
    const off = createSbacsClient({ mode: 'off', fetchImpl: spy }); assert.deepEqual(await off.check({ accountId: 'x', feature: 'meet.recording' }), { ok: true, skipped: 'off' }); assert.equal(calls.length, 0);
    const base = { baseUrl: px.url, service: 'meet', privateKeyPem: pem('meet'), log, fetchImpl: spy };
    const shadow = createSbacsClient({ ...base, mode: 'shadow' }); const s = await shadow.check({ accountId: 'u_' + uFree.sub, feature: 'meet.recording' });
    assert.equal(s.ok, true); assert.equal(s.shadow.ok, false); assert.equal(s.shadow.reason, 'not_in_plan'); assert.equal(calls.length, 1); assert.ok(logs.some((l) => l.msg === 'sbacs.shadow' && l.reason === 'not_in_plan'));
    const enf = createSbacsClient({ ...base, mode: 'enforce' });
    assert.equal((await enf.check({ accountId: 'u_' + uPro.sub, feature: 'meet.recording' })).ok, true);
    const denied = await enf.check({ accountId: 'u_' + uFree.sub, feature: 'meet.recording' }); assert.deepEqual([denied.ok, denied.kind, denied.reason, denied.upgradeAvailable], [false, 'denied', 'not_in_plan', true]);
    await ceiling(WFree, 'storage.mb', 1); const st = createSbacsClient({ ...base, mode: 'enforce', service: 'storage', privateKeyPem: pem('storage') });
    assert.equal((await st.reserve({ accountId: 'u_' + uFree.sub, feature: 'storage.mb', units: 1, idempotencyKey: 'mode-q-0001' })).ok, true);
    const quota = await st.reserve({ accountId: 'u_' + uFree.sub, feature: 'storage.mb', units: 1, idempotencyKey: 'mode-q-0002' }); assert.deepEqual([quota.ok, quota.kind], [false, 'quota']);
    assert.throws(() => createSbacsClient({ mode: 'enforce', service: 'meet', baseUrl: px.url }), /private key/); assert.throws(() => createSbacsClient({ mode: 'enforce', service: 'meet', privateKeyPem: pem('meet') }), /portal base URL/);
    assert.throws(() => createSbacsClient({ mode: 'enforce', service: 'meet', baseUrl: px.url, privateKeyPem: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) }), /Ed25519/); assert.throws(() => createSbacsClient({ mode: 'sometimes' }), /off, shadow or enforce/);
    await sql(`DELETE FROM portal.entitlement_overrides WHERE workspace_id=$1`, [WFree]);
  });

  test('fail closed: a wrong credential, wrong audience or an unreachable service refuses NEW operations as "unavailable" (never as permission); the circuit opens, then recovers', async () => {
    const q = { accountId: 'u_' + uPro.sub, feature: 'meet.recording' };
    const wrongAud = createSbacsClient({ mode: 'enforce', baseUrl: px.url, service: 'meet', privateKeyPem: pem('meet'), audience: 'someone-else', log });
    const r = await wrongAud.check(q); assert.deepEqual([r.ok, r.kind, r.reason], [false, 'unavailable', 'credential_rejected']); assert.ok(logs.some((l) => l.msg === 'sbacs.credential_rejected'));
    const wrongKey = createSbacsClient({ mode: 'enforce', baseUrl: px.url, service: 'meet', privateKeyPem: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), log });
    assert.equal((await wrongKey.check(q)).kind, 'unavailable');
    const skewed = createSbacsClient({ mode: 'enforce', baseUrl: px.url, service: 'meet', privateKeyPem: pem('meet'), now: () => Date.now() - 20 * 60_000, log }); assert.equal((await skewed.check(q)).reason, 'credential_rejected', 'an expired token is not accepted');
    let clock = Date.now(); const c = createSbacsClient({ mode: 'enforce', baseUrl: px.url, service: 'meet', privateKeyPem: pem('meet'), breakerFailures: 3, breakerOpenMs: 5000, timeoutMs: 800, now: () => clock, log });
    assert.equal((await c.check(q)).ok, true);
    await px.stop();                                                                                                       // the entitlement service becomes unreachable
    for (let i = 0; i < 3; i++) { const o = await c.check(q); assert.deepEqual([o.ok, o.kind], [false, 'unavailable']); }
    assert.deepEqual(c.breaker(), { failures: 3, open: true }); const fast = await c.check(q); assert.equal(fast.reason, 'circuit_open', 'no network attempt while the circuit is open');
    await px.start();                                                                                                      // it comes back
    assert.equal((await c.check(q)).reason, 'circuit_open', 'still inside the open window'); clock += 6000;
    assert.equal((await c.check(q)).ok, true, 'a probe after the window succeeds and closes the circuit'); assert.deepEqual(c.breaker(), { failures: 0, open: false });
  });

  test('meeting creation and recording initiation: entitlement per host workspace, fail closed when SBACS is down, no account = no attribution; one metered recording per started session', async () => {
    const enf = mkEnf(); const pro = 'u_' + uPro.sub, free = 'u_' + uFree.sub;
    assert.equal((await enf.gate('meet.create', pro)).ok, true);
    const noPlan = await enf.gate('meet.recording', free); assert.deepEqual([noPlan.ok, noPlan.status, noPlan.body.error, noPlan.body.reason], [false, 403, 'subscription_access_denied', 'not_in_plan']);
    const none = await enf.gate('meet.create', null); assert.deepEqual([none.status, none.body.reason], [403, 'no_account']);
    assert.equal((await enf.gate('meet.create', 'u_' + (await main.mint()).sub)).body.reason, 'no_workspace', 'an account with no workspace has no plan to attribute the work to');
    const mPro = await meeting(pro), mFree = await meeting(free); assert.equal((await enf.gateMeeting('meet.recording', mPro)).ok, true); assert.equal((await enf.gateMeeting('meet.recording', mFree)).status, 403);
    // metered start: one reservation per session key; a retry is the same recording; releasing gives it back; finalizing counts it
    const session = crypto.randomUUID(); const a = await enf.beginRecording(mPro, session), b = await enf.beginRecording(mPro, session); assert.ok(a.ok && b.ok); assert.equal(a.ticket.reservationId, b.ticket.reservationId);
    await enf.endRecording(a.ticket, true); assert.equal((await usedOf(WPro, 'meet.recording')).used, 1); const s2 = await enf.beginRecording(mPro, crypto.randomUUID()); await enf.endRecording(s2.ticket, false); assert.equal((await usedOf(WPro, 'meet.recording')).reserved, 0);
    await ceiling(WPro, 'meet.recording', 4);                                                                              // 1 used; ceiling 4: of 10 simultaneous starts exactly 3 more succeed
    const busy = mkEnf({ timeoutMs: 10_000, breakerFailures: 99 });     // ten reservations on ONE workspace counter queue on its row lock: a client timeout must allow for that
    const starts = await Promise.all(Array.from({ length: 10 }, () => busy.beginRecording(mPro, crypto.randomUUID()))); assert.equal(starts.filter((x) => x.ok).length, 3, JSON.stringify(starts.map((x) => x.ok || x.body))); assert.equal(starts.filter((x) => !x.ok && x.body.reason === 'quota_exhausted').length, 7, JSON.stringify(starts.map((x) => x.ok || x.body)));
    for (const x of starts.filter((y) => y.ok)) await busy.endRecording(x.ticket, true); assert.deepEqual(await usedOf(WPro, 'meet.recording'), { used: 4, reserved: 0 });
    await sql(`DELETE FROM portal.entitlement_overrides WHERE workspace_id=$1 AND feature='meet.recording'`, [WPro]);
    // the entitlement service is down: NEW operations fail closed with a retryable 503
    await px.stop(); const down = await mkEnf({ breakerFailures: 99 }).gate('meet.create', pro); assert.deepEqual([down.ok, down.status, down.body.error, down.body.retryable], [false, 503, 'entitlement_service_unavailable', true]);
    assert.equal((await mkEnf({ breakerFailures: 99 }).beginRecording(mPro, crypto.randomUUID())).status, 503); await px.start();
    // shadow mode never refuses, off mode never calls
    assert.equal((await mkEnf({ mode: 'shadow' }, mkClients({ mode: 'shadow' })).gate('meet.recording', free)).ok, true);
    assert.deepEqual(await createEnforcement({ mode: 'off', db: mdb.pool }).gate('meet.recording', null), { ok: true });
  });

  test('storage: reserve before bytes, finalize when durable, release on failure; MiB blocks add up exactly whatever the chunking; retries and duplicates are never counted twice; quota stops new media', async () => {
    const enf = mkEnf(), acct = 'u_' + uPro.sub, m = await meeting(acct), rec = crypto.randomUUID(); await sql(`DELETE FROM portal.subscription_usage WHERE workspace_id=$1 AND feature='storage.mb'`, [WPro]);
    const sizes = [400_000, 700_000, 1_500_000, 300_000, 2_100_000, 50_000]; let bytes = 0, seq = 0;
    for (const size of sizes) { const t = await enf.beforeChunk({ meetingId: m, recordingId: rec, seq, bytesBefore: bytes, size }); assert.ok(t.ok); await enf.afterChunk(t.ticket, true); bytes += size; seq++; }
    assert.deepEqual(await usedOf(WPro, 'storage.mb'), { used: Math.ceil(bytes / MIB), reserved: 0 }, 'total charged = ceil(total bytes / 1 MiB), independent of chunk sizes');
    // a retry of an already-stored chunk (same seq, same bytesBefore) is the same operation: no second charge
    const before = (await usedOf(WPro, 'storage.mb')).used; const r1 = await enf.beforeChunk({ meetingId: m, recordingId: rec, seq: 99, bytesBefore: bytes, size: 3 * MIB }); const r2 = await enf.beforeChunk({ meetingId: m, recordingId: rec, seq: 99, bytesBefore: bytes, size: 3 * MIB });
    assert.equal(r1.ticket.reservationId, r2.ticket.reservationId); await enf.afterChunk(r1.ticket, true); await enf.afterChunk(r2.ticket, true);
    assert.equal((await usedOf(WPro, 'storage.mb')).used, before + Math.ceil((bytes + 3 * MIB) / MIB) - Math.ceil(bytes / MIB), 'charged once');
    // a verified storage failure releases the reservation
    const bad = await enf.beforeChunk({ meetingId: m, recordingId: rec, seq: 200, bytesBefore: 50 * MIB, size: 2 * MIB }); await enf.afterChunk(bad.ticket, false); assert.equal((await usedOf(WPro, 'storage.mb')).reserved, 0);
    // quota: new media is refused with a plain code; what is stored stays
    await ceiling(WPro, 'storage.mb', Math.ceil((bytes + 3 * MIB) / MIB) + 1);
    const room = await enf.beforeChunk({ meetingId: m, recordingId: rec, seq: 300, bytesBefore: bytes + 3 * MIB, size: 1 * MIB }); assert.ok(room.ok); await enf.afterChunk(room.ticket, true);
    const full = await enf.beforeChunk({ meetingId: m, recordingId: rec, seq: 301, bytesBefore: bytes + 4 * MIB, size: 5 * MIB }); assert.deepEqual([full.ok, full.status, full.body.error], [false, 403, 'storage_quota_reached']);
    await sql(`DELETE FROM portal.entitlement_overrides WHERE workspace_id=$1 AND feature='storage.mb'`, [WPro]);
    // identities: the MEET credential cannot touch storage, even through the same portal
    const meetOnly = mkClients().meetClient; const x = await meetOnly.reserve({ accountId: acct, feature: 'storage.mb', units: 1, idempotencyKey: 'cross-svc-0001' }); assert.deepEqual([x.ok, x.kind, x.reason], [false, 'denied', 'out_of_scope']);
  });

  test('already-authorised recordings are not cut off: suspension or an outage defers media within a bounded grace, records it later exactly once, and refuses beyond the grace; late settlement works', async () => {
    const acct = 'u_' + uPro.sub, m = await meeting(acct); await sql(`DELETE FROM portal.subscription_usage WHERE workspace_id=$1 AND feature='storage.mb'`, [WPro]); await msql('DELETE FROM sbacs_outbox');
    // ---- suspension in the middle of a recording
    const rec = crypto.randomUUID(), enf = mkEnf({ graceMib: 4 }); const t0 = await enf.beforeChunk({ meetingId: m, recordingId: rec, seq: 0, bytesBefore: 0, size: 1 * MIB }); await enf.afterChunk(t0.ticket, true);   // 1 MiB while the plan was fine
    await sbacs.setSuspended({ workspaceId: WPro, suspended: true, reason: 'chargeback', actorId: crypto.randomUUID() });
    const t1 = await enf.beforeChunk({ meetingId: m, recordingId: rec, seq: 1, bytesBefore: 1 * MIB, size: 2 * MIB }); assert.ok(t1.ok && t1.ticket.deferred, 'the recording keeps being stored'); await enf.afterChunk(t1.ticket, true);
    const t2 = await enf.beforeChunk({ meetingId: m, recordingId: rec, seq: 2, bytesBefore: 3 * MIB, size: 2 * MIB }); assert.ok(t2.ok && t2.ticket.deferred); await enf.afterChunk(t2.ticket, true);                 // 4 MiB deferred = the grace
    const t3 = await enf.beforeChunk({ meetingId: m, recordingId: rec, seq: 3, bytesBefore: 5 * MIB, size: 1 * MIB }); assert.deepEqual([t3.ok, t3.status, t3.body.reason], [false, 403, 'account_suspended'], 'beyond the grace the chunk is refused');
    assert.equal((await enf.gate('meet.create', acct)).ok, false, 'and nothing NEW (a meeting) is admitted for a suspended workspace');
    assert.equal(await enf.outboxOpen(), 2);
    assert.equal((await enf.drain()).settled, 2, 'delivered media is recorded even while suspended'); assert.equal(await enf.outboxOpen(), 0);
    assert.equal((await usedOf(WPro, 'storage.mb')).used, 5, '1 + 2 + 2 MiB blocks');
    assert.equal((await enf.drain()).settled, 0, 'draining again changes nothing'); await sbacs.setSuspended({ workspaceId: WPro, suspended: false, actorId: crypto.randomUUID() });
    // ---- outage in the middle of a recording (a REAL connection failure), then recovery
    const rec2 = crypto.randomUUID(), cl = mkClients({ breakerFailures: 99, timeoutMs: 600 }), e2 = mkEnf({ graceMib: 4 }, cl);
    const a = await e2.beforeChunk({ meetingId: m, recordingId: rec2, seq: 0, bytesBefore: 0, size: 1 * MIB }); await e2.afterChunk(a.ticket, true);                       // reserved + finalized: 1 MiB
    const reservedBefore = await usedOf(WPro, 'storage.mb'); await px.stop();
    const b = await e2.beforeChunk({ meetingId: m, recordingId: rec2, seq: 1, bytesBefore: 1 * MIB, size: 3 * MIB }); assert.ok(b.ok && b.ticket.deferred); await e2.afterChunk(b.ticket, true);
    const over = await e2.beforeChunk({ meetingId: m, recordingId: rec2, seq: 2, bytesBefore: 4 * MIB, size: 2 * MIB }); assert.deepEqual([over.ok, over.status, over.body.error], [false, 503, 'entitlement_service_unavailable'], 'beyond the grace an outage fails closed');
    // a reservation that cannot be finalized because the service is down is remembered, not lost
    await px.start(); const c = await e2.beforeChunk({ meetingId: m, recordingId: rec2, seq: 3, bytesBefore: 4 * MIB, size: 1 * MIB }); assert.ok(c.ok && c.ticket.reservationId); await px.stop();
    await e2.afterChunk(c.ticket, true); assert.equal(await e2.outboxOpen(), 2, 'one deferred record + one pending finalize'); await px.start();
    assert.equal((await e2.drain()).settled, 2); assert.deepEqual(await usedOf(WPro, 'storage.mb'), { used: reservedBefore.used + 3 + 1, reserved: 0 }, 'nothing lost, nothing counted twice');
    // late finalization: the reservation expired before the finalize could be sent
    const d = await e2.beforeChunk({ meetingId: m, recordingId: rec2, seq: 4, bytesBefore: 5 * MIB, size: 2 * MIB }); await sql(`UPDATE portal.usage_reservations SET expires_at = now() - interval '1 minute' WHERE id=$1`, [d.ticket.reservationId]); await sbacs.reapExpired();
    const usedBefore = (await usedOf(WPro, 'storage.mb')).used; await e2.afterChunk(d.ticket, true); assert.equal((await usedOf(WPro, 'storage.mb')).used, usedBefore + 2, 'late finalize is still recorded');
  });

  test('portal.record completes an operation that was reserved earlier but never settled, exactly once (a reserve whose answer was lost, then delivered work)', async () => {
    const cl = mkClients().storageClient, acct = 'u_' + uPro.sub; await sql(`DELETE FROM portal.subscription_usage WHERE workspace_id=$1 AND feature='storage.mb'`, [WPro]);
    const r = await cl.reserve({ accountId: acct, feature: 'storage.mb', units: 3, idempotencyKey: 'lost-answer-0001' }); assert.ok(r.ok); assert.deepEqual(await usedOf(WPro, 'storage.mb'), { used: 0, reserved: 3 });
    assert.equal((await cl.record({ accountId: acct, feature: 'storage.mb', units: 3, idempotencyKey: 'lost-answer-0001' })).completed, 'reserved'); assert.deepEqual(await usedOf(WPro, 'storage.mb'), { used: 3, reserved: 0 });
    assert.equal((await cl.record({ accountId: acct, feature: 'storage.mb', units: 3, idempotencyKey: 'lost-answer-0001' })).replay, true); assert.deepEqual(await usedOf(WPro, 'storage.mb'), { used: 3, reserved: 0 }, 'a second record changes nothing');
  });
});
