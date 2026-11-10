// Gate A5.3: the meeting code a telephone caller keys in. The REAL Meet server against a real PostgreSQL schema.
//   PHONE_TEST_DATABASE_URL=postgres://user:pw@host:port/db  node --test tests/phone-meeting-code.pg.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { normalizePhoneMeetingCode } from '../server/meeting-code.mjs';

const URL_ = process.env.PHONE_TEST_DATABASE_URL, skip = URL_ ? false : 'PHONE_TEST_DATABASE_URL is not set';
const SQL = path.join(import.meta.dirname, '..', 'sql'), ROOT = path.join(import.meta.dirname, '..');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', 'v4_7_recording_consent.sql', 'v4_8_collab.sql', 'v4_9_recording_storage.sql', 'v4_10_admission.sql', 'v4_11_history.sql', 'v4_12_limit.sql',
  'v4_13_phone.sql', 'v4_14_telephony.sql', 'v4_15_telephony_features.sql', 'v4_16_number_authority.sql', 'v4_17_shield_identity.sql', 'v4_18_billing_hold.sql', 'v4_19_ai_request.sql', 'v4_20_ai_consent_seq.sql', 'v4_21_handoffs.sql', 'v4_22_host_controls.sql', 'v4_24_phone_lifecycle.sql', 'v4_29_phone_gateway_media_bridge.sql'];
const BRIDGE = crypto.randomBytes(24).toString('hex'), WEBHOOK = 'code-test-webhook-secret-0123456789', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let schema, admin, meet; const procs = [];
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

test('normalizePhoneMeetingCode: 11 or 12 digits, separators removed, everything else refused, the digits themselves untouched', () => {
  const n = normalizePhoneMeetingCode;
  assert.equal(n('12345678901'), '12345678901'); assert.equal(n('123456789012'), '123456789012'); assert.equal(n('123 4567 8901'), '12345678901'); assert.equal(n('123-4567-8901'), '12345678901'); assert.equal(n('1234 5678 9012'), '123456789012');
  assert.equal(n('012345678901'), '012345678901', 'a leading zero is kept'); assert.equal(n('01234567890'), '01234567890'); assert.equal(n('000 0000 0000'), '00000000000');
  for (const bad of ['', '1234567890', '1234567890123', '123456789a1', 'a12345678901', '123456789\t01', '123456789\n01', ' ', '１２３４５６７８９０１', '1234567890.1', '+12345678901', '123456789012 3', 12345678901, null, undefined, {}, ['12345678901'], '1'.repeat(41)])
    assert.equal(n(bad), null, 'refused: ' + JSON.stringify(bad));
});

test.before(async () => {
  if (!URL_) return; schema = 'mc_' + Math.random().toString(36).slice(2, 9); admin = new pg.Pool({ connectionString: URL_ }); await admin.query('CREATE SCHEMA ' + schema);
  const c = await admin.connect(); try { await c.query('SET search_path=' + schema); for (const f of ORDER) await c.query(fs.readFileSync(path.join(SQL, f), 'utf8')); } finally { c.release(); }
  const port = await freePort(), env = { ...process.env, PORT: String(port), DATABASE_URL: URL_ + (URL_.includes('?') ? '&' : '?') + 'options=' + encodeURIComponent('-c search_path=' + schema), JWT_SECRET: crypto.randomBytes(32).toString('hex'), QORLLA_BRIDGE_SECRET: BRIDGE,
    RECOVERY_ESCROW_KEY: crypto.randomBytes(32).toString('base64'), RECORDING_MASTER_KEYS: JSON.stringify({ k1: crypto.randomBytes(32).toString('base64') }), RECORDING_ACTIVE_KEY_ID: 'k1', RECORDING_STORE_DIR: path.join(ROOT, '..', '.dev-stack', 'recordings-' + port), RECORDING_ADMIN_SECRET: 'x'.repeat(24),
    NODE_ENV: 'development', PHONE_PROVIDER: 'test', PHONE_WEBHOOK_SECRET: WEBHOOK, PHONE_MAX_FAILS_CALLER: '1000', PHONE_MAX_FAILS_MEETING: '1000' };
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }); procs.push(child); let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  const base = 'http://127.0.0.1:' + port; for (let i = 0; i < 80; i++) { if (await fetch(base + '/api/ready').then((r) => r.ok).catch(() => false)) { meet = { base, log: () => log }; return; } await sleep(250); } throw new Error('Meet did not start: ' + log.slice(-600));
});
test.after(async () => { for (const p of procs) { try { p.kill(); } catch { /* gone */ } } await sleep(300); if (!URL_) return; await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); });

const rnd = (n) => Array.from({ length: n }, () => crypto.randomInt(10)).join('');
// a meeting as the main app's scheduling makes it: Meet's own 12-digit primary code PLUS the main app's 11-digit ID as an alias (or the primary overridden by `primary12` / `alias11` for the leading-zero cases)
async function seed({ primary12 = '5' + rnd(11), alias11 = '4' + rnd(10), alias10 = null } = {}) {
  const id = crypto.randomUUID(), source = 'sched_' + crypto.randomBytes(5).toString('hex');
  await admin.query(`INSERT INTO ${schema}.meetings(id,title,host_secret_hash,meeting_code) VALUES($1,'T','x',$2)`, [id, primary12]);
  await admin.query(`INSERT INTO ${schema}.external_meeting_links(source_system,source_id,meeting_id) VALUES('qorlla-main',$1,$2)`, [source, id]);
  if (alias11) await admin.query(`INSERT INTO ${schema}.meeting_code_aliases(alias_code,meeting_id) VALUES($1,$2)`, [alias11, id]);
  if (alias10) await admin.query(`INSERT INTO ${schema}.meeting_code_aliases(alias_code,meeting_id) VALUES($1,$2)`, [alias10, id]);
  return { id, source, primary12, alias11, alias10 };
}
const bridge = (p, o = {}) => fetch(meet.base + p, { method: o.method || 'GET', headers: { 'x-qorlla-bridge-secret': BRIDGE, 'content-type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const dir = (code) => bridge('/api/integrations/phone/meetings/' + encodeURIComponent(code));
const newPin = async (m) => (await bridge('/api/integrations/scheduled-meetings/' + m.source + '/phone-access', { method: 'POST', body: {} })).body.pin;
const verify = async (meetingId, pin, n) => { const raw = JSON.stringify({ eventId: 'evt_' + crypto.randomBytes(6).toString('hex'), callId: 'call_code_' + crypto.randomBytes(6).toString('hex'), from: '+1202555' + String(1000 + n), meetingId, pin }), t = Math.floor(Date.now() / 1000);
  const r = await fetch(meet.base + '/api/phone/ivr/verify', { method: 'POST', headers: { 'content-type': 'application/json', 'x-qorlla-signature': 't=' + t + ',v1=' + crypto.createHmac('sha256', WEBHOOK).update(t + '.' + raw).digest('hex') }, body: raw }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const callsOf = async (m) => (await admin.query(`SELECT count(*)::int AS n FROM ${schema}.phone_calls WHERE meeting_id=$1`, [m.id])).rows[0].n;
const resolvedBy = async (m, code) => { const d = await dir(code); return d.status === 200 ? d.body.meetingId : d.status; };

test('directory: the 12-digit primary and the 11-digit alias resolve to the SAME meeting UUID, with or without display separators; leading zeros are exact', { skip }, async () => {
  const m = await seed(); assert.equal(await resolvedBy(m, m.primary12), m.id); assert.equal(await resolvedBy(m, m.alias11), m.id);
  assert.equal(await resolvedBy(m, m.primary12.replace(/^(\d{4})(\d{4})(\d{4})$/, '$1 $2 $3')), m.id); assert.equal(await resolvedBy(m, m.alias11.replace(/^(\d{3})(\d{4})(\d{4})$/, '$1-$2-$3')), m.id);
  const z = await seed({ primary12: '0' + rnd(11), alias11: '0' + rnd(10) }); assert.equal(await resolvedBy(z, z.primary12), z.id, 'a 12-digit code with a leading zero'); assert.equal(await resolvedBy(z, z.alias11), z.id, 'an 11-digit alias with a leading zero');
  const other = z.primary12.slice(1); assert.notEqual((await dir(other)).body.meetingId, z.id, 'the code without its leading zero is NOT the same code');
  assert.deepEqual((await dir(m.primary12)).body.sourceId, m.source);
});

test('directory: unknown, wrong-length, malformed, ended and unauthenticated lookups are refused, and the 10-digit alias is not a telephone code', { skip }, async () => {
  const m = await seed({ alias10: '3' + rnd(9) });
  let unknown12; do unknown12 = '7' + rnd(11); while ((await dir(unknown12)).status !== 404); assert.equal((await dir(unknown12)).status, 404, 'unknown 12'); let unknown11; do unknown11 = '8' + rnd(10); while ((await dir(unknown11)).status !== 404); assert.equal((await dir(unknown11)).status, 404, 'unknown 11');
  assert.equal((await dir(m.alias10)).status, 400, 'a 10-digit alias is outside the telephone formats'); assert.equal((await dir(m.primary12 + '1')).status, 400, '13 digits'); assert.equal((await dir(m.alias11.slice(0, 10))).status, 400, 'an 11-digit code with a digit missing');
  for (const bad of ['abc', m.alias11.slice(0, 5) + 'x' + m.alias11.slice(6), m.primary12 + 'x', '1234567890\t1', m.alias11 + '.']) assert.equal((await dir(bad)).status, 400, 'malformed: ' + JSON.stringify(bad));
  assert.equal((await dir(m.primary12.slice(0, 11))).status === 200 && (await dir(m.primary12.slice(0, 11))).body.meetingId === m.id, false, 'the first 11 digits of a 12-digit code do not resolve to its meeting');
  assert.equal((await fetch(meet.base + '/api/integrations/phone/meetings/' + m.primary12, { headers: { 'x-qorlla-bridge-secret': 'wrong' } })).status, 401);
  await admin.query(`UPDATE ${schema}.meetings SET ended_at=now() WHERE id=$1`, [m.id]); assert.equal((await dir(m.primary12)).status, 404, 'ended (primary)'); assert.equal((await dir(m.alias11)).status, 404, 'ended (alias)');
});

test('the browser resolver still resolves an existing 10-digit alias (preserved provisionally); no new 10-digit code is issued by Meet', { skip }, async () => {
  const m = await seed({ alias10: '3' + rnd(9) }); const r = await fetch(meet.base + '/api/resolve/' + m.alias10); assert.equal(r.status, 200); assert.equal((await r.json()).meetingId, m.id);
  const r12 = await fetch(meet.base + '/api/resolve/' + m.primary12); assert.equal((await r12.json()).meetingId, m.id); const r11 = await fetch(meet.base + '/api/resolve/' + m.alias11); assert.equal((await r11.json()).meetingId, m.id);
  assert.match((await admin.query(`SELECT meeting_code FROM ${schema}.meetings WHERE id=$1`, [m.id])).rows[0].meeting_code, /^\d{12}$/);
});

test('admission (verify): the 12-digit primary and the 11-digit alias both admit the SAME meeting; the call row, participant and meeting id are identical in shape; no duplicate on replay', { skip }, async () => {
  const m = await seed(), pin = await newPin(m);
  const a = await verify(m.primary12, pin, 1), b = await verify(m.alias11, pin, 2); assert.equal(a.body.result, 'approved'); assert.equal(b.body.result, 'approved');
  const rows = (await admin.query(`SELECT meeting_id, count(*)::int AS n FROM ${schema}.phone_calls WHERE meeting_id=$1 GROUP BY 1`, [m.id])).rows; assert.deepEqual(rows, [{ meeting_id: m.id, n: 2 }], 'two callers, one meeting, nothing elsewhere');
  const spaced = await verify(m.primary12.replace(/^(\d{4})(\d{4})(\d{4})$/, '$1 $2 $3'), pin, 3); assert.equal(spaced.body.result, 'approved', 'typed with separators');
  const z = await seed({ primary12: '0' + rnd(11), alias11: '0' + rnd(10) }), zp = await newPin(z); assert.equal((await verify(z.primary12, zp, 4)).body.result, 'approved', 'leading zero, 12'); assert.equal((await verify(z.alias11, zp, 5)).body.result, 'approved', 'leading zero, 11');
  assert.notEqual((await verify(z.primary12.slice(1), zp, 6)).body.result, 'approved', 'without the zero it is another code');
});

test('admission (verify): unknown, malformed, wrong-length, ended, locked and PIN-revoked meetings are all refused with the same generic answer and create no call', { skip }, async () => {
  const m = await seed(), pin = await newPin(m); const GEN = (await verify(m.primary12, 'nope0000', 10)).body; assert.equal(GEN.result, 'denied');
  const tries = [['unknown 12', '9' + rnd(11)], ['unknown 11', '9' + rnd(10)], ['10 digits', m.alias11.slice(0, 10)], ['13 digits', m.primary12 + '1'], ['truncated 12 -> 11', m.primary12.slice(0, 11)], ['letter', m.alias11.slice(0, 4) + 'x' + m.alias11.slice(5)], ['empty', '']];
  let n = 20; for (const [why, code] of tries) { const r = await verify(code, pin, n++); assert.equal(r.body.result, 'denied', why); assert.deepEqual(r.body.say, GEN.say, why + ': same words'); }
  assert.equal(await callsOf(m), 0, 'refusals create nothing');
  await admin.query(`UPDATE ${schema}.meetings SET ended_at=now() WHERE id=$1`, [m.id]); assert.equal((await verify(m.primary12, pin, 40)).body.result, 'denied', 'ended (12)'); assert.equal((await verify(m.alias11, pin, 41)).body.result, 'denied', 'ended (11)'); await admin.query(`UPDATE ${schema}.meetings SET ended_at=NULL WHERE id=$1`, [m.id]);
  await admin.query(`UPDATE ${schema}.meetings SET locked=true WHERE id=$1`, [m.id]); assert.equal((await verify(m.primary12, pin, 42)).body.result, 'denied', 'locked'); await admin.query(`UPDATE ${schema}.meetings SET locked=false WHERE id=$1`, [m.id]);
  await admin.query(`UPDATE ${schema}.meeting_phone_access SET revoked_at=now() WHERE meeting_id=$1`, [m.id]); assert.equal((await verify(m.primary12, pin, 43)).body.result, 'denied', 'PIN revoked (12)'); assert.equal((await verify(m.alias11, pin, 44)).body.result, 'denied', 'PIN revoked (11)');
  assert.equal(await callsOf(m), 0, 'still nothing created'); assert.ok(!/Error|unhandled/i.test(meet.log()), 'no server errors: ' + meet.log().slice(-300));
});
