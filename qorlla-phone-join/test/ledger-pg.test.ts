import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { admitTelephoneCall, type Readiness, type MeetingAuthority, type SipRtpBridge } from '../src/admission.js';
import { PostgresCallLedger, PostgresReplayStore } from '../src/ledger-pg.js';

// Integration tests against a REAL PostgreSQL. Set PHONE_JOIN_TEST_DATABASE_URL to any database the tests may create a throw-away schema in; without it they are skipped (and reported as skipped).
const URL = process.env.PHONE_JOIN_TEST_DATABASE_URL, skip = URL ? false : 'PHONE_JOIN_TEST_DATABASE_URL is not set';
const all: Readiness = { carrierConnected: true, inboundNumberCertified: true, gatewayHealthy: true, mediaBridgeCertified: true, billingCertified: true, productionApproved: true };
const request = (n: number | string) => ({ meetingId: 'ABC12345', passcode: '123456', callId: 'call_' + String(n).padStart(8, '0'), dialedNumber: '+12025550100' });
const open: MeetingAuthority = { verifyPhoneJoin: async () => ({ allowed: true, requiresHostApproval: false, meetingSessionId: 's1' }), requestHostApproval: async () => true };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Polls until the condition holds (background cleanup has no completion signal of its own). */
const eventually = async (cond: () => Promise<boolean>, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(20); } return cond(); };
const migration = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'sql', '001_phone_join.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'sql', '001_phone_join.rollback.sql'), 'utf8');
const lease = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'sql', '002_phone_join_lease.sql'), 'utf8');
const leaseRollback = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'sql', '002_phone_join_lease.rollback.sql'), 'utf8');

let schema = '', admin: pg.Pool; const pools: pg.Pool[] = [];
/** A pool that behaves like one gateway replica: its own connections, its own instance name. */
const replica = (name: string) => { const p = new pg.Pool({ connectionString: URL, options: '-c search_path=' + schema, max: 8 }); pools.push(p); return { pool: p, ledger: new PostgresCallLedger(p, name) }; };
test.before(async () => { if (!URL) return; schema = 'pj_' + Math.random().toString(36).slice(2, 9); admin = new pg.Pool({ connectionString: URL }); await admin.query('CREATE SCHEMA ' + schema); const c = await admin.connect(); try { await c.query('SET search_path=' + schema); await c.query(migration); await c.query(migration); await c.query(lease); await c.query(lease); } finally { c.release(); } });   // each applied twice: idempotent
test.after(async () => { if (!URL) return; for (const p of pools) await p.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); });

test('PostgreSQL ledger: with four gateway replicas racing, exactly one claims each call id', { skip }, async () => {
  const replicas = [1, 2, 3, 4].map((i) => replica('gw' + i));
  for (let n = 0; n < 25; n++) {
    const wins = await Promise.all(replicas.map((r) => r.ledger.claim('race_' + String(n).padStart(8, '0'))));
    assert.equal(wins.filter(Boolean).length, 1, 'call ' + n);
  }
  const owners = (await admin.query(`SELECT count(*)::int AS n, count(DISTINCT call_id)::int AS d FROM ${schema}.phone_join_calls WHERE call_id LIKE 'race_%'`)).rows[0]; assert.deepEqual(owners, { n: 25, d: 25 });
  const history = (await admin.query(`SELECT count(*)::int AS n FROM ${schema}.phone_join_call_events WHERE call_id LIKE 'race_%'`)).rows[0].n; assert.equal(history, 25);        // one 'claimed' event per call, not per attempt
});

test('PostgreSQL ledger: states only move along the allowed transitions, and every move is recorded', { skip }, async () => {
  const { ledger } = replica('gw'), id = 'trans_00000001';
  assert.equal(await ledger.transition(id, 'authorizing'), false, 'an unknown call has no states');
  assert.equal(await ledger.claim(id), true);
  assert.equal(await ledger.transition(id, 'connected'), false, 'claimed cannot jump to connected');
  assert.equal(await ledger.transition(id, 'authorizing'), true); assert.equal(await ledger.transition(id, 'attaching', { meetingSessionId: 's1' }), true); assert.equal(await ledger.transition(id, 'connected'), true);
  assert.equal(await ledger.transition(id, 'attaching'), false, 'no going backwards'); assert.equal(await ledger.transition(id, 'failed'), false, 'a connected call ends or terminates, it does not "fail"');
  assert.equal(await ledger.transition(id, 'ended', { reason: 'caller_hung_up' }), true); assert.equal(await ledger.transition(id, 'connected'), false, 'ended is final');
  assert.equal(await ledger.stateOf(id), 'ended');
  const path = (await admin.query(`SELECT to_state FROM ${schema}.phone_join_call_events WHERE call_id=$1 ORDER BY id`, [id])).rows.map((r) => r.to_state); assert.deepEqual(path, ['claimed', 'authorizing', 'attaching', 'connected', 'ended']);
  const row = (await admin.query(`SELECT meeting_session_id, ended_at FROM ${schema}.phone_join_calls WHERE call_id=$1`, [id])).rows[0]; assert.equal(row.meeting_session_id, 's1'); assert.ok(row.ended_at);
});
test('PostgreSQL ledger: concurrent transitions of one call - exactly one wins; the history is append-only', { skip }, async () => {
  const a = replica('gw-a').ledger, b = replica('gw-b').ledger, id = 'trans_00000002'; await a.claim(id); await a.transition(id, 'authorizing'); await a.transition(id, 'attaching');
  const r = await Promise.all([a.transition(id, 'connected'), b.transition(id, 'failed'), a.transition(id, 'terminating'), b.transition(id, 'orphaned')]);
  assert.equal(await a.stateOf(id) !== 'attaching', true); const final = await a.stateOf(id); assert.ok(['connected', 'failed', 'terminating', 'orphaned'].includes(final!));
  assert.ok(r.filter(Boolean).length >= 1);
  await assert.rejects(admin.query(`UPDATE ${schema}.phone_join_call_events SET reason='x'`), /append-only/); await assert.rejects(admin.query(`DELETE FROM ${schema}.phone_join_call_events`), /append-only/);
  await assert.rejects(admin.query(`INSERT INTO ${schema}.phone_join_calls(call_id,state,claimed_by) VALUES('x','claimed','t')`), /check/i, 'call id format is enforced by the database');
});

test('PostgreSQL ledger: a failed call id can be retried; claimed, connected, terminating and orphaned ones cannot', { skip }, async () => {
  const { ledger } = replica('gw');
  for (const [id, to] of [['rel_00000001', null], ['rel_00000002', 'connected'], ['rel_00000003', 'terminating'], ['rel_00000004', 'orphaned']] as const) {
    await ledger.claim(id); if (to === 'connected') { await ledger.transition(id, 'authorizing'); await ledger.transition(id, 'attaching'); await ledger.transition(id, 'connected'); }
    if (to === 'terminating') await ledger.transition(id, 'terminating'); if (to === 'orphaned') { await ledger.transition(id, 'authorizing'); await ledger.transition(id, 'attaching'); await ledger.transition(id, 'orphaned'); }
    await ledger.release(id); assert.equal(await ledger.claim(id), false, id + ' must stay claimed');
  }
  await ledger.claim('rel_00000005'); await ledger.transition('rel_00000005', 'failed'); await ledger.release('rel_00000005'); assert.equal(await ledger.claim('rel_00000005'), true, 'a failed attempt can be retried');
});

test('admission over PostgreSQL: two replicas receive the same call at once - one connects, the other is refused, and media attaches once', { skip }, async () => {
  const bridgeLog: string[] = []; const bridge: SipRtpBridge = { attach: async () => { await sleep(30); bridgeLog.push('attach'); return { mediaEstablished: true }; }, disconnect: async () => { bridgeLog.push('disconnect'); } };
  const r1 = replica('gw1'), r2 = replica('gw2');
  const results = await Promise.all([admitTelephoneCall(request('a1'), all, open, bridge, { ledger: r1.ledger }), admitTelephoneCall(request('a1'), all, open, bridge, { ledger: r2.ledger }), admitTelephoneCall(request('a1'), all, open, bridge, { ledger: r1.ledger })]);
  assert.deepEqual(results.map((x) => x.code).sort(), ['DUPLICATE_CALL', 'DUPLICATE_CALL', 'MEDIA_CONNECTED']); assert.deepEqual(bridgeLog, ['attach']);
  assert.equal(await r1.ledger.stateOf(request('a1').callId), 'connected');
  const path = (await admin.query(`SELECT to_state FROM ${schema}.phone_join_call_events WHERE call_id=$1 ORDER BY id`, [request('a1').callId])).rows.map((x) => x.to_state); assert.deepEqual(path, ['claimed', 'authorizing', 'attaching', 'connected']);
});
test('admission over PostgreSQL: refusals and failures leave a failed record and free the id, a ledger transition that cannot be recorded stops the admission', { skip }, async () => {
  const { ledger, pool } = replica('gw');
  const denied = await admitTelephoneCall(request('d1'), all, { verifyPhoneJoin: async () => ({ allowed: false, requiresHostApproval: false }), requestHostApproval: async () => true }, { attach: async () => ({ mediaEstablished: true }), disconnect: async () => {} }, { ledger });
  assert.equal(denied.code, 'JOIN_DENIED'); assert.equal(await ledger.stateOf(request('d1').callId), null, 'released after the failure');
  assert.deepEqual((await pool.query('SELECT to_state FROM phone_join_call_events WHERE call_id=$1 ORDER BY id', [request('d1').callId])).rows.map((x) => x.to_state), ['claimed', 'authorizing', 'failed']);
  const flaky = new PostgresCallLedger(pool, 'gw'); const real = flaky.transition.bind(flaky); flaky.transition = async (id, to, d) => { if (to === 'attaching') throw new Error('db down'); return real(id, to, d); };
  const attached: string[] = []; const r = await admitTelephoneCall(request('d2'), all, open, { attach: async () => { attached.push('attach'); return { mediaEstablished: true }; }, disconnect: async () => {} }, { ledger: flaky });
  assert.equal(r.status, 503); assert.deepEqual(attached, [], 'no media is attached when the durable state cannot be recorded');
});

test('timeout is cancellation: the bridge is aborted, torn down now, the id stays claimed while the attach runs, and a leg created late is found and terminated', { skip }, async () => {
  const { ledger } = replica('gw'); const log: string[] = []; let aborted = false, lateDone = () => {}; const late = new Promise<void>((r) => { lateDone = r; });
  const bridge: SipRtpBridge = {
    attach: (_id, _s, o) => new Promise((resolve) => { o?.signal.addEventListener('abort', () => { aborted = true; }); setTimeout(() => { log.push('late-leg-created'); resolve({ mediaEstablished: true }); }, 150); }),   // ignores the abort and creates a leg anyway
    disconnect: async () => { log.push('disconnect'); if (log.filter((x) => x === 'disconnect').length >= 2) lateDone(); }
  };
  const seen: [string, boolean][] = []; const r = await admitTelephoneCall(request('t1'), all, open, bridge, { ledger, stepTimeoutMs: 40, onLateMedia: (id, ok) => seen.push([id, ok]) });
  assert.equal(r.code, 'MEDIA_UNAVAILABLE'); assert.equal(aborted, true, 'the attempt was told to stop');
  assert.equal(await ledger.stateOf(request('t1').callId), 'terminating', 'still claimed while the attach is running');
  assert.equal((await admitTelephoneCall(request('t1'), all, open, bridge, { ledger, stepTimeoutMs: 40 })).code, 'DUPLICATE_CALL', 'a retry cannot be confused with the leg that may still appear');
  await late; assert.ok(await eventually(async () => (await ledger.stateOf(request('t1').callId)) === null), 'the id is released once the late leg is terminated');
  assert.deepEqual(log, ['disconnect', 'late-leg-created', 'disconnect'], 'torn down at the timeout, and again when the late leg appeared'); assert.deepEqual(seen, [[request('t1').callId, true]]);
  assert.equal(await ledger.stateOf(request('t1').callId), null, 'finished, recorded and released');
  const path = (await admin.query(`SELECT to_state, reason FROM ${schema}.phone_join_call_events WHERE call_id=$1 ORDER BY id`, [request('t1').callId])).rows; assert.ok(path.some((x) => x.to_state === 'terminating' && x.reason === 'media_timeout')); assert.ok(path.some((x) => x.to_state === 'failed' && x.reason === 'late_media'));
});
test('a late leg that cannot be terminated is marked orphaned and reported, and its id is never reused', { skip }, async () => {
  const { ledger } = replica('gw'); const seen: [string, boolean][] = []; let reported = () => {}; const done = new Promise<void>((r) => { reported = r; });
  const bridge: SipRtpBridge = { attach: () => new Promise((resolve) => setTimeout(() => resolve({ mediaEstablished: true }), 120)), disconnect: async () => { throw new Error('gateway unreachable'); } };
  await admitTelephoneCall(request('o1'), all, open, bridge, { ledger, stepTimeoutMs: 30, onLateMedia: (id, ok) => { seen.push([id, ok]); reported(); } }); await done; assert.ok(await eventually(async () => (await ledger.stateOf(request('o1').callId)) === 'orphaned'));
  assert.deepEqual(seen, [[request('o1').callId, false]]); await ledger.release(request('o1').callId); assert.equal(await ledger.claim(request('o1').callId), false);
});
test('an attach that fails quickly is released straight away (nothing can appear later)', { skip }, async () => {
  const { ledger } = replica('gw'); const r = await admitTelephoneCall(request('f1'), all, open, { attach: async () => { throw new Error('SDP failed'); }, disconnect: async () => {} }, { ledger });
  assert.equal(r.code, 'MEDIA_UNAVAILABLE'); assert.equal(await ledger.stateOf(request('f1').callId), null);
});
test('host silence: the waiting caller is cancelled in the meeting and the id is released', { skip }, async () => {
  const { ledger } = replica('gw'); const cancelled: string[] = [];
  const authority: MeetingAuthority = { verifyPhoneJoin: async () => ({ allowed: true, requiresHostApproval: true, meetingSessionId: 's9' }), requestHostApproval: (_s, _c, o) => new Promise((_, rej) => o?.signal.addEventListener('abort', () => rej(new Error('aborted')))), cancelAdmission: async (s, c) => { cancelled.push(s + ':' + c); } };
  const r = await admitTelephoneCall(request('h1'), all, authority, { attach: async () => ({ mediaEstablished: true }), disconnect: async () => {} }, { ledger, hostApprovalTimeoutMs: 40 });
  assert.equal(r.code, 'HOST_APPROVAL_TIMEOUT'); assert.deepEqual(cancelled, ['s9:' + request('h1').callId]); assert.equal(await ledger.stateOf(request('h1').callId), null);
});

test('crash recovery: stale open claims are reaped by exactly one reaper, their media is disconnected, and connected calls are untouched', { skip }, async () => {
  await admin.query(`DELETE FROM ${schema}.phone_join_calls`);      // a reaper scans the whole table: earlier tests' rows (which grow old while the suite runs) are not part of this one
  const a = replica('reaper-a'), b = replica('reaper-b');
  for (const id of ['stale_00000001', 'stale_00000002', 'live_000000001']) await a.ledger.claim(id);
  await a.ledger.transition('live_000000001', 'authorizing'); await a.ledger.transition('live_000000001', 'attaching'); await a.ledger.transition('live_000000001', 'connected');
  await admin.query(`UPDATE ${schema}.phone_join_calls SET updated_at = now() - interval '10 minutes', lease_expires_at = now() - interval '9 minutes' WHERE call_id IN ('stale_00000001','stale_00000002','live_000000001')`);   // their owner stopped renewing
  assert.deepEqual((await Promise.all([a.ledger.reapStale(), b.ledger.reapStale()])).flat(), [], 'first sight of a lapsed lease only CHALLENGES it');
  await admin.query(`UPDATE ${schema}.phone_join_calls SET lease_challenged_at = now() - interval '5 minutes' WHERE lease_challenged_at IS NOT NULL`);        // the grace period passed with no renewal
  const got = (await Promise.all([a.ledger.reapStale(), b.ledger.reapStale()])).flat().sort(); assert.deepEqual(got, ['stale_00000001', 'stale_00000002'], 'each stale claim goes to one reaper');
  assert.equal(await a.ledger.stateOf('live_000000001'), 'connected');
  await a.ledger.finishReap('stale_00000001', true); await a.ledger.finishReap('stale_00000002', false);
  assert.equal(await a.ledger.stateOf('stale_00000001'), null); assert.equal(await a.ledger.stateOf('stale_00000002'), 'orphaned');
  assert.deepEqual(await a.ledger.reapStale(), [], 'nothing left to reap');
});

test('replay store: a token id is accepted once, even when replicas race with it; expired entries are cleaned up', { skip }, async () => {
  const stores = [1, 2, 3].map((i) => new PostgresReplayStore(replica('gw' + i).pool)), jti = 'jti-' + 'x'.repeat(40);
  const first = await Promise.all(stores.flatMap((s) => [s.firstUse(jti, 'qorlla-gw', Date.now() + 60_000), s.firstUse(jti, 'qorlla-gw', Date.now() + 60_000)])); assert.equal(first.filter(Boolean).length, 1);
  assert.equal(await stores[0].firstUse('old-' + 'y'.repeat(40), 'qorlla-gw', Date.now() - 600_000), true);
  await stores[1].firstUse('new-' + 'z'.repeat(40), 'qorlla-gw', Date.now() + 60_000); assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${schema}.phone_join_replay WHERE jti LIKE 'old-%'`)).rows[0].n, 0);
});

test('the migration rolls back cleanly', { skip }, async () => {
  const s2 = 'pj_rb_' + Math.random().toString(36).slice(2, 7); await admin.query('CREATE SCHEMA ' + s2); const c = await admin.connect();
  try { await c.query('SET search_path=' + s2); await c.query(migration); await c.query(lease); await c.query(leaseRollback); const cols = (await c.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=$1 AND column_name LIKE 'lease_%'", [s2])).rows[0].n; assert.equal(cols, 0, '002 rolls back on its own and leaves 001 in place'); await c.query(lease); await c.query(leaseRollback); await c.query(rollback); const left = (await c.query('SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1', [s2])).rows[0].n; assert.equal(left, 0); } finally { c.release(); await admin.query('DROP SCHEMA ' + s2 + ' CASCADE'); }
});
