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
const pool = (u = url) => { const p = new Pool({ connectionString: u, max: 8, connectionTimeoutMillis: 1500 }); p.on('error', () => {}); pools.push(p); return p; };
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

test('concurrent attempts through several "instances" share one budget (row lock)', async () => {
  const instances = [svc(pool()), svc(pool()), svc(pool())]; let verified = 0;
  const results = await Promise.all(Array.from({ length: 90 }, (_, i) => instances[i % 3].verify({ meetingId: 'P3', clientKey: 'c', check: async () => { verified++; await new Promise((r) => setTimeout(r, 3)); return false; } })));
  assert.ok(verified <= MAX_FAILURES, `verified ${verified}`); assert.ok(verified > 0);
  assert.ok(results.every((r) => ['wrong', 'locked', 'busy'].includes(r.status)), 'only wrong/locked/busy outcomes: ' + [...new Set(results.map((r) => r.status))]);
  assert.equal((await instances[0].status('P3')).locked, true);
});

test('an in-flight success that settles after the lock is refused; the host can clear the lock; events carry no raw actor', async () => {
  const p = pool(); const store = createPgLockoutStore({ pool: p });
  assert.equal((await store.reserve('P4')).allowed, true);
  for (let i = 0; i < 4; i++) { await store.reserve('P4'); await store.settleFailure('P4', 'hash'); }
  const s = await store.settleSuccess('P4'); assert.equal(s.ok, false);
  const out = await store.clearLock('P4', 'actorhash'); assert.deepEqual(out, { cleared: true, wasLocked: true });
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
