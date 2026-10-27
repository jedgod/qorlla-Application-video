// PostgreSQL lockout adapter against a REAL database. Needs TEST_DATABASE_ADMIN_URL (a superuser URL); each run uses a fresh database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const { createPgLockoutStore, createLockoutService, MAX_FAILURES } = require('../lockout');

const ADMIN = process.env.TEST_DATABASE_ADMIN_URL;
const quiet = { error() {} };
let admin, dbName, url; const pools = [];
const pool = (u = url) => { const p = new Pool({ connectionString: u, max: 8, connectionTimeoutMillis: 10000 }); p.on('error', () => {}); pools.push(p); return p; };
const svc = (p, o = {}) => createLockoutService({ store: createPgLockoutStore({ pool: p }), perClientMax: 10000, log: quiet, ...o });
const wrong = (s, id = 'M1') => s.verify({ meetingId: id, clientKey: 'c', check: async () => false });
const right = (s, id = 'M1') => s.verify({ meetingId: id, clientKey: 'c', check: async () => true });

before(async () => {
  assert.ok(ADMIN, 'TEST_DATABASE_ADMIN_URL is required: these tests never skip silently');
  admin = new Pool({ connectionString: ADMIN, max: 2 }); dbName = 'lockout_' + Math.random().toString(36).slice(2, 10);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const u = new URL(ADMIN); u.pathname = '/' + dbName; url = u.toString();
  const p = pool(); await p.query(fs.readFileSync(path.join(import.meta.dirname, '..', 'meet-sync', 'sql', '008_passcode_lockout.sql'), 'utf8')); await p.query(fs.readFileSync(path.join(import.meta.dirname, '..', 'meet-sync', 'sql', '008_passcode_lockout.sql'), 'utf8'));   // twice: idempotent
});
after(async () => { for (const p of pools) await p.end().catch(() => {}); await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {}); await admin.end(); });

test('four failures survive a restart (new pool, new service); the fifth locks; a correct passcode does not lift it', async () => {
  let s = svc(pool()); for (let i = 0; i < 4; i++) assert.equal((await wrong(s, 'P1')).status, 'wrong');
  s = svc(pool()); assert.equal((await wrong(s, 'P1')).status, 'locked');
  s = svc(pool()); assert.equal((await right(s, 'P1')).status, 'locked');
  assert.equal((await s.status('P1')).locked, true);
});

test('expiry follows the DATABASE clock, then the budget starts again', async () => {
  const p = pool(); const s = svc(p); for (let i = 0; i < 5; i++) await wrong(s, 'P2');
  assert.equal((await wrong(s, 'P2')).status, 'locked');
  await p.query("UPDATE public.meeting_passcode_attempts SET locked_until = now() - interval '1 second' WHERE meeting_id='P2'");
  assert.equal((await wrong(s, 'P2')).status, 'wrong');
  assert.equal((await right(s, 'P2')).status, 'ok');
});

// Wraps a pool so the time spent waiting for a free connection is measured.
const timedPool = (waits) => { const p = pool(); const connect = p.connect.bind(p); p.connect = async () => { const t = performance.now(); try { return await connect(); } finally { waits.push(performance.now() - t); } }; return p; };
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] * 10) / 10 : 0; };

test('concurrent attempts through several "instances" share one budget (row lock); outcomes, comparisons, latency and pool wait are reported', async () => {
  const waits = []; const instances = [svc(timedPool(waits)), svc(timedPool(waits)), svc(timedPool(waits))]; let comparisons = 0; const latencies = []; const ATTEMPTS = 90;
  const results = await Promise.all(Array.from({ length: ATTEMPTS }, async (_, i) => {
    const t = performance.now();
    const r = await instances[i % 3].verify({ meetingId: 'P3', clientKey: 'c', check: async () => { comparisons++; await new Promise((x) => setTimeout(x, 3)); return false; } });
    latencies.push(performance.now() - t); return r;
  }));
  const outcomes = results.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), { wrong: 0, locked: 0, busy: 0, unavailable: 0 });
  const metrics = { attempted: ATTEMPTS, comparisons, budget: MAX_FAILURES, outcomes, p95Ms: pct(latencies, 0.95), p99Ms: pct(latencies, 0.99), maxPoolWaitMs: pct(waits, 1), p95PoolWaitMs: pct(waits, 0.95), poolAcquisitions: waits.length, unavailableRate: outcomes.unavailable / ATTEMPTS };
  console.log('LOCKOUT_STRESS_METRICS ' + JSON.stringify(metrics));
  if (process.env.LOCKOUT_METRICS_FILE) fs.writeFileSync(process.env.LOCKOUT_METRICS_FILE, JSON.stringify(metrics, null, 2));
  // SECURITY result first: no excess comparison, whatever else happened.
  assert.ok(comparisons <= MAX_FAILURES, `SECURITY: ${comparisons} comparisons exceeded the budget of ${MAX_FAILURES}`); assert.ok(comparisons > 0);
  assert.equal(outcomes.wrong + outcomes.locked + outcomes.busy + outcomes.unavailable, ATTEMPTS, 'unexpected outcome kinds: ' + JSON.stringify(outcomes));
  // AVAILABILITY result, reported separately: an "unavailable" is a visible operational failure even though failing closed is the correct security behaviour.
  assert.equal(outcomes.unavailable, 0, `AVAILABILITY: ${outcomes.unavailable} of ${ATTEMPTS} requests were unavailable (rate ${(100 * outcomes.unavailable / ATTEMPTS).toFixed(1)}%); security held. Metrics: ${JSON.stringify(metrics)}`);
  assert.equal((await instances[0].status('P3')).locked, true);
});

test('an in-flight success that settles after the lock is refused; the host can clear the lock; events carry no raw actor', async () => {
  const p = pool(); const store = createPgLockoutStore({ pool: p });
  assert.equal((await store.reserve('P4')).allowed, true);
  for (let i = 0; i < 4; i++) { await store.reserve('P4'); await store.settleFailure('P4', 'hash'); }
  const s = await store.settleSuccess('P4'); assert.equal(s.ok, false);
  const out = await store.clearLockLimited('P4', 'actorhash'); assert.deepEqual(out, { ok: true, wasLocked: true });
  const st = await store.status('P4'); assert.equal(st.locked, false); assert.deepEqual(st.events.map((e) => e.kind), ['cleared_by_host', 'locked']);
});

test('database unavailable, or table missing, fails closed: the passcode comparison never runs', async () => {
  let called = 0; const check = async () => { called++; return true; };
  const dead = svc(pool('postgres://nobody:x@127.0.0.1:1/none'));
  assert.equal((await dead.verify({ meetingId: 'P5', clientKey: 'c', check })).status, 'unavailable');
  const p = pool(); await p.query('ALTER TABLE public.meeting_passcode_attempts RENAME TO attempts_gone');
  try { assert.equal((await svc(p).verify({ meetingId: 'P5', clientKey: 'c', check })).status, 'unavailable'); }
  finally { await p.query('ALTER TABLE public.attempts_gone RENAME TO meeting_passcode_attempts'); }
  assert.equal(called, 0);
});

test('release is idempotent, own-reservation-only and epoch-guarded (PostgreSQL)', async () => {
  const store = createPgLockoutStore({ pool: pool() }); const a = await store.reserve('P6'); const b = await store.reserve('P6');
  await store.settleFailure('P6', 'c', b.attemptId);
  assert.deepEqual(await store.release('P6', a.attemptId), { released: true });
  assert.deepEqual(await store.release('P6', a.attemptId), { released: false });
  assert.deepEqual(await store.release('P6', b.attemptId), { released: false });
  assert.equal((await store.status('P6')).failed, 1);
  const c = await store.reserve('P6'); await store.settleSuccess('P6', c.attemptId);       // reset voids everything open
  const d = await store.reserve('P6'); const e = await store.reserve('P6'); await store.settleSuccess('P6', e.attemptId);
  assert.deepEqual(await store.release('P6', d.attemptId), { released: false }); assert.equal((await store.status('P6')).failed, 0);
});

test('a faulting comparison does not consume the budget; an unconfirmable release fails closed and stays counted (PostgreSQL)', async () => {
  const real = createPgLockoutStore({ pool: pool() }); const s = svc(pool());
  for (let i = 0; i < 6; i++) assert.equal((await s.verify({ meetingId: 'P7', clientKey: 'c', check: async () => { throw new Error('boom'); } })).status, 'unavailable');
  assert.equal((await real.status('P7')).failed, 0);
  const flaky = createLockoutService({ store: { ...real, release: async () => { throw new Error('down'); } }, perClientMax: 1000, log: quiet });
  assert.equal((await flaky.verify({ meetingId: 'P7', clientKey: 'c', check: async () => { throw new Error('x'); } })).status, 'unavailable');
  assert.equal((await real.status('P7')).failed, 1);
});

test('recovery allowance is atomic across instances, durable, per host, and rejected requests do not consume it (PostgreSQL)', async () => {
  const stores = [createPgLockoutStore({ pool: pool() }), createPgLockoutStore({ pool: pool() }), createPgLockoutStore({ pool: pool() })];
  const results = await Promise.all(Array.from({ length: 15 }, (_, i) => stores[i % 3].clearLockLimited('P8', 'hostA')));
  assert.equal(results.filter((r) => r.ok).length, 3); assert.equal(results.filter((r) => r.reason === 'rate_limited').length, 12);
  assert.equal((await stores[0].clearLockLimited('P8', 'hostB')).ok, true);
  for (let i = 0; i < 5; i++) await stores[1].audit('P9', 'clear_rejected', 'x', 'not_host');
  for (let i = 0; i < 3; i++) assert.equal((await stores[2].clearLockLimited('P9', 'hostA')).ok, true);
  const st = await stores[0].status('P9'); assert.ok(st.events.some((e) => e.kind === 'clear_rejected' && e.reason === 'not_host'));
  assert.equal((await stores[0].clearLockLimited('P9', 'hostA')).ok, false);
  const pc = pool(); assert.equal(Number((await pc.query("SELECT count(*) FROM public.meeting_passcode_events WHERE kind='cleared_by_host' AND meeting_id='P8'")).rows[0].count), 4);
});
