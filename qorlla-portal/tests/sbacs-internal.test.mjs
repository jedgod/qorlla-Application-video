import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { generateKeyPairSync } from 'node:crypto';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, addMember } from './helpers.mjs';
import { createSbacs, mintServiceToken, verifyServiceToken } from '../server/sbacs.mjs';

// The internal entitlement API as other services use it. Identity is Ed25519 workload identity: each service holds its own private key, the portal holds public keys only.
const NAMES = ['meet', 'clips', 'storage', 'docs'];
const SVC = Object.fromEntries(NAMES.map((n) => [n, generateKeyPairSync('ed25519')]));
const PUB = Object.entries(SVC).map(([n, k]) => `${n}=${k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`).join(',');
const tok = (service = 'meet', o = {}) => mintServiceToken({ service, privateKey: SVC[service].privateKey, ...o });

describe('internal entitlement API: service identity, scope and isolation', () => {
  let db, main, app, sbacs, A, B, D, N, W1, W2, W3;
  const sql = (q, a) => db.pool.query(q, a);
  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn(); sbacs = createSbacs({ pool: db.pool });
    app = await startApp({ pool: db.pool, cfg: testConfig({ env: { SBACS_SERVICE_PUBLIC_KEYS: PUB } }, main), jwks: main.jwks });
    A = await main.mint(); B = await main.mint(); D = await main.mint(); N = await main.mint();
    W1 = await seedWorkspace(db.pool, A.sub, 'W1'); W2 = await seedWorkspace(db.pool, B.sub, 'W2'); W3 = await seedWorkspace(db.pool, D.sub, 'W3'); await addMember(db.pool, W1, D.sub, 'member');
    await sql(`UPDATE portal.subscriptions SET plan_slug='pro',status='active',billing_interval='month',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [W1]);
  });
  after(async () => { await app.close(); await main.close(); await db.drop(); });
  const call = (op, body, token) => fetch(app.base + '/internal/v1/entitlements/' + op, { method: 'POST', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) });
  const acct = (u) => 'u_' + u.sub;                                                                        // the form the main app uses for account ids

  test('credentials: missing, malformed, forged, wrong key, wrong audience, wrong issuer, expired, long-lived, future, tampered and unknown-service tokens are all refused as "not found", on every operation', async () => {
    const good = tok('meet'), other = generateKeyPairSync('ed25519'), q = { accountId: acct(A), feature: 'meet.create' };
    assert.equal((await j(await call('check', q, good))).allowed, true);
    const [h, body, sig] = good.split('.'); const claims = JSON.parse(Buffer.from(body, 'base64url'));
    const tamper = (patch) => [h, Buffer.from(JSON.stringify({ ...claims, ...patch })).toString('base64url'), sig].join('.');
    const bad = {
      missing: null, garbage: 'wrong-token-wrong-token-wrong', 'empty bearer': '', 'old HMAC scheme': 'qsv1.' + body + '.' + 'A'.repeat(43),
      'forged by another key': mintServiceToken({ service: 'meet', privateKey: other.privateKey }), 'signed by storage, claiming meet': mintServiceToken({ service: 'meet', privateKey: SVC.storage.privateKey }),
      'wrong audience': tok('meet', { audience: 'someone-else' }), 'wrong issuer': tok('meet', { issuer: 'qorlla-storage' }), 'issuer from outside': tok('meet', { issuer: 'https://evil.example' }),
      expired: tok('meet', { now: Date.now() - 10 * 60_000 }), 'just expired': tok('meet', { now: Date.now() - 125_000, ttlSec: 120 }), 'long-lived (1 h)': tok('meet', { ttlSec: 3600 }),
      'issued in the future': tok('meet', { now: Date.now() + 10 * 60_000 }), 'tampered subject': tamper({ sub: 'storage' }), 'tampered expiry': tamper({ exp: claims.exp + 3600 }),
      'unknown service': mintServiceToken({ service: 'billing', privateKey: other.privateKey }), 'no jti': (() => { const c = { ...claims }; delete c.jti; const b2 = Buffer.from(JSON.stringify(c)).toString('base64url'); return 'qsv2.' + b2 + '.' + crypto.sign(null, Buffer.from('qsv2.' + b2), SVC.meet.privateKey).toString('base64url'); })()
    };
    for (const op of ['check', 'reserve', 'record', 'finalize', 'release']) for (const [why, t] of Object.entries(bad)) assert.equal((await call(op, q, t)).status, 404, `${op}: ${why}`);
    assert.equal(verifyServiceToken(good, { publicKeys: {}, audience: 'qorlla-sbacs' }), null, 'no registered keys, no service');
    const off = await startApp({ pool: db.pool, cfg: testConfig({}, main), jwks: main.jwks });                // no SBACS_SERVICE_PUBLIC_KEYS at all: the interface does not exist
    try { assert.equal((await fetch(off.base + '/internal/v1/entitlements/check', { method: 'POST', headers: { authorization: 'Bearer ' + good, 'content-type': 'application/json' }, body: JSON.stringify(q) })).status, 404); } finally { await off.close(); }
    const rejectedRsa = await startApp({ pool: db.pool, cfg: testConfig({ env: { SBACS_SERVICE_PUBLIC_KEYS: 'meet=' + generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64') } }, main), jwks: main.jwks });
    try { assert.equal((await fetch(rejectedRsa.base + '/internal/v1/entitlements/check', { method: 'POST', headers: { authorization: 'Bearer ' + good, 'content-type': 'application/json' }, body: JSON.stringify(q) })).status, 404, 'only Ed25519 keys are accepted'); } finally { await rejectedRsa.close(); }
  });

  test('scope: a service can only use its own features and settle its own reservations; service A cannot perform service B\'s operations', async () => {
    const q = (feature) => ({ accountId: acct(A), feature });
    assert.equal((await call('check', q('meet.recording'), tok('meet'))).status, 200);
    for (const [svc, feature] of [['meet', 'storage.mb'], ['meet', 'clips.create'], ['meet', 'phone.pstn'], ['meet', 'ai.docs.draft'], ['storage', 'meet.create'], ['storage', 'clips.create'], ['clips', 'storage.mb'], ['docs', 'meet.recording']]) {
      const r = await call('check', q(feature), tok(svc)); assert.equal(r.status, 403, `${svc} -> ${feature}`); assert.equal((await r.json()).error, 'out_of_scope');
      assert.equal((await call('reserve', { ...q(feature), units: 1, idempotencyKey: 'scope-' + svc + feature }, tok(svc))).status, 403); assert.equal((await call('record', { ...q(feature), units: 1, idempotencyKey: 'scope-' + svc + feature }, tok(svc))).status, 403);
    }
    const mine = await j(await call('reserve', { ...q('storage.mb'), units: 3, idempotencyKey: 'scope-storage-0001' }, tok('storage'))); assert.equal(mine.ok, true);
    for (const op of ['finalize', 'release']) { const r = await call(op, { accountId: acct(A), reservationId: mine.reservationId }, tok('meet')); assert.equal(r.status, 403, 'meet cannot ' + op + ' a storage reservation'); }
    assert.equal((await j(await call('finalize', { accountId: acct(A), reservationId: mine.reservationId }, tok('storage')))).ok, true);
    assert.equal((await call('finalize', { accountId: acct(A), reservationId: crypto.randomUUID() }, tok('storage'))).status, 404);
  });

  test('workspace isolation: the workspace comes from the ACCOUNT\'s membership; naming someone else\'s workspace, settling someone else\'s reservation, or having no workspace gets nothing', async () => {
    const meet = tok('meet');
    assert.equal((await j(await call('check', { accountId: acct(B), workspaceId: W1, feature: 'meet.recording' }, meet))).status, 403);              // B is not a member of W1
    assert.equal((await j(await call('reserve', { accountId: acct(B), workspaceId: W1, feature: 'meet.recording', idempotencyKey: 'iso-reserve-1' }, meet))).reason, 'not_a_member');
    assert.equal((await j(await call('record', { accountId: acct(B), workspaceId: W1, feature: 'meet.recording', idempotencyKey: 'iso-record-1' }, meet))).reason, 'not_a_member');
    assert.equal((await j(await call('check', { accountId: acct(A), workspaceId: W1, feature: 'meet.recording' }, meet))).allowed, true);
    // each account is judged by ITS workspace: A is on Pro (recording allowed), B on Free (recording not in the plan)
    assert.equal((await j(await call('check', { accountId: acct(A), feature: 'meet.recording' }, meet))).allowed, true);
    const freeRec = await j(await call('check', { accountId: acct(B), feature: 'meet.recording' }, meet)); assert.deepEqual([freeRec.allowed, freeRec.reason], [false, 'not_in_plan']);
    // D owns W3 and is a member of W1: the workspace D owns is primary; an explicit W1 is allowed because D belongs to it
    assert.equal((await j(await call('check', { accountId: acct(D), feature: 'meet.recording' }, meet))).allowed, false, 'W3 (Free) is the owned, primary workspace');
    assert.equal((await j(await call('check', { accountId: acct(D), workspaceId: W1, feature: 'meet.recording' }, meet))).allowed, true);
    // settling is bound to membership of the reservation's workspace
    const r = await j(await call('reserve', { accountId: acct(A), feature: 'meet.create', idempotencyKey: 'iso-settle-0001' }, meet)); assert.equal(r.ok, true);
    assert.equal((await call('finalize', { accountId: acct(B), reservationId: r.reservationId }, meet)).status, 403); assert.equal((await call('release', { accountId: acct(B), reservationId: r.reservationId }, meet)).status, 403);
    assert.equal((await j(await call('finalize', { accountId: acct(A), reservationId: r.reservationId }, meet))).ok, true);
    // no workspace: nothing is allowed except joining as a guest; and nothing can be reserved or recorded
    assert.deepEqual((({ allowed, reason }) => ({ allowed, reason }))(await j(await call('check', { accountId: acct(N), feature: 'meet.create' }, meet))), { allowed: false, reason: 'no_workspace' });
    assert.equal((await j(await call('check', { accountId: acct(N), feature: 'meet.guest_join' }, meet))).allowed, true);
    assert.equal((await j(await call('reserve', { accountId: acct(N), feature: 'meet.create', idempotencyKey: 'iso-none-0001' }, meet))).reason, 'no_workspace');
    assert.equal((await call('check', { accountId: '../../etc/passwd', feature: 'meet.create' }, meet)).status, 400); assert.equal((await call('check', { accountId: 'u_not-a-uuid', feature: 'meet.create' }, meet)).status, 400);
    assert.equal((await call('check', { accountId: acct(A), feature: 'meet.create', extra: 1 }, meet)).status, 400, 'unknown fields are refused');
  });

  test('duplicate reservations are replays, conflicting ones are refused, late finalization after expiry is recorded, and record() never refuses delivered work', async () => {
    const st = tok('storage'), q = { accountId: acct(A), feature: 'storage.mb' };
    const first = await j(await call('reserve', { ...q, units: 5, idempotencyKey: 'dup-0001' }, st)); const second = await j(await call('reserve', { ...q, units: 5, idempotencyKey: 'dup-0001' }, st));
    assert.equal(first.ok, true); assert.equal(second.replay, true); assert.equal(second.reservationId, first.reservationId);
    assert.equal((await sql(`SELECT count(*)::int n FROM portal.usage_reservations WHERE workspace_id=$1 AND idempotency_key='dup-0001'`, [W1])).rows[0].n, 1);
    const conflict = await call('reserve', { ...q, units: 6, idempotencyKey: 'dup-0001' }, st); assert.equal(conflict.status, 403); assert.equal((await conflict.json()).reason, 'idempotency_conflict');
    // a worker that never settled: the reservation expires and is reaped; a late finalize is still recorded (the data was stored)
    const slow = await j(await call('reserve', { ...q, units: 2, idempotencyKey: 'late-0001', ttlMs: 1000 }, st));
    await sql(`UPDATE portal.usage_reservations SET expires_at = now() - interval '1 minute' WHERE id=$1`, [slow.reservationId]); assert.ok((await sbacs.reapExpired()) >= 1);
    const used0 = Number((await sql(`SELECT used FROM portal.subscription_usage WHERE workspace_id=$1 AND feature='storage.mb'`, [W1])).rows[0].used);
    const late = await j(await call('finalize', { accountId: acct(A), reservationId: slow.reservationId }, st)); assert.deepEqual([late.ok, late.late], [true, true]);
    assert.equal(Number((await sql(`SELECT used FROM portal.subscription_usage WHERE workspace_id=$1 AND feature='storage.mb'`, [W1])).rows[0].used), used0 + 2);
    assert.equal((await j(await call('finalize', { accountId: acct(A), reservationId: slow.reservationId }, st))).ok, true, 'finalizing twice is a no-op'); assert.equal(Number((await sql(`SELECT used FROM portal.subscription_usage WHERE workspace_id=$1 AND feature='storage.mb'`, [W1])).rows[0].used), used0 + 2);
    // record(): work already done is recorded even past a ceiling, once per key
    await sql(`INSERT INTO portal.entitlement_overrides(workspace_id,feature,enabled,quota,reason,created_by) VALUES($1,'storage.mb',true,10,'test ceiling',$2) ON CONFLICT (workspace_id,feature) DO UPDATE SET quota=10`, [W1, crypto.randomUUID()]);
    const over = await call('reserve', { ...q, units: 1000, idempotencyKey: 'dup-over-0001' }, st); assert.equal(over.status, 403); assert.equal((await over.json()).reason, 'quota_exhausted');
    const rec = await j(await call('record', { ...q, units: 1000, idempotencyKey: 'rec-0001' }, st)); assert.deepEqual([rec.ok, rec.recorded], [true, 1000]);
    assert.equal((await j(await call('record', { ...q, units: 1000, idempotencyKey: 'rec-0001' }, st))).replay, true); assert.equal((await j(await call('record', { ...q, units: 7, idempotencyKey: 'rec-0001' }, st))).reason, 'idempotency_conflict');
    assert.ok(Number((await sql(`SELECT used FROM portal.subscription_usage WHERE workspace_id=$1 AND feature='storage.mb'`, [W1])).rows[0].used) >= used0 + 1002);
    await sql(`DELETE FROM portal.entitlement_overrides WHERE workspace_id=$1 AND feature='storage.mb'`, [W1]);
  });

  test('concurrent consumption: 40 simultaneous reservations against a ceiling of 10 admit exactly 10; 40 retries of one key make exactly one reservation', async () => {
    const st = tok('storage'); await sql(`INSERT INTO portal.entitlement_overrides(workspace_id,feature,enabled,quota,reason,created_by) VALUES($1,'storage.mb',true,10,'race ceiling',$2) ON CONFLICT (workspace_id,feature) DO UPDATE SET quota=10`, [W2, crypto.randomUUID()]);
    await sql(`DELETE FROM portal.subscription_usage WHERE workspace_id=$1 AND feature='storage.mb'`, [W2]);
    const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => call('reserve', { accountId: acct(B), feature: 'storage.mb', units: 1, idempotencyKey: 'race-' + String(i).padStart(4, '0') }, st).then(j)));
    assert.equal(rs.filter((r) => r.ok).length, 10); assert.equal(rs.filter((r) => r.reason === 'quota_exhausted').length, 30);
    const u = (await sql(`SELECT used::int, reserved::int FROM portal.subscription_usage WHERE workspace_id=$1 AND feature='storage.mb'`, [W2])).rows[0]; assert.deepEqual(u, { used: 0, reserved: 10 });
    for (const r of rs.filter((x) => x.ok)) await call('finalize', { accountId: acct(B), reservationId: r.reservationId }, st);
    assert.deepEqual((await sql(`SELECT used::int, reserved::int FROM portal.subscription_usage WHERE workspace_id=$1 AND feature='storage.mb'`, [W2])).rows[0], { used: 10, reserved: 0 });
    await sql(`UPDATE portal.entitlement_overrides SET quota=1000 WHERE workspace_id=$1 AND feature='storage.mb'`, [W2]);
    const same = await Promise.all(Array.from({ length: 40 }, () => call('reserve', { accountId: acct(B), feature: 'storage.mb', units: 3, idempotencyKey: 'one-key-0001' }, st).then(j)));
    assert.ok(same.every((r) => r.ok) && new Set(same.map((r) => r.reservationId)).size === 1); assert.equal((await sql(`SELECT count(*)::int n FROM portal.usage_reservations WHERE workspace_id=$1 AND idempotency_key='one-key-0001'`, [W2])).rows[0].n, 1);
    assert.equal((await sql(`SELECT reserved::int r FROM portal.subscription_usage WHERE workspace_id=$1 AND feature='storage.mb'`, [W2])).rows[0].r, 3, 'three units reserved once, not forty times');
  });

  test('suspension during an active operation: in-flight work can still settle, delivered work is still recorded, but nothing NEW is admitted or reserved', async () => {
    const meet = tok('meet'), st = tok('storage'); const u = await main.mint(); const W = await seedWorkspace(db.pool, u.sub, 'Susp');
    await sql(`UPDATE portal.subscriptions SET plan_slug='business',status='active',billing_interval='month',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [W]);
    const inflight = await j(await call('reserve', { accountId: acct(u), feature: 'storage.mb', units: 4, idempotencyKey: 'susp-0001' }, st)); assert.equal(inflight.ok, true);
    await sbacs.setSuspended({ workspaceId: W, suspended: true, reason: 'chargeback', actorId: crypto.randomUUID() });
    for (const [op, body, t] of [['check', { feature: 'meet.create' }, meet], ['reserve', { feature: 'storage.mb', units: 1, idempotencyKey: 'susp-0002' }, st]]) { const r = await j(await call(op, { accountId: acct(u), ...body }, t)); assert.equal(r.ok === true || r.allowed === true, false, op); assert.equal(r.reason, 'account_suspended'); }
    assert.equal((await j(await call('finalize', { accountId: acct(u), reservationId: inflight.reservationId }, st))).ok, true, 'the operation that was already authorised settles');
    assert.equal((await j(await call('record', { accountId: acct(u), feature: 'storage.mb', units: 2, idempotencyKey: 'susp-0003' }, st))).ok, true, 'media already stored is still accounted for');
    assert.equal((await j(await call('check', { accountId: acct(u), feature: 'meet.guest_join' }, meet))).allowed, true, 'joining as a guest is not a use of this workspace');
    await sbacs.setSuspended({ workspaceId: W, suspended: false, actorId: crypto.randomUUID() });
    assert.equal((await j(await call('check', { accountId: acct(u), feature: 'meet.create' }, meet))).allowed, true);
  });
});
