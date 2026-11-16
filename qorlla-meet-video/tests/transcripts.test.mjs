import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerTranscripts, TRANSCRIPT_LIMITS } from '../server/transcripts.mjs';

// Consent-gated live transcripts (v4.34). Real PostgreSQL (TEST_PG_URL); the speech engine is a FAKE http server speaking the private engine's contract (labelled): this proves OUR consent gating, epoch fencing,
// race handling and retention. It says nothing about recognition quality, Safari/iOS decoding or a real model.
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres';
const SQL = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];
const dbName = 'tr_' + Math.random().toString(36).slice(2, 10), TOKEN = 't'.repeat(40); let admin, pool;
test.before(async () => { admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${dbName}`); pool = new pg.Pool({ connectionString: URL.replace(/\/[^/]*$/, '/' + dbName), max: 12 }); pool.on('error', () => {}); for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8')); });
test.after(async () => { await pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {}); await admin?.end(); });

async function fakeEngine() {
  const st = { calls: [], delay: 0, fail: false, segments: [{ startMs: 0, endMs: 900, text: 'hello world' }], onCall: null };
  const server = http.createServer((req, res) => { const parts = []; req.on('data', (d) => parts.push(d)); req.on('end', async () => {
    const body = Buffer.concat(parts); st.calls.push({ token: req.headers['x-internal-token'], lang: req.headers['x-language'], type: req.headers['content-type'], bytes: body.length, body });
    if (req.headers['x-internal-token'] !== TOKEN) { res.writeHead(401); return res.end('{}'); } if (st.onCall) await st.onCall(); if (st.delay) await new Promise((r) => setTimeout(r, st.delay));
    if (st.fail) { res.writeHead(500); return res.end('{}'); } res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ segments: st.segments })); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); return { st, url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
const AUDIO = Buffer.alloc(400, 5);

async function rig({ env = {}, limits = TRANSCRIPT_LIMITS } = {}) {
  const eng = await fakeEngine(); const scopes = new Map(), notes = [], audits = []; const fail = (res, status, error) => res.status(status).json({ error });
  const app = express(); app.use(express.json());
  const auth = (req, res, next) => { try { req.user = JSON.parse(req.get('x-user')); next(); } catch { fail(res, 401, 'x'); } };
  const member = async (req, res, next) => { const { rows } = await pool.query("SELECT 1 FROM participants WHERE id=$1 AND meeting_id=$2 AND admission='admitted'", [req.user.participantId, req.params.id]); rows.length ? next() : fail(res, 403, 'x'); };
  const tr = registerTranscripts({ app, db: pool, auth, member, fail, scopeOf: (m, p) => scopes.get(p) ?? null, notify: (...a) => notes.push(a), audit: async (...a) => audits.push(a), env: { MEET_TRANSCRIPT: 'on', STT_URL: eng.url, STT_INTERNAL_TOKEN: TOKEN, ...env }, limits, sweepMs: 3600_000 });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); const base = 'http://127.0.0.1:' + server.address().port;
  const mid = randomUUID(), P = {}; await pool.query("INSERT INTO meetings(id,title,host_secret_hash) VALUES($1,'t','x')", [mid]);
  for (const [i, n] of ['Host', 'Ann', 'Bo'].entries()) { const id = randomUUID(); await pool.query('INSERT INTO participants(id,meeting_id,display_name,role,admission) VALUES($1,$2,$3,$4,$5)', [id, mid, n, i ? 'guest' : 'host', 'admitted']); P[n.toLowerCase()] = { id, name: n, user: { participantId: id, meetingId: mid, role: i ? 'guest' : 'host', name: n } }; await pool.query('INSERT INTO participant_sessions(id,meeting_id,participant_id) VALUES($1,$2,$3)', [randomUUID(), mid, id]); }
  const url = (s = '') => `/api/meetings/${mid}/transcripts${s}`;
  const call = async (method, path, who, body) => { const r = await fetch(base + path, { method, headers: { 'x-user': JSON.stringify(who.user), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; };
  const audio = async (who, sid, epoch, { chunk = randomUUID(), type = 'audio/webm', start = 0, body = AUDIO } = {}) => { const r = await fetch(base + url(`/${sid}/audio`), { method: 'POST', headers: { 'x-user': JSON.stringify(who.user), 'content-type': type, 'x-consent-epoch': String(epoch), 'x-chunk-id': chunk, 'x-chunk-start-ms': String(start) }, body }); return { status: r.status, body: await r.json().catch(() => ({})), chunk }; };
  const join = async (name) => { const id = randomUUID(); await pool.query('INSERT INTO participants(id,meeting_id,display_name,role,admission) VALUES($1,$2,$3,$4,$5)', [id, mid, name, 'guest', 'admitted']); await pool.query('INSERT INTO participant_sessions(id,meeting_id,participant_id) VALUES($1,$2,$3)', [randomUUID(), mid, id]); return { id, name, user: { participantId: id, meetingId: mid, role: 'guest', name } }; };
  const segs = async (sid) => (await pool.query('SELECT * FROM more_transcript_segments WHERE session_id=$1 ORDER BY created_at', [sid])).rows;
  const state = async (sid, who = P.host) => (await call('GET', url(), who)).body.sessions.find((s) => s.id === sid);
  const active = async () => { const s = (await call('POST', url(), P.host, {})).body; for (const k of ['host', 'ann', 'bo']) await call('POST', url(`/${s.id}/consent`), P[k], { consent: true }); return s.id; };
  return { eng, tr, P, mid, url, call, audio, join, segs, state, active, notes, audits, scopes, close: async () => { tr.stop(); await new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }); await eng.close(); } };
}

test('nothing is processed until EVERYBODY present agrees; the engine is never called for a refused chunk; the speaker is the authenticated uploader, never a client claim', async () => {
  const t = await rig(); const { P } = t; assert.equal((await t.call('POST', t.url(), P.ann, {})).status, 403, 'only the host starts a transcript');
  const s = (await t.call('POST', t.url(), P.host, {})).body; assert.equal(s.status, 'awaiting_consent'); assert.equal(s.required, 3); assert.equal(s.agreed, 0); assert.deepEqual(s.waiting.sort(), ['Ann', 'Bo', 'Host']);
  assert.equal((await t.call('POST', t.url(), P.host, {})).status, 409, 'one live transcript per room');
  assert.equal((await t.audio(P.ann, s.id, s.epoch)).status, 409); await t.call('POST', t.url(`/${s.id}/consent`), P.ann, { consent: true }); await t.call('POST', t.url(`/${s.id}/consent`), P.host, { consent: true });
  assert.equal((await t.audio(P.ann, s.id, s.epoch)).status, 409, 'Bo has not answered yet'); assert.equal((await t.audio(P.bo, s.id, s.epoch)).status, 409); assert.equal(t.eng.st.calls.length, 0, 'the engine heard nothing');
  const v = (await t.call('POST', t.url(`/${s.id}/consent`), P.bo, { consent: true })).body; assert.equal(v.status, 'active'); assert.ok(v.epoch > s.epoch, 'activation bumps the epoch'); assert.ok(t.notes.some((n) => n[3]?.status === 'active'), 'everybody is told');
  assert.equal((await t.audio(P.ann, s.id, s.epoch)).status, 409, 'the old epoch is refused'); const ok = await t.audio(P.ann, s.id, v.epoch); assert.equal(ok.status, 200); assert.equal(ok.body.segments, 1);
  const rows = await t.segs(s.id); assert.equal(rows.length, 1); assert.equal(rows[0].speaker_id, P.ann.id); assert.equal(rows[0].text, 'hello world'); assert.equal(t.eng.st.calls.length, 1); assert.equal(t.eng.st.calls[0].bytes, AUDIO.length); assert.equal(t.eng.st.calls[0].token, TOKEN);
  const dup = await t.audio(P.ann, s.id, v.epoch, { chunk: ok.chunk }); assert.equal(dup.body.duplicate, true); assert.equal(t.eng.st.calls.length, 1, 'a retried chunk is not transcribed twice'); assert.equal((await t.segs(s.id)).length, 1);
  const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('more_transcript_chunks','more_transcript_segments','more_transcript_sessions','more_transcript_consents')")).rows.map((r) => r.column_name); assert.ok(!cols.some((c) => /audio|blob|bytea|pcm|wav/.test(c)), 'no table has a place for audio');
  await t.close();
});

test('a person who did not agree is never processed, even while others did; people outside the room cannot take part', async () => {
  const t = await rig(); const { P } = t; const s = (await t.call('POST', t.url(), P.host, {})).body; await t.call('POST', t.url(`/${s.id}/consent`), P.host, { consent: true }); await t.call('POST', t.url(`/${s.id}/consent`), P.ann, { consent: true });
  const no = (await t.call('POST', t.url(`/${s.id}/consent`), P.bo, { consent: false })).body; assert.equal(no.status, 'awaiting_consent'); assert.equal(no.declined, 1);
  for (const who of [P.bo, P.ann, P.host]) assert.notEqual((await t.audio(who, s.id, no.epoch)).status, 200); assert.equal(t.eng.st.calls.length, 0);
  const stranger = { user: { participantId: randomUUID(), meetingId: t.mid, role: 'guest', name: 'X' } }; assert.equal((await t.call('POST', t.url(`/${s.id}/consent`), stranger, { consent: true })).status, 403);
  assert.equal((await t.call('POST', t.url(`/${s.id}/consent`), P.ann, { consent: 'yes' })).status, 400); assert.equal((await t.call('POST', t.url(`/${randomUUID()}/consent`), P.ann, { consent: true })).status, 404);
  await t.close();
});

test('a JOIN pauses the session at once (epoch bumped) - and even if the hook is late, the database re-check refuses the chunk', async () => {
  const t = await rig(); const { P } = t; const sid = await t.active(); const e = (await t.state(sid)).epoch; assert.equal((await t.audio(P.ann, sid, e)).status, 200);
  const cy = await t.join('Cy'); const late = await t.audio(P.ann, sid, e, { start: 4000 }); assert.equal(late.status, 409, 'a newcomer has not agreed: the chunk is refused although nothing told the session yet'); assert.equal(t.eng.st.calls.length, 1);
  assert.equal(await t.tr.reconcileMeeting(t.mid), 1); const paused = await t.state(sid); assert.equal(paused.status, 'paused'); assert.ok(paused.epoch > e); assert.deepEqual(paused.waiting, ['Cy']); assert.ok(t.notes.some((n) => n[3]?.status === 'paused'));
  assert.equal((await t.audio(P.ann, sid, e, { start: 8000 })).status, 409, 'the old epoch is dead'); assert.equal((await t.audio(P.ann, sid, paused.epoch, { start: 8000 })).status, 409);
  await t.call('POST', t.url(`/${sid}/consent`), cy, { consent: true }); const back = await t.state(sid); assert.equal(back.status, 'active'); assert.equal((await t.audio(P.ann, sid, back.epoch, { start: 8000 })).status, 200);
  await pool.query("UPDATE participant_sessions SET disconnected_at=now() WHERE participant_id=$1", [cy.id]); assert.equal(await t.tr.reconcileMeeting(t.mid), 0, 'a LEAVE keeps unanimity: the session carries on'); assert.equal((await t.state(sid)).status, 'active');
  await t.close();
});

test('WITHDRAWAL: the person\'s words are deleted, their capture is refused, the session pauses for everybody, and a result that was in flight is discarded', async () => {
  const t = await rig(); const { P } = t; const sid = await t.active(); let e = (await t.state(sid)).epoch;
  assert.equal((await t.audio(P.ann, sid, e)).status, 200); assert.equal((await t.audio(P.bo, sid, e, { start: 4000 })).status, 200); assert.equal((await t.segs(sid)).length, 2);
  // Bo's chunk is being transcribed when Ann withdraws
  let release; const gate = new Promise((r) => (release = r)); t.eng.st.onCall = () => gate; const inflight = t.audio(P.bo, sid, e, { start: 8000 }); for (let i = 0; i < 100 && t.eng.st.calls.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.eng.st.calls.length, 3, 'the engine has the audio'); const w = (await t.call('POST', t.url(`/${sid}/consent`), P.ann, { consent: false })).body; release(); t.eng.st.onCall = null; const late = await inflight;
  assert.notEqual(late.status, 200, 'the in-flight result was discarded'); assert.equal((await t.segs(sid)).filter((g) => g.speaker_id === P.ann.id).length, 0, 'Ann\'s words were deleted'); assert.equal((await t.segs(sid)).length, 1, 'only Bo\'s earlier line remains; the in-flight one never landed');
  assert.equal(w.status, 'paused'); assert.ok(w.epoch > e); assert.equal((await t.audio(P.ann, sid, w.epoch)).status, 409); assert.equal((await t.audio(P.bo, sid, w.epoch)).status, 409); assert.equal((await t.audio(P.bo, sid, e)).status, 409);
  assert.ok(t.audits.some((a) => a[2] === 'transcript.withdrawn')); await t.call('POST', t.url(`/${sid}/consent`), P.ann, { consent: true }); const again = await t.state(sid); assert.equal(again.status, 'active'); assert.equal((await t.audio(P.bo, sid, again.epoch, { start: 12000 })).status, 200);
  await t.close();
});

test('RACE (serialized in PostgreSQL): while a consent change holds the session row, chunks wait; when it commits they see the new epoch and are refused; a result already in the engine is discarded when the change commits first', async () => {
  const t = await rig(); const { P } = t; const sid = await t.active(); const e = (await t.state(sid)).epoch;
  const hold = async () => { const c = await pool.connect(); await c.query('BEGIN'); await c.query('SELECT * FROM more_transcript_sessions WHERE id=$1 FOR UPDATE', [sid]); return c; };
  const withdraw = async (c) => { await c.query("UPDATE more_transcript_consents SET consent=false WHERE session_id=$1 AND participant_id=$2", [sid, P.ann.id]); await c.query("UPDATE more_transcript_sessions SET status='paused', epoch=epoch+1 WHERE id=$1", [sid]); await c.query('COMMIT'); c.release(); };
  // 1. chunks that arrive WHILE the change is in progress wait for it and are then refused: the engine never hears them
  let c1 = await hold(); const early = Array.from({ length: 6 }, (_, i) => t.audio(P.bo, sid, e, { start: i * 4000 })); let done = 0; early.forEach((p) => p.then(() => done++)); await new Promise((r) => setTimeout(r, 500));
  assert.equal(done, 0, 'every chunk is waiting on the locked session row'); assert.equal(t.eng.st.calls.length, 0); await withdraw(c1); const r1 = await Promise.all(early); assert.deepEqual([...new Set(r1.map((r) => r.status))], [409]); assert.equal(t.eng.st.calls.length, 0, 'the engine never heard them'); assert.equal((await t.segs(sid)).length, 0);
  // 2. a chunk that is ALREADY in the engine when the change commits has its result discarded
  await t.call('POST', t.url(`/${sid}/consent`), P.ann, { consent: true }); const e2 = (await t.state(sid)).epoch; let release; const gate = new Promise((r) => (release = r)); t.eng.st.onCall = () => gate;
  const flying = t.audio(P.bo, sid, e2, { start: 40000 }); for (let i = 0; i < 100 && t.eng.st.calls.length < 1; i++) await new Promise((r) => setTimeout(r, 20)); assert.equal(t.eng.st.calls.length, 1);
  c1 = await hold(); release(); await new Promise((r) => setTimeout(r, 300)); await withdraw(c1); t.eng.st.onCall = null; const r2 = await flying; assert.equal(r2.status, 409, 'its transaction waited for the change, then saw it'); assert.equal((await t.segs(sid)).length, 0, 'the late result was not stored');
  // 3. many concurrent chunks and a real withdrawal: every stored word was stored under an epoch that was valid when it was stored
  await t.call('POST', t.url(`/${sid}/consent`), P.ann, { consent: true }); const e3 = (await t.state(sid)).epoch; t.eng.st.delay = 10;
  const burst = Array.from({ length: 12 }, (_, i) => t.audio(P.bo, sid, e3, { start: i * 4000 })); const wr = t.call('POST', t.url(`/${sid}/consent`), P.ann, { consent: false }); const [res] = await Promise.all([Promise.all(burst), wr]);
  assert.ok(res.every((r) => [200, 409, 429].includes(r.status)), JSON.stringify(res.map((r) => r.status))); for (const g of await t.segs(sid)) assert.equal(Number(g.epoch), e3); const n = (await t.segs(sid)).length; assert.equal((await t.audio(P.bo, sid, e3, { start: 99000 })).status, 409); assert.equal((await t.segs(sid)).length, n, 'nothing lands after the withdrawal');
  await t.close();
});

test('room scope: a room\'s transcript needs the people IN that room; a move out ends that person\'s part, a person elsewhere cannot consent for the room', async () => {
  const t = await rig(); const { P } = t; const roomId = (await pool.query("INSERT INTO more_breakout_rooms(meeting_id,name) VALUES($1,'Design') RETURNING id", [t.mid])).rows[0].id;
  await pool.query("INSERT INTO more_breakout_sessions(meeting_id,state,deadline) VALUES($1,'active', now()+interval '1 hour')", [t.mid]); await pool.query('INSERT INTO more_breakout_assignments(meeting_id,participant_id,room_id) VALUES ($1,$2,$3),($1,$4,$3)', [t.mid, P.ann.id, roomId, P.bo.id]);
  const s = (await t.call('POST', t.url(), P.host, { roomId })).body; assert.equal(s.roomId, roomId); assert.equal(s.required, 2, 'Ann and Bo are in the room; the host is in the main room'); assert.equal((await t.call('POST', t.url(`/${s.id}/consent`), P.host, { consent: true })).status, 403, 'the host is not in this room');
  assert.equal((await t.call('POST', t.url(), P.host, { roomId: randomUUID() })).status, 404); await t.call('POST', t.url(`/${s.id}/consent`), P.ann, { consent: true }); const v = (await t.call('POST', t.url(`/${s.id}/consent`), P.bo, { consent: true })).body; assert.equal(v.status, 'active');
  assert.equal((await t.audio(P.host, s.id, v.epoch)).status, 403, 'the host is outside the room: their audio is not part of it'); assert.equal((await t.audio(P.ann, s.id, v.epoch)).status, 200);
  await pool.query('UPDATE more_breakout_assignments SET room_id=NULL WHERE participant_id=$1', [P.bo.id]); assert.equal((await t.audio(P.bo, s.id, v.epoch)).status, 403, 'Bo moved out: the chunk is refused straight away'); await t.tr.reconcileMeeting(t.mid);
  assert.equal((await t.state(s.id)).required, 1); assert.equal((await t.state(s.id)).status, 'active', 'the one person left in the room agreed');
  const mainOne = (await t.call('POST', t.url(), P.host, { roomId: 'main' })); assert.equal(mainOne.status, 201); assert.equal(mainOne.body.roomId, null); assert.equal(mainOne.body.required, 2, 'the host and Bo are in the main room');
  await t.close();
});

test('who may read a transcript: the host and the people who agreed to THAT session; withdrawal and retention remove data; engine failures store nothing', async () => {
  const t = await rig(); const { P } = t; const sid = await t.active(); const e = (await t.state(sid)).epoch; await t.audio(P.ann, sid, e); const cy = await t.join('Cy');
  assert.equal((await t.call('GET', t.url(`/${sid}`), cy)).status, 404, 'a person who never agreed sees nothing'); const g = (await t.call('GET', t.url(`/${sid}`), P.bo)).body; assert.deepEqual(g.segments.map((x) => [x.speaker, x.text]), [['Ann', 'hello world']]);
  assert.equal((await t.call('GET', t.url(`/${sid}/export.txt`), P.host)).status, 200); assert.equal((await t.call('GET', t.url(`/${sid}/export.txt`), cy)).status, 404);
  assert.equal((await t.call('GET', t.url('/not-a-uuid'), P.host)).status, 400);
  await t.call('POST', t.url(`/${sid}/consent`), cy, { consent: true }); const e2 = (await t.state(sid)).epoch; t.eng.st.fail = true; const fail = await t.audio(P.ann, sid, e2, { start: 4000 }); assert.equal(fail.status, 502); assert.equal((await t.segs(sid)).length, 1, 'an engine failure stores nothing'); t.eng.st.fail = false;
  assert.equal((await t.call('POST', t.url(`/${sid}/stop`), P.ann, {})).status, 403); assert.equal((await t.call('POST', t.url(`/${sid}/stop`), P.host, {})).status, 200); assert.equal((await t.audio(P.ann, sid, e2 + 1, { start: 8000 })).status, 409); assert.equal((await t.call('POST', t.url(`/${sid}/consent`), P.ann, { consent: true })).status, 409);
  assert.equal((await t.call('GET', t.url(`/${sid}`), P.ann)).status, 200, 'a finished transcript stays readable to the people who agreed to it');
  await pool.query("UPDATE more_transcript_sessions SET expires_at=now() - interval '1 hour' WHERE id=$1", [sid]); const out = await t.tr.sweep(); assert.ok(out.purged >= 1); assert.equal((await t.segs(sid)).length, 0, 'retention deleted the transcript with the session'); assert.equal((await t.call('GET', t.url(`/${sid}`), P.host)).status, 404);
  await t.close();
});

test('input hardening: audio type, size, epoch, ids and rate are validated before any consent work; the engine address and token are fixed server-side', async () => {
  const t = await rig({ limits: { ...TRANSCRIPT_LIMITS, chunksPerMinute: 4 } }); const { P } = t; const sid = await t.active(); const e = (await t.state(sid)).epoch;
  assert.equal((await t.audio(P.ann, sid, e, { type: 'text/plain' })).status, 415); assert.equal((await t.audio(P.ann, sid, e, { body: Buffer.alloc(10) })).status, 413); assert.equal((await t.audio(P.ann, sid, e, { body: Buffer.alloc(3_000_000) })).status, 413);
  assert.equal((await t.audio(P.ann, sid, 0)).status, 400); assert.equal((await t.audio(P.ann, sid, e, { chunk: 'nope' })).status, 400); assert.equal((await t.audio(P.ann, sid, e, { start: -5 })).status, 400); assert.equal(t.eng.st.calls.length, 0);
  for (let i = 0; i < 4; i++) await t.audio(P.ann, sid, e, { start: i * 4000 }); assert.equal((await t.audio(P.ann, sid, e, { start: 99000 })).status, 429);
  assert.ok(t.eng.st.calls.every((c) => c.token === TOKEN && c.lang === 'en'));
  await t.close();
});

test('disabled by default: without MEET_TRANSCRIPT=on, STT_URL and a 32-character token every route answers 503 and nothing is created', async () => {
  for (const env of [{ MEET_TRANSCRIPT: 'off' }, { STT_INTERNAL_TOKEN: 'short' }, { STT_URL: 'not-a-url' }]) { const t = await rig({ env }); assert.equal(t.tr.enabled, false); assert.equal((await t.call('POST', t.url(), t.P.host, {})).status, 503); assert.equal((await pool.query('SELECT count(*)::int n FROM more_transcript_sessions WHERE meeting_id=$1', [t.mid])).rows[0].n, 0); await t.close(); }
});
