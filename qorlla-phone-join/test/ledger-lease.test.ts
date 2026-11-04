import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import type { CallState, SipRtpBridge } from '../src/admission.js';
import { PostgresCallLedger, type LossReason } from '../src/ledger-pg.js';
import { startLeaseKeeper } from '../src/compose.js';

// Gate A5.1: ownership lease, generation fencing, per-state deadlines. Deterministic: time is moved by editing the rows (the database clock is the authority) or by an injected clock; races are made to happen in a
// chosen order with row locks and explicit awaits, never with sleeps. Needs PostgreSQL (PHONE_JOIN_TEST_DATABASE_URL); skipped, and reported as skipped, without it.
const URL_ = process.env.PHONE_JOIN_TEST_DATABASE_URL, skip = URL_ ? false : 'PHONE_JOIN_TEST_DATABASE_URL is not set';
const sqlDir = path.join(import.meta.dirname, '..', '..', 'sql'), SQL = ['001_phone_join.sql', '002_phone_join_lease.sql'].map((f) => fs.readFileSync(path.join(sqlDir, f), 'utf8')).join('\n');
let schema = '', admin: pg.Pool; const pools: pg.Pool[] = []; let n = 0;
const replica = (name: string, o: ConstructorParameters<typeof PostgresCallLedger>[2] = {}) => { const pool = new pg.Pool({ connectionString: URL_, options: '-c search_path=' + schema, max: 8 }); pools.push(pool); return { pool, ledger: new PostgresCallLedger(pool, name, o) }; };
test.before(async () => { if (!URL_) return; schema = 'pj_ls_' + Math.random().toString(36).slice(2, 8); admin = new pg.Pool({ connectionString: URL_ }); await admin.query('CREATE SCHEMA ' + schema); const c = await admin.connect(); try { await c.query('SET search_path=' + schema); await c.query(SQL); } finally { c.release(); } });
test.beforeEach(async () => { if (URL_) await admin.query(`DELETE FROM ${schema}.phone_join_calls`); });      // a reaper scans the whole table: every test starts with only its own calls
test.after(async () => { if (!URL_) return; for (const p of pools) await p.end().catch(() => undefined); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); });

const PATH: Record<string, CallState[]> = { claimed: [], authorizing: ['authorizing'], awaiting_host: ['authorizing', 'awaiting_host'], attaching: ['authorizing', 'attaching'], connected: ['authorizing', 'attaching', 'connected'], terminating: ['authorizing', 'attaching', 'terminating'] };
const id = (tag: string) => 'ls_' + tag + '_' + String(++n).padStart(4, '0');
/** A call owned by `ledger`, moved to `state` through the real transitions. */
const make = async (ledger: PostgresCallLedger, tag: string, state: keyof typeof PATH) => { const c = id(tag); assert.equal(await ledger.claim(c), true); for (const s of PATH[state]) assert.equal(await ledger.transition(c, s, { meetingSessionId: 'sess.1' }), true); return c; };
const row = async (c: string) => (await admin.query(`SELECT state, lease_owner, lease_generation::int AS gen, lease_expires_at > now() AS live, lease_challenged_at IS NOT NULL AS challenged FROM ${schema}.phone_join_calls WHERE call_id=$1`, [c])).rows[0];
const events = async (c: string) => (await admin.query(`SELECT to_state, reason, actor FROM ${schema}.phone_join_call_events WHERE call_id=$1 ORDER BY id`, [c])).rows;
/** The owner stopped renewing long ago: the state deadline and the lease are both far in the past. */
const lapse = (c: string, ageSecs = 600) => admin.query(`UPDATE ${schema}.phone_join_calls SET updated_at = now() - make_interval(secs => $2::float8), lease_expires_at = now() - interval '9 minutes' WHERE call_id=$1`, [c, ageSecs]);
/** The reaper's challenge happened long enough ago that the grace period is over. */
const graceOver = (c: string) => admin.query(`UPDATE ${schema}.phone_join_calls SET lease_challenged_at = now() - interval '5 minutes' WHERE call_id=$1 AND lease_challenged_at IS NOT NULL`, [c]);
const bridge = () => { const gone: string[] = []; const b: SipRtpBridge & { gone: string[] } = { gone, attach: async () => ({ mediaEstablished: true }), disconnect: async (x) => { gone.push(x); } }; return b; };

test('a slow, legitimate attachment survives for as long as its owner keeps (or promptly regains) the lease', { skip }, async () => {
  const a = replica('gw-a').ledger, reaper = replica('reaper').ledger, c = await make(a, 'slow', 'attaching');
  await admin.query(`UPDATE ${schema}.phone_join_calls SET updated_at = now() - interval '10 minutes' WHERE call_id=$1`, [c]);     // far past the attaching deadline, but the owner is healthy
  assert.deepEqual(await reaper.reapStale(), [], 'deadline passed, lease live: nothing to do'); assert.equal((await row(c)).challenged, false, 'not even challenged');
  await lapse(c);                                                                                                                  // now the renewal is DELAYED (lease lapsed)
  assert.deepEqual(await reaper.reapStale(), [], 'a lapsed lease is only a question'); assert.equal((await row(c)).challenged, true);
  assert.equal(await a.renew(c), true, 'the owner answers: renewed'); const r = await row(c); assert.equal(r.challenged, false, 'the challenge is gone'); assert.equal(r.live, true);
  await graceOver(c); assert.deepEqual(await reaper.reapStale(), [], 'nothing left to take, even after the grace period'); assert.equal(await a.transition(c, 'connected'), true, 'and the attach completes');
  assert.deepEqual((await events(c)).map((e) => e.to_state), ['claimed', 'authorizing', 'attaching', 'connected']);
});

test('a gateway that crashes during attachment: the orphan is eventually taken over (new generation), released, and the id is reusable', { skip }, async () => {
  const dead = replica('gw-dead').ledger, reaper = replica('reaper').ledger, c = await make(dead, 'crash', 'attaching'); await lapse(c);
  assert.deepEqual(await reaper.reapStale(), []); await graceOver(c); assert.deepEqual(await reaper.reapStale(), [c]);
  const r = await row(c); assert.deepEqual([r.state, r.lease_owner, r.gen], ['terminating', 'reaper', 2], 'terminating, owned by the reaper, generation 2'); assert.equal(reaper.generationOf(c), 2);
  assert.equal(await reaper.finishReap(c, true), true); assert.equal(await row(c), undefined, 'released'); assert.equal(await reaper.claim(c), true, 'the id works again');
  assert.deepEqual((await events(c)).slice(0, 5).map((e) => [e.to_state, e.reason]), [['claimed', null], ['authorizing', null], ['attaching', null], ['terminating', 'stale_claim'], ['failed', 'reaped']]);
});

test('an old gateway that resumes after a takeover is rejected: its writes change nothing, it learns it lost the call, and its keeper stops the leg', { skip }, async () => {
  const old = replica('gw-old').ledger, reaper = replica('reaper').ledger, lost: [string, LossReason][] = []; old.onLost((x, why) => lost.push([x, why]));
  const c = await make(old, 'old', 'attaching'); await lapse(c); await reaper.reapStale(); await graceOver(c); assert.deepEqual(await reaper.reapStale(), [c]); const before = (await events(c)).length;
  assert.equal(await old.transition(c, 'connected', { meetingSessionId: 'sess.1' }), false, 'a stale generation cannot move the call'); assert.deepEqual(lost, [[c, 'fenced']]); assert.equal(old.generationOf(c), undefined);
  const r = await row(c); assert.deepEqual([r.state, r.lease_owner, r.gen], ['terminating', 'reaper', 2], 'the row is the new owner\'s'); assert.equal((await events(c)).length, before, 'and no history was written');
  assert.equal(await reaper.finishReap(c, true), true, 'the new owner settles it');
  // the same through the keeper: a second old gateway only renews
  const old2 = replica('gw-old2').ledger, br = bridge(), reasons: LossReason[] = []; const keeper = startLeaseKeeper({ ledger: old2, bridge: br, intervalMs: 3_600_000, onLost: (_, why) => reasons.push(why), log: { error() {} } });
  const c2 = await make(old2, 'old', 'attaching'); await lapse(c2); await reaper.reapStale(); await graceOver(c2); assert.deepEqual(await reaper.reapStale(), [c2]);
  await keeper.tick(); await new Promise((r2) => setImmediate(r2)); assert.deepEqual(br.gone, [c2], 'the keeper noticed (renewal rejected) and stopped the local leg'); assert.deepEqual(reasons, ['lost']); assert.deepEqual(old2.heldCalls(), []); keeper.stop();
  assert.equal(await old2.renew(c2), false, 'and it never renews a call it does not hold');
});

test('an administrative end of a CONNECTED call by another replica takes it over; the original owner is fenced; other states cannot be taken that way', { skip }, async () => {
  const owner = replica('gw-owner').ledger, shield = replica('shield-node').ledger, c = await make(owner, 'adm', 'connected'), w = await make(owner, 'adm', 'attaching');
  assert.equal(await shield.transition(w, 'terminating'), false, 'an attaching call belongs to its owner (or to a reaper)'); assert.equal((await row(w)).gen, 1);
  assert.equal(await shield.transition(c, 'ended'), false, 'a replica that never owned it cannot simply declare it ended'); assert.equal(await shield.transition(c, 'terminating', { reason: 'shield' }), true); assert.equal((await row(c)).gen, 2);
  assert.equal(await shield.transition(c, 'ended'), true); assert.equal(await owner.transition(c, 'ended'), false, 'the old owner holds generation 1: fenced (and the call is final anyway)');
});

test('two reapers racing for the same call: at most one successful takeover', { skip }, async () => {
  const owner = replica('gw-dead').ledger, reapers = [1, 2, 3, 4].map((i) => replica('reaper' + i).ledger);
  for (let k = 0; k < 12; k++) {
    const c = await make(owner, 'race', 'attaching'); await lapse(c); await Promise.all(reapers.map((r) => r.reapStale())); await graceOver(c);
    const won = (await Promise.all(reapers.map((r) => r.reapStale()))).flat().filter((x) => x === c); assert.equal(won.length, 1, 'iteration ' + k); assert.equal((await row(c)).gen, 2, 'exactly one generation step');
    assert.equal(reapers.filter((r) => r.generationOf(c) === 2).length, 1, 'and exactly one reaper believes it owns the call');
  }
});

test('renewal overlapping reaping: no incorrect release, in either order, and under real concurrency', { skip }, async () => {
  const a = replica('gw-a').ledger, reaper = replica('reaper').ledger;
  // order 1 - the renewal is already IN FLIGHT (it holds the row lock): the reaper must skip the row, and the renewal then wins
  const c1 = await make(a, 'ov', 'attaching'); await lapse(c1); await reaper.reapStale(); await graceOver(c1);
  const lock = await admin.connect();
  try {
    await lock.query('BEGIN'); await lock.query(`SELECT 1 FROM ${schema}.phone_join_calls WHERE call_id=$1 FOR UPDATE`, [c1]);
    assert.deepEqual(await reaper.reapStale(), [], 'locked row: skipped, not stolen');
    await lock.query(`UPDATE ${schema}.phone_join_calls SET lease_expires_at = now() + interval '15 seconds', lease_challenged_at = NULL WHERE call_id=$1`, [c1]); await lock.query('COMMIT');
  } finally { lock.release(); }
  assert.deepEqual(await reaper.reapStale(), [], 'renewal committed first: nothing to take'); assert.deepEqual([(await row(c1)).gen, (await row(c1)).state], [1, 'attaching']); assert.equal(await a.renew(c1), true);
  // order 2 - the reaper commits first: the late renewal is rejected
  const c2 = await make(a, 'ov', 'attaching'); await lapse(c2); await reaper.reapStale(); await graceOver(c2); assert.deepEqual(await reaper.reapStale(), [c2]); assert.equal(await a.renew(c2), false, 'late renewal: lost');
  // real concurrency: whichever statement gets the row lock first, the outcome is consistent (renewed XOR taken)
  let renewed = 0, taken = 0;
  for (let k = 0; k < 25; k++) {
    const c = await make(a, 'cc', 'attaching'); await lapse(c); await reaper.reapStale(); await graceOver(c);
    const [ok, took] = await Promise.all([a.renew(c), reaper.reapStale()]); const r = await row(c);
    if (took.includes(c)) { taken++; assert.equal(ok, false, 'taken: the renewal must have been rejected'); assert.deepEqual([r.state, r.lease_owner, r.gen], ['terminating', 'reaper', 2]); }
    else { renewed++; assert.equal(ok, true); assert.deepEqual([r.state, r.lease_owner, r.gen, r.live], ['attaching', 'gw-a', 1, true]); }
  }
  assert.equal(renewed + taken, 25);
});

test('database outage: no ownership change on either side, nothing is assumed, and the owner stops a not-yet-connected leg only after a full lease period without confirmation', { skip }, async () => {
  let now = 0; const owner = replica('gw-out', { lease: { leaseMs: 10_000, graceMs: 10_000 }, clock: () => now }), br = bridge(), reasons: LossReason[] = [];
  const att = await make(owner.ledger, 'out', 'attaching'), live = await make(owner.ledger, 'out', 'connected'); const keeper = startLeaseKeeper({ ledger: owner.ledger, bridge: br, intervalMs: 3_600_000, onLost: (_, w) => reasons.push(w), log: { error() {} } });
  await keeper.tick(); assert.deepEqual(owner.ledger.unconfirmed(), []); const watcher = replica('reaper');
  await owner.pool.end();                                                                                                           // the database becomes unreachable for the owner
  now = 9_000; await keeper.tick(); assert.deepEqual(br.gone, [], 'nine seconds into a ten second lease: still running'); assert.deepEqual(owner.ledger.heldCalls().sort(), [att, live].sort(), 'ownership untouched');
  const ra = await owner.ledger.renewAll(); assert.deepEqual([ra.renewed, ra.lost, ra.unavailable.sort()], [[], [], [att, live].sort()], 'every renewal is reported unavailable, none lost');
  now = 10_000; await keeper.tick(); assert.deepEqual(br.gone, [att], 'a full lease period unconfirmed: the attaching leg is stopped locally'); assert.deepEqual(reasons, ['unconfirmed']); assert.deepEqual(owner.ledger.heldCalls(), [live], 'the connected call keeps running (Meet governs it)'); keeper.stop();
  assert.equal((await row(att)).gen, 1, 'the row was not changed by the outage'); assert.equal((await row(att)).state, 'attaching');
  // a reaper that loses the database mid-reap changes nothing either
  await lapse(att); await watcher.ledger.reapStale(); await graceOver(att); await watcher.pool.end(); await assert.rejects(() => watcher.ledger.reapStale()); assert.deepEqual([(await row(att)).state, (await row(att)).gen], ['attaching', 1]); assert.deepEqual(watcher.ledger.heldCalls(), [], 'and believes it owns nothing');
});

test('a connected call that exceeds every attach deadline stays connected (a lapsed lease on it is never grounds to reap)', { skip }, async () => {
  const a = replica('gw-a').ledger, reaper = replica('reaper').ledger, c = await make(a, 'conn', 'connected'); await lapse(c, 86_400);
  for (let k = 0; k < 3; k++) { assert.deepEqual(await reaper.reapStale(), []); await graceOver(c); } assert.deepEqual([(await row(c)).state, (await row(c)).gen], ['connected', 1]); assert.equal(await a.renew(c), true, 'and its owner can still renew it');
});

test('per-state deadlines: each state is judged by its own rule', { skip }, async () => {
  const a = replica('gw-dead').ledger, reaper = replica('reaper').ledger, d = { claimed: 30, authorizing: 30, awaiting_host: 300, attaching: 60, terminating: 120 };
  const calls: Record<string, string> = {}; for (const s of Object.keys(d)) { calls[s] = await make(a, 'st', s as keyof typeof PATH); await lapse(calls[s], 100); }                       // all 100 s old, all leases lapsed
  await reaper.reapStale(); for (const c of Object.values(calls)) await graceOver(c);
  const taken = (await reaper.reapStale()).sort(); assert.deepEqual(taken, [calls.claimed, calls.authorizing, calls.attaching].sort(), '100 s is past claimed/authorizing/attaching, but within awaiting_host (a person is answering) and terminating (teardown under way)');
  await lapse(calls.awaiting_host, 400); await lapse(calls.terminating, 200); await reaper.reapStale(); await graceOver(calls.awaiting_host); await graceOver(calls.terminating);
  assert.deepEqual((await reaper.reapStale()).sort(), [calls.awaiting_host, calls.terminating].sort(), 'older than their own deadlines, they go too'); assert.equal((await events(calls.terminating)).at(-1)?.reason, 'stale_terminating', 'a stuck teardown is taken over as such');
  const tight = await make(a, 'st', 'awaiting_host'); await lapse(tight, 100); const cfg = { deadlines: { awaiting_host: 50_000 } }; assert.deepEqual(await reaper.reapStale(cfg), []); await graceOver(tight); assert.deepEqual(await reaper.reapStale(cfg), [tight], 'deadlines are configurable per state');
});

test('repeated cleanup is idempotent: one terminal event, nothing released twice, and a leftover failed row is purged by the released rule', { skip }, async () => {
  const dead = replica('gw-dead').ledger, reaper = replica('reaper').ledger, c = await make(dead, 'idem', 'attaching'); await lapse(c); await reaper.reapStale(); await graceOver(c); assert.deepEqual(await reaper.reapStale(), [c]);
  assert.equal(await reaper.finishReap(c, true), true); assert.equal(await reaper.finishReap(c, true), false, 'second settle: no-op'); assert.deepEqual(await reaper.reapStale(), []); assert.deepEqual(await reaper.reapStale(), []);
  assert.equal((await events(c)).filter((e) => e.to_state === 'failed').length, 1, 'exactly one terminal event'); assert.equal((await events(c)).filter((e) => e.to_state === 'terminating').length, 1);
  // the process died between `failed` and the release: the id would stay blocked, so the released rule purges the row after its retention
  const x = await make(dead, 'idem', 'attaching'); assert.equal(await dead.transition(x, 'failed', { reason: 'x' }), true); assert.equal(await dead.claim(x), false, 'blocked while the failed row stays');
  assert.equal(await reaper.purgeReleased(3_600_000), 0, 'too recent'); await admin.query(`UPDATE ${schema}.phone_join_calls SET ended_at = now() - interval '2 hours' WHERE call_id=$1`, [x]);
  assert.equal(await reaper.purgeReleased(3_600_000), 1); assert.equal(await reaper.purgeReleased(3_600_000), 0, 'repeating changes nothing'); assert.equal(await dead.claim(x), true, 'the id is usable again');
});

test('the lease migration upgrades rows written before it (owned by their claimant, already lapsed) and stays idempotent', { skip }, async () => {
  const s2 = 'pj_up_' + Math.random().toString(36).slice(2, 7); await admin.query('CREATE SCHEMA ' + s2); const cn = await admin.connect();
  try {
    await cn.query('SET search_path=' + s2); await cn.query(fs.readFileSync(path.join(sqlDir, '001_phone_join.sql'), 'utf8')); await cn.query("INSERT INTO phone_join_calls(call_id, state, claimed_by) VALUES('legacy_000001','attaching','old-gw')");
    const lease = fs.readFileSync(path.join(sqlDir, '002_phone_join_lease.sql'), 'utf8'); await cn.query(lease); await cn.query(lease);
    const r = (await cn.query("SELECT lease_owner, lease_generation::int AS g, lease_expires_at <= now() AS lapsed FROM phone_join_calls WHERE call_id='legacy_000001'")).rows[0]; assert.deepEqual(r, { lease_owner: 'old-gw', g: 1, lapsed: true });
  } finally { cn.release(); await admin.query('DROP SCHEMA ' + s2 + ' CASCADE'); }
});
