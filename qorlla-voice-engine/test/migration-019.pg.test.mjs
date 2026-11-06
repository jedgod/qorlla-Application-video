// A5.5 migration 019 review, as tests: the function definition, privileges, idempotency, rollback, and that NOTHING that already alerted alerts differently. Real PostgreSQL, isolated schema.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { isolatedDb } from './helpers.mjs';
import { migrate } from '../src/migrate.mjs';

let db; const sql = (f) => fs.readFileSync(new URL('../sql/' + f, import.meta.url), 'utf8');
before(async () => { db = await isolatedDb(); });
after(async () => { if (db) await db.drop(); setTimeout(() => process.exit(process.exitCode || 0), 1500).unref(); });
const skip = (t) => !db && t.skip('needs PostgreSQL (VOICE_TEST_DATABASE_URL)');
const q = (text, p) => db.pool.query(text, p);
const fn = async () => (await q(`SELECT p.oid, p.proowner::regrole::text AS owner, p.prosecdef, p.proacl::text AS acl, md5(p.prosrc) AS body, p.proconfig::text AS config, l.lanname AS lang
  FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.proname='shield_alert_from_event' AND p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`)).rows;
const trg = async () => (await q(`SELECT t.tgname, t.tgenabled, p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='shield_events'::regclass AND NOT t.tgisinternal AND t.tgname='shield_events_alert'`)).rows;
const emit = async (reason, tag, decision = 'ALERT') => q("INSERT INTO shield_events(actor, action, decision, reason, context) VALUES($1,$2,$3,$4,$5)", ['svc:test', 'test.' + reason.toLowerCase(), decision, reason, JSON.stringify({ discriminator: tag, workload: 'svc:test' })]);
// shield_events is append-only: nothing is deleted between steps; each step is judged by the alerts whose last event came after a marker, with discriminators that are unique per step
let mark = 0; const marker = async () => { mark = Number((await q('SELECT COALESCE(max(id),0) AS m FROM shield_events')).rows[0].m); return mark; };
const alerts = async () => (await q('SELECT kind, severity FROM shield_alerts WHERE last_event_id > $1 ORDER BY kind', [mark])).rows.map((r) => r.kind + ':' + r.severity);
const uniq = () => crypto.randomBytes(4).toString('hex');
const OLD = ['CERT_REVOKED', 'CERT_BINDING_MISMATCH', 'TLS_HANDSHAKE_REFUSED', 'WORKLOAD_REPLAY', 'WORKLOAD_NOT_AUTHORIZED', 'CROSS_TENANT', 'SIGNALING_TERMINATION_FAILED', 'OUTBOX_DELIVERY_FAILED', 'MEDIA_TERMINATION_FAILED'];

test('019 DEFINITION: one function, plain plpgsql, NOT security definer, no search_path trick; the trigger still points at it, enabled', async (t) => {
  if (skip(t)) return; const f = await fn(); assert.equal(f.length, 1, 'exactly one definition (no overload was created)'); assert.equal(f[0].prosecdef, false, 'runs with the caller\'s rights, never elevated'); assert.equal(f[0].lang, 'plpgsql'); assert.equal(f[0].config, null, 'no function-level settings');
  assert.deepEqual((await trg()).map((x) => [x.tgname, x.tgenabled, x.proname]), [['shield_events_alert', 'O', 'shield_alert_from_event']]);
  const src = sql('019_phone_alerts.sql'); const stmts = src.replace(/--.*$/gm, '').replace(/\$\$[\s\S]*?\$\$/g, '$$$$').split(';').map((x) => x.trim()).filter(Boolean); assert.ok(stmts.every((x) => /^CREATE OR REPLACE FUNCTION shield_alert_from_event\(\)/i.test(x)), 'the migration is exactly one CREATE OR REPLACE FUNCTION statement and nothing else (no table, column, index, trigger or privilege statement); found ' + stmts.length); assert.ok(!/SECURITY\s+DEFINER/i.test(src), 'and the function is not security definer');
});

test('019 IDEMPOTENT + PRIVILEGES: re-running the whole migration set (as db:migrate does) changes neither the owner, the ACL nor the final body; applying 019 twice is a no-op', async (t) => {
  if (skip(t)) return; const before = await fn(); await migrate(db.pool); await migrate(db.pool); await q(sql('019_phone_alerts.sql')); await q(sql('019_phone_alerts.sql')); const after = await fn();
  assert.deepEqual(after, before.map((b) => ({ ...b })).map((b, i) => ({ ...b, oid: after[i].oid })), 'owner, ACL, language and body are identical (oid may change only if the function was dropped; CREATE OR REPLACE keeps it)'); assert.equal(after[0].oid, before[0].oid, 'same function object');
  assert.deepEqual((await trg()).map((x) => x.proname), ['shield_alert_from_event']);
});

test('019 DIFFERENTIAL: every pre-existing reason classifies EXACTLY as under 018; only the two PHONE_ reasons are new', async (t) => {
  if (skip(t)) return; const run = async (file) => { await q(sql(file)); await marker(); const u = uniq(); let i = 0; for (const r of [...OLD, 'PHONE_LATE_MEDIA', 'PHONE_TERMINATION_FAILED', 'SOMETHING_ELSE']) await emit(r, u + 'd' + i++, r === 'WORKLOAD_REPLAY' ? 'DENY' : 'ALERT'); return alerts(); };
  const under018 = await run('018_media_alerts.sql'), under019 = await run('019_phone_alerts.sql');
  const phone = (a) => a.filter((x) => /^phone_/.test(x)), rest = (a) => a.filter((x) => !/^phone_/.test(x));
  assert.deepEqual(rest(under019), rest(under018), 'nothing that alerted before alerts differently now'); assert.deepEqual(phone(under018), [], '018 does not know the phone reasons'); assert.deepEqual(phone(under019).sort(), ['phone_late_media:high', 'phone_termination_failure:critical']);
  assert.ok(!under019.some((a) => /something/i.test(a)), 'an unknown reason still raises nothing');
});

test('019 ROLLBACK: re-applying 018 restores the previous classification without touching existing alerts or events; applying 019 again restores the new one', async (t) => {
  if (skip(t)) return; await q(sql('019_phone_alerts.sql')); await marker(); await emit('PHONE_LATE_MEDIA', uniq()); assert.deepEqual(await alerts(), ['phone_late_media:high']);
  const events0 = (await q('SELECT count(*)::int n FROM shield_events')).rows[0].n; await q(sql('018_media_alerts.sql'));
  assert.deepEqual(await alerts(), ['phone_late_media:high'], 'the alert already raised is untouched by the rollback'); assert.equal((await q('SELECT count(*)::int n FROM shield_events')).rows[0].n, events0);
  await emit('PHONE_TERMINATION_FAILED', uniq()); await emit('SIGNALING_TERMINATION_FAILED', uniq()); assert.deepEqual(await alerts(), ['phone_late_media:high', 'signaling_termination_failure:critical'], 'after the rollback a phone termination failure raises no alert, an old kind still does');
  await q(sql('019_phone_alerts.sql')); await emit('PHONE_TERMINATION_FAILED', uniq()); assert.ok((await alerts()).includes('phone_termination_failure:critical'), 'and applying 019 again restores it');
  assert.equal((await fn()).length, 1);
});

test('019 LEAST PRIVILEGE: with only the table grants of deploy/roles.sql (no function grant, no ownership) an event insert by the application role still raises the alert', async (t) => {
  if (skip(t)) return; const role = 'qv_app_' + crypto.randomBytes(3).toString('hex'), schema = db.schema; await db.admin.query(`CREATE ROLE ${role} NOLOGIN`);
  try {
    await db.admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`); await db.admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`); await db.admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
    await marker(); const c = await db.pool.connect();
    try { await c.query(`SET ROLE ${role}`); await c.query("INSERT INTO shield_events(actor, action, decision, reason, context) VALUES('svc:test','report.phone_late_media','ALERT','PHONE_LATE_MEDIA','{\"discriminator\":\"lp1\"}')"); await c.query('RESET ROLE'); } finally { c.release(); }
    assert.deepEqual(await alerts(), ['phone_late_media:high']);
  } finally { await db.admin.query(`DROP OWNED BY ${role}`).catch(() => {}); await db.admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {}); }
});
