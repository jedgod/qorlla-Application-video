import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import type { CallState, MeetingAuthority, SipRtpBridge } from '../src/admission.js';
import { PostgresCallLedger } from '../src/ledger-pg.js';
import { startReaper } from '../src/compose.js';

// A5.5 B4 - cleanup of a CONNECTED call whose gateway died. A stale lease says the OWNER is gone, never that the CALL is over: the cleanup takeover is fenced (generation + 1), and nothing is released or marked ended
// until Meet itself says the call is over. Deterministic: time is moved by editing rows (the database clock is the authority), Meet's answers are scripted, no sleeps. Needs PostgreSQL (PHONE_JOIN_TEST_DATABASE_URL).
const URL_ = process.env.PHONE_JOIN_TEST_DATABASE_URL, skip = URL_ ? false : 'PHONE_JOIN_TEST_DATABASE_URL is not set';
const sqlDir = path.join(import.meta.dirname, '..', '..', 'sql'), SQL = ['001_phone_join.sql', '002_phone_join_lease.sql'].map((f) => fs.readFileSync(path.join(sqlDir, f), 'utf8')).join('\n');
let schema = '', admin: pg.Pool; const pools: pg.Pool[] = []; let n = 0;
const replica = (name: string) => { const pool = new pg.Pool({ connectionString: URL_, options: '-c search_path=' + schema, max: 8 }); pools.push(pool); return new PostgresCallLedger(pool, name, { lease: { leaseMs: 15_000, graceMs: 15_000 } }); };
test.before(async () => { if (!URL_) return; schema = 'pj_lc_' + Math.random().toString(36).slice(2, 8); admin = new pg.Pool({ connectionString: URL_ }); await admin.query('CREATE SCHEMA ' + schema); const c = await admin.connect(); try { await c.query('SET search_path=' + schema); await c.query(SQL); } finally { c.release(); } });
test.beforeEach(async () => { if (URL_) await admin.query(`DELETE FROM ${schema}.phone_join_calls`); });
test.after(async () => { if (!URL_) return; for (const p of pools) await p.end().catch(() => undefined); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); });
const row = async (c: string) => (await admin.query(`SELECT state, reason, lease_owner, lease_generation::int AS gen FROM ${schema}.phone_join_calls WHERE call_id=$1`, [c])).rows[0];
const events = async (c: string) => (await admin.query(`SELECT from_state, to_state, reason FROM ${schema}.phone_join_call_events WHERE call_id=$1 ORDER BY id`, [c])).rows;
const connected = async (l: PostgresCallLedger) => { const c = 'lc_call_' + String(++n).padStart(4, '0'); assert.equal(await l.claim(c), true); for (const s of ['authorizing', 'attaching', 'connected'] as CallState[]) assert.equal(await l.transition(c, s, { meetingSessionId: 'sess.1' }), true); return c; };
const died = (c: string) => admin.query(`UPDATE ${schema}.phone_join_calls SET updated_at = now() - interval '1 hour', lease_expires_at = now() - interval '10 minutes' WHERE call_id=$1`, [c]);
const graceOver = (c: string) => admin.query(`UPDATE ${schema}.phone_join_calls SET lease_challenged_at = now() - interval '5 minutes' WHERE call_id=$1 AND lease_challenged_at IS NOT NULL`, [c]);
type MeetSays = 'live' | 'over' | 'unknown' | 'throws';
/** Meet, scripted: what it answers when asked where a call stands, and what happens when it is asked to end it. */
const meet = (says: MeetSays | (() => MeetSays), o: { endWorks?: boolean } = {}) => {
  const asked: string[] = [], ended: string[] = []; let cur: MeetSays = typeof says === 'function' ? says() : says, ask = typeof says === 'function' ? says : () => cur;
  const a: MeetingAuthority & { callState(s: string, c: string): Promise<'live' | 'over' | 'unknown'>; asked: string[]; ended: string[]; set(x: MeetSays): void } = {
    asked, ended, set: (x) => { cur = x; ask = () => cur; },
    verifyPhoneJoin: async () => ({ allowed: false, requiresHostApproval: false }), requestHostApproval: async () => false,
    cancelAdmission: async (_s, id) => { ended.push(id); if (o.endWorks !== false) cur = 'over'; },
    callState: async (_s, id) => { asked.push(id); const v = ask(); if (v === 'throws') throw new Error('meet unreachable'); return v; } };
  return a;
};
const bridge = () => { const gone: string[] = []; const b: SipRtpBridge & { gone: string[] } = { gone, attach: async () => ({ mediaEstablished: true }), disconnect: async (x) => { gone.push(x); } }; return b; };
const reaper = (l: PostgresCallLedger, a: ReturnType<typeof meet>, extra: Partial<Parameters<typeof startReaper>[0]> = {}) => startReaper({ ledger: l, bridge: bridge(), authority: a, intervalMs: 3_600_000, log: { error() { /* expected in the failure cases */ } }, ...extra });
/** The gateway died while the call was connected; the survivor's reaper has challenged the lease and the grace period is over. */
const readyForTakeover = async (survivor: ReturnType<typeof reaper>, c: string) => { await died(c); assert.deepEqual(await survivor.tick(), [], 'first sight is only a challenge'); await graceOver(c); };

test('CLEANUP 1 - reconciled: Meet says the call is over -> the survivor takes it over (generation + 1), asks Meet FIRST, then marks it ended; the trail shows connected -> terminating(stale_connected) -> ended', { skip }, async () => {
  const dead = replica('gw-dead'), live = replica('gw-survivor'), m = meet('over'), r = reaper(live, m), c = await connected(dead); await readyForTakeover(r, c);
  assert.deepEqual(await r.tick(), [c]); assert.deepEqual(m.asked, [c], 'Meet was asked before anything was released'); const x = await row(c); assert.deepEqual({ state: x.state, owner: x.lease_owner, gen: x.gen, reason: x.reason }, { state: 'ended', owner: 'gw-survivor', gen: 2, reason: 'reconciled_stale_connected' });
  assert.deepEqual((await events(c)).map((e) => e.to_state + (e.reason ? ':' + e.reason : '')).slice(-2), ['terminating:stale_connected', 'ended:reconciled_stale_connected']);
});

test('CLEANUP 2 - Meet still says LIVE: the survivor asks Meet to end the call (idempotent), asks again, and only then marks it ended; if Meet cannot end it the call stays terminating (never ended)', { skip }, async () => {
  const dead = replica('gw-dead-2'), live = replica('gw-survivor-2'), m = meet('live'), r = reaper(live, m), c = await connected(dead); await readyForTakeover(r, c);
  assert.deepEqual(await r.tick(), [c]); assert.deepEqual(m.ended, [c], 'Meet was asked to end it once'); assert.equal((await row(c)).state, 'ended');
  const dead2 = replica('gw-dead-3'), stuck = meet('live', { endWorks: false }), r2 = reaper(replica('gw-survivor-3'), stuck), c2 = await connected(dead2); await readyForTakeover(r2, c2);
  assert.deepEqual(await r2.tick(), [], 'Meet refuses to end it: nothing is released'); const y = await row(c2); assert.deepEqual([y.state, y.reason], ['terminating', 'stale_connected']);
});

test('CLEANUP 3 - Meet UNREACHABLE: the call stays terminating (recoverable), is retried on later ticks, ends as soon as Meet answers - and past the bound it is ORPHANED for an operator, never marked ended', { skip }, async () => {
  const dead = replica('gw-dead-4'), live = replica('gw-survivor-4'), m = meet('throws'), r = reaper(live, m, { cleanupAttempts: 4 }), c = await connected(dead); await readyForTakeover(r, c);
  for (let i = 0; i < 3; i++) { assert.deepEqual(await r.tick(), []); const x = await row(c); assert.deepEqual([x.state, x.reason], ['terminating', 'stale_connected'], 'attempt ' + (i + 1) + ': kept, not ended'); }
  m.set('over'); assert.deepEqual(await r.tick(), [c], 'Meet is back and says over: the retry finishes it'); assert.equal((await row(c)).state, 'ended');
  const dead2 = replica('gw-dead-5'), orphans: string[] = [], m2 = meet('unknown'), r2 = reaper(replica('gw-survivor-5'), m2, { cleanupAttempts: 3, onOrphan: (x) => orphans.push(x) }), c2 = await connected(dead2); await readyForTakeover(r2, c2);
  for (let i = 0; i < 3; i++) await r2.tick(); const z = await row(c2); assert.equal(z.state, 'orphaned', 'bounded: after 3 unconfirmed attempts an operator must act'); assert.equal(z.reason, 'cleanup_unconfirmed', 'the reason says only that the cleanup could not be confirmed'); assert.deepEqual(orphans, [c2]); assert.notEqual(z.state, 'ended');
});

test('CLEANUP 4 - CONCURRENT reapers: two survivors tick at the same moment; exactly ONE takeover happens, the call is ended once, the trail has one cleanup', { skip }, async () => {
  const dead = replica('gw-dead-6'), a = replica('gw-survivor-6a'), b = replica('gw-survivor-6b'), m = meet('over'), ra = reaper(a, m), rb = reaper(b, m), c = await connected(dead);
  await died(c); await ra.tick(); await rb.tick(); await graceOver(c);
  const [x, y] = await Promise.all([ra.tick(), rb.tick()]); assert.equal(x.length + y.length, 1, 'one reaper did the cleanup (' + JSON.stringify([x, y]) + ')');
  const t = await events(c); assert.equal(t.filter((e) => e.reason === 'stale_connected').length, 1, 'one takeover'); assert.equal(t.filter((e) => e.to_state === 'ended').length, 1, 'one ending'); assert.equal((await row(c)).state, 'ended');
});

test('CLEANUP 5 - the OLD owner is fenced: after the takeover it cannot renew, resume or change the call, even if it comes back; and a finished cleanup is idempotent (more ticks change nothing)', { skip }, async () => {
  const dead = replica('gw-dead-7'), live = replica('gw-survivor-7'), m = meet('over'), r = reaper(live, m), c = await connected(dead); await readyForTakeover(r, c); assert.deepEqual(await r.tick(), [c]);
  assert.equal(await dead.renew(c), false); assert.equal(await dead.transition(c, 'connected'), false, 'cannot resume'); assert.equal(await dead.transition(c, 'ended'), false, 'cannot write'); assert.equal(await dead.transition(c, 'terminating'), false);
  const before = await events(c); assert.deepEqual(await r.tick(), []); assert.deepEqual(await r.tick(), []); assert.deepEqual(await events(c), before, 'repeating changes nothing'); assert.equal(m.asked.length, 1, 'and Meet is not asked again');
});

test('CLEANUP 6 - the survivor DIES mid-cleanup: a third reaper takes the cleanup over, still knows it was a connected call (stale_connected is kept, not downgraded), reconciles with Meet and finishes', { skip }, async () => {
  const dead = replica('gw-dead-8'), s1 = replica('gw-survivor-8a'), s2 = replica('gw-survivor-8b'), down = meet('throws'), r1 = reaper(s1, down), c = await connected(dead); await readyForTakeover(r1, c);
  assert.deepEqual(await r1.tick(), []); assert.equal((await row(c)).lease_owner, 'gw-survivor-8a');                                  // taken over, Meet unreachable, the survivor now "dies" (never ticks again)
  const up = meet('over'), r2 = reaper(s2, up); await died(c); assert.deepEqual(await r2.tick(), []); await graceOver(c); assert.deepEqual(await r2.tick(), [c]);
  const x = await row(c); assert.deepEqual({ state: x.state, owner: x.lease_owner, gen: x.gen }, { state: 'ended', owner: 'gw-survivor-8b', gen: 3 }); assert.ok((await events(c)).some((e) => e.reason === 'stale_connected' && e.to_state === 'terminating'));
  assert.equal((await events(c)).filter((e) => e.reason === 'stale_terminating').length, 0, 'never downgraded to a plain stale terminating call, which would skip the reconciliation');
});

test('CLEANUP 7 (safety) - a connected call whose owner is ALIVE is never touched by the cleanup, however often the reapers tick', { skip }, async () => {
  const owner = replica('gw-owner'), live = replica('gw-survivor-9'), m = meet('over'), r = reaper(live, m), c = await connected(owner);
  await admin.query(`UPDATE ${schema}.phone_join_calls SET updated_at = now() - interval '3 hours' WHERE call_id=$1`, [c]); for (let i = 0; i < 3; i++) assert.deepEqual(await r.tick(), []);
  await graceOver(c); assert.deepEqual(await r.tick(), []); assert.equal((await row(c)).state, 'connected'); assert.deepEqual(m.asked, [], 'Meet was never even asked');
});

test('CLEANUP 8 - an ORPHANED cleanup stays visible and is never released: the call id cannot be claimed, release() and the purge leave it, the reaper and the keeper do not touch it, an operator can list it, and nothing implies that media was terminated', { skip }, async () => {
  const dead = replica('gw-dead-10'), live = replica('gw-survivor-10'), orphans: string[] = [], r = reaper(live, meet('unknown'), { cleanupAttempts: 2, onOrphan: (x) => orphans.push(x) }), c = await connected(dead); await readyForTakeover(r, c);
  await r.tick(); await r.tick(); const x = await row(c); assert.deepEqual([x.state, x.reason], ['orphaned', 'cleanup_unconfirmed']); assert.deepEqual(orphans, [c]);
  assert.equal(await live.claim(c), false, 'the call id is still taken'); assert.equal(await replica('gw-other').claim(c), false);
  await live.release(c); assert.equal((await row(c)).state, 'orphaned', 'release() frees only failed calls');
  await admin.query(`UPDATE ${schema}.phone_join_calls SET ended_at = now() - interval '2 days', updated_at = now() - interval '2 days' WHERE call_id=$1`, [c]); assert.equal(await live.purgeReleased(1000), 0, 'the purge only ever removes failed rows'); assert.equal((await row(c)).state, 'orphaned');
  assert.deepEqual(await reaper(replica('gw-third'), meet('over')).tick(), [], 'no reaper picks an orphan up again'); assert.equal(await live.renew(c), false, 'and nothing renews it back to life');
  const listed = await live.listOrphans(); assert.deepEqual(listed.filter((o) => o.callId === c).map((o) => [o.callId, o.reason]), [[c, 'cleanup_unconfirmed']], 'an operator can see it');
  assert.ok((await events(c)).every((e) => e.to_state !== 'ended' && e.to_state !== 'failed'), 'no event claims it ended or failed');
  assert.equal(await live.transition(c, 'ended'), false, 'no gateway can move it on through the normal, owner-fenced path');
  await assert.rejects(live.resolveOrphan(c, 'ended', 'not a valid operator!'), /operator must be/); assert.equal((await row(c)).state, 'orphaned');
  const [x1, x2] = await Promise.all([live.resolveOrphan(c, 'ended', 'ops.alice'), replica('gw-ops').resolveOrphan(c, 'ended', 'ops.bob')]); assert.deepEqual([x1, x2].sort(), [false, true], 'racing operators: exactly one resolution');
  assert.equal((await row(c)).state, 'ended'); assert.ok((await events(c)).some((e) => e.reason === 'operator_reconciled' && e.to_state === 'ended'), 'the resolution is on the trail');
  const dead2 = replica('gw-dead-11'), r2 = reaper(replica('gw-survivor-11'), meet('unknown'), { cleanupAttempts: 1 }), c2 = await connected(dead2); await readyForTakeover(r2, c2); await r2.tick(); assert.equal((await row(c2)).state, 'orphaned');
  assert.equal(await live.resolveOrphan(c2, 'failed', 'ops.alice'), true); assert.equal(await row(c2), undefined, '`failed` frees the call id'); assert.equal(await live.claim(c2), true);
});
