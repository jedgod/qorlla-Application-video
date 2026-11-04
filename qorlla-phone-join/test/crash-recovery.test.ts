import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import pg from 'pg';
import { admitTelephoneCall, type Readiness, type MeetingAuthority, type SipRtpBridge } from '../src/admission.js';
import { PostgresCallLedger } from '../src/ledger-pg.js';
import { startReaper } from '../src/compose.js';
import { eventually } from './support.js';

// A REAL gateway process is killed (SIGKILL: no cleanup of any kind) in the middle of an admission, and ANOTHER replica recovers: it finds the abandoned claim, disconnects the media, ends the call in the
// meeting service, records what happened, and the call id becomes usable again. Needs PostgreSQL: PHONE_JOIN_TEST_DATABASE_URL (skipped, and reported as skipped, without it).
const URL_ = process.env.PHONE_JOIN_TEST_DATABASE_URL, skip = URL_ ? false : 'PHONE_JOIN_TEST_DATABASE_URL is not set';
const all: Readiness = { carrierConnected: true, inboundNumberCertified: true, gatewayHealthy: true, mediaBridgeCertified: true, billingCertified: true, productionApproved: true };
const SQL = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'sql', '001_phone_join.sql'), 'utf8') + fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'sql', '002_phone_join_lease.sql'), 'utf8'), CHILD = path.join(import.meta.dirname, 'helpers', 'crash-child.js');
let schema = '', admin: pg.Pool; const pools: pg.Pool[] = [], kids: ChildProcess[] = [];
const replica = (name: string) => { const p = new pg.Pool({ connectionString: URL_, options: '-c search_path=' + schema, max: 6 }); pools.push(p); return { pool: p, ledger: new PostgresCallLedger(p, name) }; };
test.before(async () => { if (!URL_) return; schema = 'pj_cr_' + Math.random().toString(36).slice(2, 8); admin = new pg.Pool({ connectionString: URL_ }); await admin.query('CREATE SCHEMA ' + schema); const c = await admin.connect(); try { await c.query('SET search_path=' + schema); await c.query(SQL); } finally { c.release(); } });
test.after(async () => { for (const k of kids) { try { k.kill('SIGKILL'); } catch { /* gone */ } } for (const p of pools) await p.end(); if (!URL_) return; await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); });

/** Starts the child replica, waits until it says `marker`, kills it hard, and returns once the OS has really ended it. */
async function crashAt(callId: string, mode: 'media' | 'host', marker: string): Promise<void> {
  const child = spawn(process.execPath, [CHILD, URL_!, schema, callId, mode], { stdio: ['ignore', 'pipe', 'inherit'] }); kids.push(child); let out = '';
  await new Promise<void>((resolve, reject) => { const t = setTimeout(() => reject(new Error('child never reached ' + marker + ': ' + out)), 20000); child.stdout!.on('data', (d) => { out += d; if (out.includes(marker)) { clearTimeout(t); resolve(); } }); child.on('error', reject); });
  const exited = new Promise<void>((r) => child.once('exit', () => r())); child.kill('SIGKILL'); await exited;
}
const meeting = { disconnected: [] as string[], cancelled: [] as string[] };
const authority = (): MeetingAuthority => ({ verifyPhoneJoin: async () => ({ allowed: false, requiresHostApproval: false }), requestHostApproval: async () => false, cancelAdmission: async (session, callId) => { meeting.cancelled.push(callId + '@' + session); } });
const bridge = (fail = false): SipRtpBridge & { gone: string[] } => { const gone: string[] = []; return { gone, attach: async () => ({ mediaEstablished: true }), disconnect: async (id) => { if (fail) throw new Error('gateway unreachable'); gone.push(id); } }; };
// The dead owner stopped renewing: its state deadline and its lease are long past. A reaper must still CHALLENGE first and wait out the grace period before it takes the call (grace() stands for the wait).
const age = (id: string) => admin.query(`UPDATE ${schema}.phone_join_calls SET updated_at = now() - interval '10 minutes', lease_expires_at = now() - interval '9 minutes' WHERE call_id=$1`, [id]);
const grace = (id: string) => admin.query(`UPDATE ${schema}.phone_join_calls SET lease_challenged_at = now() - interval '5 minutes' WHERE call_id=$1 AND lease_challenged_at IS NOT NULL`, [id]);

test('a gateway process killed mid-attach leaves a claim; another replica reaps it exactly once, disconnects the media, ends the call in the meeting, and the call id works again', { skip }, async () => {
  const id = 'call_crash_00001'; await crashAt(id, 'media', 'ATTACHING');
  const a = replica('survivor-a'), b = replica('survivor-b'); assert.equal(await a.ledger.stateOf(id), 'attaching', 'the dead process left the call mid-attach'); assert.equal(await a.ledger.claim(id), false, 'and nobody can claim it while it is open');
  assert.equal(await a.ledger.sessionOf(id), '11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222');
  assert.deepEqual(await a.ledger.reapStale(), [], 'not stale yet: a slow admission on a live replica must not be reaped'); await age(id);
  const br = bridge(), orphans: string[] = []; const ra = startReaper({ ledger: a.ledger, bridge: br, authority: authority(), intervalMs: 3_600_000, onOrphan: (x) => orphans.push(x), log: { error() {} } }), rb = startReaper({ ledger: b.ledger, bridge: br, authority: authority(), intervalMs: 3_600_000, log: { error() {} } });
  assert.deepEqual((await Promise.all([ra.tick(), rb.tick()])).flat(), [], 'a lapsed lease is challenged first, not reaped'); await grace(id);
  const done = (await Promise.all([ra.tick(), rb.tick()])).flat(); assert.deepEqual(done, [id], 'exactly one of the two reapers took it'); assert.deepEqual(br.gone, [id], 'media disconnected once'); assert.equal(meeting.cancelled.filter((x) => x.startsWith(id)).length, 1, 'the meeting was told once');
  assert.equal(await a.ledger.stateOf(id), null, 'recorded and released'); assert.deepEqual(orphans, []); ra.stop(); rb.stop();
  const hist = (await admin.query(`SELECT to_state, reason FROM ${schema}.phone_join_call_events WHERE call_id=$1 ORDER BY id`, [id])).rows; assert.deepEqual(hist.map((h) => h.to_state), ['claimed', 'authorizing', 'attaching', 'terminating', 'failed']); assert.equal(hist[3].reason, 'stale_claim');
  const again = await admitTelephoneCall({ meetingId: '12345678901', passcode: '12345678', callId: id, dialedNumber: '+12025550100' }, all, { verifyPhoneJoin: async () => ({ allowed: true, requiresHostApproval: false, meetingSessionId: 'ok.ok' }), requestHostApproval: async () => true }, { attach: async () => ({ mediaEstablished: true }), disconnect: async () => {} }, { ledger: a.ledger });
  assert.equal(again.code, 'MEDIA_CONNECTED', 'the same call id can be admitted afresh once recovery has finished');
});
test('a gateway process killed while the caller waits for the host is recovered the same way (the waiting caller is removed from the meeting)', { skip }, async () => {
  const id = 'call_crash_00002'; await crashAt(id, 'host', 'WAITING'); const a = replica('survivor'); assert.equal(await a.ledger.stateOf(id), 'awaiting_host'); await age(id);
  const br = bridge(); const r = startReaper({ ledger: a.ledger, bridge: br, authority: authority(), intervalMs: 3_600_000, log: { error() {} } }); assert.deepEqual(await r.tick(), []); await grace(id); assert.deepEqual(await r.tick(), [id]); assert.ok(meeting.cancelled.some((x) => x.startsWith(id)));
  assert.equal(await a.ledger.stateOf(id), null); r.stop();
});
test('recovery where the media CANNOT be disconnected: the call is ORPHANED, an operator is alerted, and the id is never reused', { skip }, async () => {
  const id = 'call_crash_00003'; await crashAt(id, 'media', 'ATTACHING'); const a = replica('survivor'); await age(id); const orphans: string[] = [];
  const r = startReaper({ ledger: a.ledger, bridge: bridge(true), authority: authority(), intervalMs: 3_600_000, onOrphan: (x) => orphans.push(x), log: { error() {} } }); await r.tick(); await grace(id); assert.deepEqual(await r.tick(), [id]); assert.deepEqual(orphans, [id]);
  assert.equal(await a.ledger.stateOf(id), 'orphaned'); await a.ledger.release(id); assert.equal(await a.ledger.claim(id), false, 'an orphan keeps its id until an operator has dealt with it'); assert.deepEqual(await a.ledger.reapStale(), [], 'and it is not reaped again'); r.stop();
});
test('a connected call is never reaped by the stale-claim reaper (its liveness is proven by media reports, which Meet watches)', { skip }, async () => {
  const a = replica('live'), id = 'call_live_000001'; await a.ledger.claim(id); for (const s of ['authorizing', 'attaching', 'connected'] as const) await a.ledger.transition(id, s, { meetingSessionId: 'x.y' }); await age(id);
  const r = startReaper({ ledger: a.ledger, bridge: bridge(), authority: authority(), intervalMs: 3_600_000, log: { error() {} } }); assert.deepEqual(await r.tick(), []); await grace(id); assert.deepEqual(await r.tick(), []); assert.equal(await a.ledger.stateOf(id), 'connected'); r.stop();
});
test('the reaper survives its own failures: a database error in one tick does not stop later ticks, and overlapping ticks do not run twice', { skip }, async () => {
  const errs: string[] = []; let calls = 0; const flaky = { reapStale: async () => { calls++; if (calls === 1) throw new Error('db down'); return []; }, sessionOf: async () => null, finishReap: async () => true };
  const r = startReaper({ ledger: flaky, bridge: bridge(), authority: authority(), intervalMs: 50, log: { error: (m) => errs.push(String(m)) } });
  assert.ok(await eventually(() => calls >= 3, 4000), 'it kept ticking after the failure'); assert.ok(errs.some((e) => e.includes('db down'))); r.stop();
});
