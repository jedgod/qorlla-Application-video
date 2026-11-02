// Security-event permissions, checked as the REAL application role (qorlla_app) against a real PostgreSQL cluster, including privileges that are
// inherited through role membership and granted to PUBLIC. Needs TEST_DATABASE_ADMIN_URL (superuser). Each run uses a fresh database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const { createPgLockoutStore, createLockoutService } = require('../lockout');

const ADMIN = process.env.TEST_DATABASE_ADMIN_URL;
const SQL = fs.readFileSync(path.join(import.meta.dirname, '..', 'meet-sync', 'sql', '008_passcode_lockout.sql'), 'utf8');
const quiet = { error() {} };
let admin, owner, app, dbName, createdRole = false; const group = 'qa_group_' + Math.random().toString(36).slice(2, 8); const pools = [];
const mk = (u) => { const p = new Pool({ connectionString: u, max: 4, connectionTimeoutMillis: 5000 }); p.on('error', () => {}); pools.push(p); return p; };
const denied = (p) => assert.rejects(p, (e) => /permission denied|must be owner/i.test(e.message));

before(async () => {
  assert.ok(ADMIN, 'TEST_DATABASE_ADMIN_URL is required: these tests never skip silently');
  admin = mk(ADMIN); dbName = 'lockoutsec_' + Math.random().toString(36).slice(2, 10);
  await admin.query(`CREATE DATABASE ${dbName}`);
  createdRole = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname='qorlla_app'")).rowCount === 0;
  if (createdRole) await admin.query("CREATE ROLE qorlla_app LOGIN PASSWORD 'app-pw-test' NOSUPERUSER NOCREATEDB NOCREATEROLE");
  else await admin.query("ALTER ROLE qorlla_app LOGIN PASSWORD 'app-pw-test'");
  await admin.query(`GRANT CONNECT ON DATABASE ${dbName} TO qorlla_app`);
  await admin.query(`CREATE ROLE ${group} NOLOGIN`);
  const ou = new URL(ADMIN); ou.pathname = '/' + dbName; owner = mk(ou.toString());
  const au = new URL(ou.toString()); au.username = 'qorlla_app'; au.password = 'app-pw-test'; app = mk(au.toString());
  await owner.query('GRANT USAGE ON SCHEMA public TO qorlla_app');
});
after(async () => {
  for (const p of pools) await p.end().catch(() => {});
  const a = new Pool({ connectionString: ADMIN, max: 1 }); a.on('error', () => {});
  await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {}); await a.query(`DROP ROLE IF EXISTS ${group}`).catch(() => {});
  if (createdRole) await a.query('DROP ROLE IF EXISTS qorlla_app').catch(() => {}); await a.end();
});
const eff = async (priv) => (await owner.query("SELECT has_table_privilege('qorlla_app','public.meeting_passcode_events',$1) AS ok", [priv])).rows[0].ok;

test('upgrade from an earlier revision REVOKES the direct DELETE/UPDATE and PUBLIC grants; effective privileges end up append-only', async () => {
  await owner.query(SQL);                                                              // first revision of the schema
  await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON public.meeting_passcode_events TO qorlla_app');   // what 86b39ba-style databases had
  await owner.query('GRANT ALL ON public.meeting_passcode_events TO PUBLIC');
  assert.equal(await eff('DELETE'), true);                                              // precondition: the weakness exists
  await owner.query(SQL); await owner.query(SQL);                                       // upgrade, and again (idempotent)
  for (const p of ['DELETE', 'UPDATE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) assert.equal(await eff(p), false, p);
  for (const p of ['SELECT', 'INSERT']) assert.equal(await eff(p), true, p);
});

test('a privilege inherited through a role the application role belongs to makes the migration FAIL; removing it lets it pass', async () => {
  await owner.query(`GRANT DELETE ON public.meeting_passcode_events TO ${group}`); await admin.query(`GRANT ${group} TO qorlla_app`);
  assert.equal(await eff('DELETE'), true);                                              // effective, although there is no direct grant
  await assert.rejects(owner.query(SQL), /inherited role or PUBLIC/);
  await owner.query(`REVOKE DELETE ON public.meeting_passcode_events FROM ${group}`);
  await owner.query(SQL); assert.equal(await eff('DELETE'), false);
  await admin.query(`REVOKE ${group} FROM qorlla_app`);
});

test('as the real application role: it can append and read security events but cannot delete, update, truncate or prune them', async () => {
  await app.query("INSERT INTO public.meeting_passcode_events(meeting_id, kind, actor) VALUES ('A1','locked','h')");
  assert.equal((await app.query("SELECT count(*)::int AS n FROM public.meeting_passcode_events WHERE meeting_id='A1'")).rows[0].n, 1);
  await denied(app.query("DELETE FROM public.meeting_passcode_events WHERE meeting_id='A1'"));
  await denied(app.query("UPDATE public.meeting_passcode_events SET kind='cleared_by_host' WHERE meeting_id='A1'"));
  await denied(app.query('TRUNCATE public.meeting_passcode_events'));
  await denied(app.query('SELECT public.prune_passcode_events(90)'));
  await denied(app.query('SELECT * FROM public.meeting_passcode_maintenance'));
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM public.meeting_passcode_events WHERE meeting_id='A1'")).rows[0].n, 1);
});

test('the lockout works end to end with ONLY those privileges (no DELETE/UPDATE on events)', async () => {
  const store = createPgLockoutStore({ pool: app }); const svc = createLockoutService({ store, perClientMax: 1000, log: quiet });
  for (let i = 0; i < 5; i++) await svc.verify({ meetingId: 'A2', clientKey: 'c', check: async () => false });
  assert.equal((await svc.status('A2')).locked, true);
  const a = await svc.clearLockLimited('A2', 'host'); assert.equal(a.ok, true);
  for (let i = 0; i < 2; i++) await svc.clearLockLimited('A2', 'host'); assert.equal((await svc.clearLockLimited('A2', 'host')).ok, false);   // rate limited: records a rejection
  for (let i = 0; i < 130; i++) await svc.audit('A2', 'clear_rejected', 'x', 'not_host');                                                       // bounded without any DELETE
  const n = (await owner.query("SELECT count(*)::int AS n FROM public.meeting_passcode_events WHERE meeting_id='A2' AND kind='clear_rejected' AND at > now() - interval '1 hour'")).rows[0].n;
  assert.ok(n <= 100, 'rejected-request audits are capped per hour: ' + n);
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM public.meeting_passcode_events WHERE meeting_id='A2' AND kind='cleared_by_host'")).rows[0].n, 3);
});

test('retention is an owner-run, audited step that never touches events needed for the recovery limit', async () => {
  await owner.query("INSERT INTO public.meeting_passcode_events(meeting_id, kind, actor, reason, at) VALUES ('A3','clear_rejected','x','not_host', now() - interval '120 days'), ('A3','cleared_by_host','h',NULL, now() - interval '120 days'), ('A3','clear_rejected','x','not_host', now() - interval '5 minutes'), ('A3','locked','h',NULL, now() - interval '120 days')");
  await assert.rejects(owner.query('SELECT public.prune_passcode_events(1)'), /at least 2 days/);   // cannot shrink the window below what the one-hour limit needs
  const out = await owner.query('SELECT public.prune_passcode_events(90) AS n'); assert.equal(out.rows[0].n, 1);
  const left = (await owner.query("SELECT kind FROM public.meeting_passcode_events WHERE meeting_id='A3' ORDER BY id")).rows.map((r) => r.kind);
  assert.deepEqual(left, ['cleared_by_host', 'clear_rejected', 'locked']);                           // only the OLD REJECTED row went; permanent history stays
  const m = (await owner.query('SELECT operator, older_than_days, deleted_events FROM public.meeting_passcode_maintenance ORDER BY id DESC LIMIT 1')).rows[0]; assert.equal(m.deleted_events, 1); assert.equal(m.older_than_days, 90); assert.ok(m.operator);
});
