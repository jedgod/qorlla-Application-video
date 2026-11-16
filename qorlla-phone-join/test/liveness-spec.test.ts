import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import type { CallState } from '../src/admission.js';
import { PostgresCallLedger } from '../src/ledger-pg.js';

// A5.5 - CONNECTED-CALL GATEWAY LIVENESS: acceptance specification, written before the fix. Decision: "a dead gateway must not leave a connected ledger row indefinitely". Meet observing
// `gateway_signaling_lost` ends the CALL in Meet; it does not resolve the gateway's own ledger row, which is what this test is about. Deterministic: time is moved by editing the rows (the database clock is the
// authority), no sleeps. EXPECTED TO FAIL today (the reaper never looks at `connected`); skipped unless A5_LIVENESS_SPEC=1 and PHONE_JOIN_TEST_DATABASE_URL is set.
const URL_ = process.env.PHONE_JOIN_TEST_DATABASE_URL, skip = !URL_ ? 'PHONE_JOIN_TEST_DATABASE_URL is not set' : process.env.A5_LIVENESS_SPEC !== '1' ? 'liveness specification: set A5_LIVENESS_SPEC=1 to run (expected to fail until the fix)' : false;
const sqlDir = path.join(import.meta.dirname, '..', '..', 'sql'), SQL = ['001_phone_join.sql', '002_phone_join_lease.sql'].map((f) => fs.readFileSync(path.join(sqlDir, f), 'utf8')).join('\n');
let schema = '', admin: pg.Pool; const pools: pg.Pool[] = []; let n = 0;
const replica = (name: string) => { const pool = new pg.Pool({ connectionString: URL_, options: '-c search_path=' + schema, max: 8 }); pools.push(pool); return new PostgresCallLedger(pool, name, { lease: { leaseMs: 15_000, graceMs: 15_000 } }); };
test.before(async () => { if (skip) return; schema = 'pj_lv_' + Math.random().toString(36).slice(2, 8); admin = new pg.Pool({ connectionString: URL_ }); await admin.query('CREATE SCHEMA ' + schema); const c = await admin.connect(); try { await c.query('SET search_path=' + schema); await c.query(SQL); } finally { c.release(); } });
test.after(async () => { if (skip) return; for (const p of pools) await p.end().catch(() => undefined); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); });
const row = async (c: string) => (await admin.query(`SELECT state, lease_owner, lease_generation::int AS gen, lease_expires_at > now() AS live FROM ${schema}.phone_join_calls WHERE call_id=$1`, [c])).rows[0];
const connected = async (l: PostgresCallLedger) => { const c = 'lv_call_' + String(++n).padStart(4, '0'); assert.equal(await l.claim(c), true); for (const s of ['authorizing', 'attaching', 'connected'] as CallState[]) assert.equal(await l.transition(c, s, { meetingSessionId: 'sess.1' }), true); return c; };
/** The gateway process died: nothing renews its lease any more, and the lease ran out long ago. */
const died = (c: string) => admin.query(`UPDATE ${schema}.phone_join_calls SET updated_at = now() - interval '1 hour', lease_expires_at = now() - interval '10 minutes' WHERE call_id=$1`, [c]);
const graceOver = (c: string) => admin.query(`UPDATE ${schema}.phone_join_calls SET lease_challenged_at = now() - interval '5 minutes' WHERE call_id=$1 AND lease_challenged_at IS NOT NULL`, [c]);

test('LIVENESS L1 - a CONNECTED call whose gateway died is challenged, and once the grace period has passed a surviving gateway takes it over (generation + 1, terminating) so it can be ended and released', { skip }, async () => {
  const dead = replica('gw-dead'), survivor = replica('gw-survivor'), c = await connected(dead); await died(c);
  assert.deepEqual(await survivor.reapStale(), [], 'first sight is only a challenge, never a takeover');
  await graceOver(c); const taken = await survivor.reapStale();
  assert.deepEqual(taken, [c], 'a connected row with a dead owner must be taken over after the lease grace (today the reaper never considers `connected`, so the row stays connected forever)');
  const r = await row(c); assert.equal(r.state, 'terminating'); assert.equal(r.lease_owner, 'gw-survivor'); assert.equal(r.gen, 2);
});

test('LIVENESS L2 (safety) - a connected call whose owner is ALIVE is never taken over, however old its last state change is', { skip }, async () => {
  const live = replica('gw-live'), survivor = replica('gw-survivor-2'), c = await connected(live);
  await admin.query(`UPDATE ${schema}.phone_join_calls SET updated_at = now() - interval '2 hours' WHERE call_id=$1`, [c]);               // a long call: old state change, lease still being renewed
  assert.deepEqual(await survivor.reapStale(), []); await graceOver(c); assert.deepEqual(await survivor.reapStale(), []); const r = await row(c); assert.deepEqual({ state: r.state, owner: r.lease_owner, gen: r.gen }, { state: 'connected', owner: 'gw-live', gen: 1 });
});

test('LIVENESS L3 (fencing) - after the takeover the old owner can no longer renew or change the row, even if it comes back', { skip }, async () => {
  const dead = replica('gw-dead-2'), survivor = replica('gw-survivor-3'), c = await connected(dead); await died(c); await survivor.reapStale(); await graceOver(c);
  assert.deepEqual(await survivor.reapStale(), [c], 'precondition: the survivor took the call over (today: it does not)');
  assert.equal(await dead.renew(c), false, 'the old owner is fenced out'); assert.equal(await dead.transition(c, 'ended'), false, 'and cannot write');
});
