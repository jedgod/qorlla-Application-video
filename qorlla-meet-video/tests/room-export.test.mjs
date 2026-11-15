import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerChatExport } from '../server/chat-export.mjs';
import { registerAiConsent } from '../server/ai-consent.mjs';

// v4.32: the read-only exports for the Workplace portal are ROOM-AWARE. Real PostgreSQL (TEST_PG_URL; a scratch database is created and dropped).
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres';
const SQL = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];
const dbName = 'rx_' + Math.random().toString(36).slice(2, 10);
const SECRET = 'r'.repeat(40);
let admin, pool, server, base;
test.before(async () => {
  admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${dbName}`);
  pool = new pg.Pool({ connectionString: URL.replace(/\/[^/]*$/, '/' + dbName), max: 8 }); pool.on('error', () => {});
  for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8'));
  const app = express(); app.use(express.json());
  const fail = (res, status, error) => res.status(status).json({ error });
  const readAuth = (req, res, next) => (req.get('x-qorlla-readonly-secret') === SECRET ? next() : fail(res, 401, 'Read authentication required'));
  registerChatExport({ app, db: pool, readAuth, fail });
  registerAiConsent({ app, io: { to: () => ({ emit() {} }) }, db: pool, auth: (q, s, n) => n(), fail, audit: () => {}, room: (m) => 'meeting:' + m, readAuth, getName: () => 'x' });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => { await new Promise((r) => server?.close(r)); await pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {}); await admin?.end(); });
const get = async (path, secret = SECRET) => { const r = await fetch(base + path, { headers: { 'x-qorlla-readonly-secret': secret } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

async function setup() {
  const mid = randomUUID(); await pool.query("INSERT INTO meetings(id,title,host_secret_hash) VALUES($1,'Workshop','x')", [mid]);
  const P = {}; for (const [i, n] of ['Host', 'Gus', 'Ivy', 'Dana', 'Zed'].entries()) { const id = randomUUID(); await pool.query('INSERT INTO participants(id,meeting_id,display_name,role,admission) VALUES($1,$2,$3,$4,$5)', [id, mid, n, i ? 'guest' : 'host', 'admitted']); P[n] = id; }
  const room = (await pool.query("INSERT INTO more_breakout_rooms(meeting_id,name) VALUES($1,'Design') RETURNING id", [mid])).rows[0].id, other = (await pool.query("INSERT INTO more_breakout_rooms(meeting_id,name) VALUES($1,'Build') RETURNING id", [mid])).rows[0].id;
  const say = (who, text, r = null) => pool.query('INSERT INTO messages(id,meeting_id,participant_id,body,breakout_room) VALUES($1,$2,$3,$4,$5)', [randomUUID(), mid, P[who], text, r]);
  await say('Dana', 'main hello'); await say('Gus', 'room design talk', room); await say('Ivy', 'room design reply', room); await say('Zed', 'other room secret', other);
  return { mid, P, room, other, say };
}

test('chat export: the meeting-wide export holds ONLY the main room; ?room= holds ONLY that room; unknown or malformed rooms are refused', async () => {
  const { mid, room, other } = await setup();
  const all = await get(`/api/integrations/meetings/${mid}/chat`); assert.equal(all.status, 200); assert.deepEqual(all.body.messages.map((m) => m.text), ['main hello']); assert.equal(all.body.roomId, undefined);
  const r1 = await get(`/api/integrations/meetings/${mid}/chat?room=${room}`); assert.equal(r1.status, 200); assert.deepEqual(r1.body.messages.map((m) => m.text), ['room design talk', 'room design reply']); assert.equal(r1.body.roomName, 'Design'); assert.equal(r1.body.roomId, room);
  assert.deepEqual((await get(`/api/integrations/meetings/${mid}/chat?room=${other}`)).body.messages.map((m) => m.text), ['other room secret']);
  assert.equal((await get(`/api/integrations/meetings/${mid}/chat?room=${randomUUID()}`)).status, 404); assert.equal((await get(`/api/integrations/meetings/${mid}/chat?room=nope`)).status, 400);
  const { mid: mid2 } = await setup(); assert.equal((await get(`/api/integrations/meetings/${mid2}/chat?room=${room}`)).status, 404, 'a room of another meeting does not exist here');
  assert.equal((await get(`/api/integrations/meetings/${mid}/chat`, 'wrong')).status, 401);
  await pool.query("UPDATE messages SET deleted_at=now() WHERE body='room design reply'"); assert.deepEqual((await get(`/api/integrations/meetings/${mid}/chat?room=${room}`)).body.messages.map((m) => m.text), ['room design talk'], 'deleted messages are never exported');
});

test('consent export: ?room= lists the people assigned to the room plus everyone who wrote in it, nobody else; unknown rooms are 404', async () => {
  const { mid, P, room, other } = await setup();
  const whole = await get(`/api/integrations/meetings/${mid}/ai-consent`); assert.equal(whole.status, 200); assert.equal(whole.body.participants.length, 5); assert.equal(whole.body.roomId, undefined);
  const r1 = await get(`/api/integrations/meetings/${mid}/ai-consent?room=${room}`); assert.equal(r1.status, 200); assert.equal(r1.body.roomId, room);
  assert.deepEqual(r1.body.participants.map((p) => p.participantId).sort(), [P.Gus, P.Ivy].sort(), 'the two who wrote in the room');
  await pool.query('INSERT INTO more_breakout_assignments(meeting_id,participant_id,room_id) VALUES($1,$2,$3)', [mid, P.Dana, room]);          // Dana was assigned there but has not spoken yet: she still has a say
  assert.deepEqual((await get(`/api/integrations/meetings/${mid}/ai-consent?room=${room}`)).body.participants.map((p) => p.participantId).sort(), [P.Gus, P.Ivy, P.Dana].sort());
  assert.deepEqual((await get(`/api/integrations/meetings/${mid}/ai-consent?room=${other}`)).body.participants.map((p) => p.participantId), [P.Zed]);
  assert.equal((await get(`/api/integrations/meetings/${mid}/ai-consent?room=${randomUUID()}`)).status, 404); assert.equal((await get(`/api/integrations/meetings/${mid}/ai-consent?room=zzz`)).status, 400);
  assert.equal((await get(`/api/integrations/meetings/${mid}/ai-consent`, 'wrong')).status, 401);
  for (const p of r1.body.participants) assert.ok(p.decisions.transcription && p.decisions.summary, 'decisions are present for each purpose');
});

test('rooms export: the portal can list a meeting\'s rooms with message counts only (no text, no names); unknown meeting is 404; the secret is required', async () => {
  const { mid, room, other } = await setup();
  const r = await get(`/api/integrations/meetings/${mid}/rooms`); assert.equal(r.status, 200);
  assert.deepEqual(r.body.rooms.map((x) => [x.id, x.name, x.messages]).sort(), [[room, 'Design', 2], [other, 'Build', 1]].sort());
  assert.equal(JSON.stringify(r.body).includes('room design talk'), false, 'no message text'); assert.equal(JSON.stringify(r.body).includes('Gus'), false, 'no names');
  assert.equal((await get(`/api/integrations/meetings/${randomUUID()}/rooms`)).status, 404); assert.equal((await get(`/api/integrations/meetings/${mid}/rooms`, 'wrong')).status, 401);
});
