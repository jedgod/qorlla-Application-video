import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerMore, validateOp, BOARD } from '../server/more.mjs';

// Meet More tab (v4.27) against a REAL PostgreSQL (TEST_PG_URL; a scratch database is created and dropped). auth/member are the same stand-ins the chat tests use:
// the identity comes from a header instead of a signed token, but the admitted-participant SQL is the real one.
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres';
const SQL = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];
const dbName = 'more_' + Math.random().toString(36).slice(2, 10);
let admin, pool, server, base; const events = [];
test.before(async () => {
  admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${dbName}`);
  pool = new pg.Pool({ connectionString: URL.replace(/\/[^/]*$/, '/' + dbName), max: 8 }); pool.on('error', () => {});
  for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8'));
  const fail = (res, status, error) => res.status(status).json({ error });
  const app = express(); app.use(express.json({ limit: '32kb' }));
  const auth = (req, res, next) => { try { req.user = JSON.parse(req.get('x-user')); next(); } catch { fail(res, 401, 'Authentication required'); } };
  const member = async (req, res, next) => {
    if (req.user.meetingId !== req.params.id) return fail(res, 403, 'Wrong meeting');
    const { rows } = await pool.query("SELECT m.ended_at, p.id FROM meetings m JOIN participants p ON p.meeting_id=m.id WHERE m.id=$1 AND p.id=$2 AND p.admission='admitted'", [req.params.id, req.user.participantId]);
    if (!rows.length || rows[0].ended_at) return fail(res, 403, 'Meeting unavailable'); next();
  };
  const io = { to: (target) => ({ emit: (type, payload) => events.push({ target, type, payload }) }) };
  registerMore({ app, io, db: pool, auth, member, room: (id) => 'meeting:' + id, fail });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => { await new Promise((r) => server?.close(r)); await pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {}); await admin?.end(); });

async function meeting() {
  const mid = randomUUID(), host = randomUUID(), ann = randomUUID(), bo = randomUUID(), waiting = randomUUID();
  await pool.query("INSERT INTO meetings(id,title,host_secret_hash) VALUES($1,'t','x')", [mid]);
  for (const [id, role, n, adm] of [[host, 'host', 'Host', 'admitted'], [ann, 'guest', 'Ann', 'admitted'], [bo, 'guest', 'Bo', 'admitted'], [waiting, 'guest', 'Wes', 'waiting']]) await pool.query('INSERT INTO participants(id,meeting_id,display_name,role,admission) VALUES($1,$2,$3,$4,$5)', [id, mid, n, role, adm]);
  const u = (participantId, role = 'guest') => ({ meetingId: mid, participantId, role });
  return { mid, host: u(host, 'host'), ann: u(ann), bo: u(bo), waiting: u(waiting), ids: { host, ann, bo, waiting } };
}
const call = async (method, path, user, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-user': JSON.stringify(user) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const P = (m, s = '') => `/api/meetings/${m.mid}/more${s}`;

test('state: real features are on, unbuilt ones say so (never a fake success)', async () => {
  const m = await meeting(); const s = await call('GET', P(m, '/state'), m.ann);
  assert.equal(s.status, 200); assert.equal(s.body.features.qa, true); assert.equal(s.body.features.timer, true); assert.equal(s.body.features.whiteboard, true); assert.equal(s.body.features.breakouts, false); assert.equal(s.body.features.files, false); assert.equal(s.body.features.ai, false); assert.equal(s.body.timer.running, false);
  for (const k of ['breakouts', 'files', 'transcript', 'ai', 'background']) assert.equal((await call('GET', P(m, '/' + k), m.host)).status, 503);
});

test('access: no token, wrong meeting and a participant who is still waiting are all refused', async () => {
  const m = await meeting(), other = await meeting();
  assert.equal((await call('GET', P(m, '/state'))).status, 401);
  assert.equal((await call('GET', P(m, '/state'), other.ann)).status, 403);
  assert.equal((await call('GET', P(m, '/questions'), m.waiting)).status, 403);
  assert.equal((await call('POST', P(m, '/questions'), m.waiting, { question: 'let me in' })).status, 403);
  assert.equal((await call('GET', P(m, '/timer'), m.waiting)).status, 403);
});

test('Q&A: ask, vote (toggle), host answers and hides; guests cannot moderate; another meeting sees nothing', async () => {
  const m = await meeting(), other = await meeting();
  const q = await call('POST', P(m, '/questions'), m.ann, { question: '  Is the recording shared?  ' }); assert.equal(q.status, 201);
  assert.equal((await call('POST', P(m, '/questions'), m.ann, { question: '   ' })).status, 400);
  assert.equal((await call('POST', P(m, '/questions'), m.ann, { question: 'x'.repeat(2001) })).status, 400);
  let list = (await call('GET', P(m, '/questions'), m.bo)).body.questions; assert.equal(list.length, 1); assert.equal(list[0].question, 'Is the recording shared?'); assert.equal(list[0].author, 'Ann'); assert.equal(list[0].votes, 0);
  assert.equal((await call('POST', P(m, `/questions/${q.body.id}/vote`), m.bo, {})).body.voted, true);
  list = (await call('GET', P(m, '/questions'), m.bo)).body.questions; assert.equal(list[0].votes, 1); assert.equal(list[0].voted, true);
  assert.equal((await call('POST', P(m, `/questions/${q.body.id}/vote`), m.bo, {})).body.voted, false);                       // the same call again takes the vote back
  assert.equal((await call('POST', P(m, `/questions/${q.body.id}/vote`), m.bo, {})).body.voted, true); assert.equal((await call('POST', P(m, `/questions/${q.body.id}/vote`), m.ann, {})).body.voted, true);
  assert.equal((await call('GET', P(m, '/questions'), m.host)).body.questions[0].votes, 2);
  assert.equal((await call('POST', P(m, `/questions/${q.body.id}/answer`), m.ann, { answer: 'I am a guest' })).status, 403);
  assert.equal((await call('POST', P(m, `/questions/${q.body.id}/hide`), m.bo, {})).status, 403);
  assert.equal((await call('POST', P(m, `/questions/${q.body.id}/answer`), m.host, { answer: '' })).status, 400);
  assert.equal((await call('POST', P(m, `/questions/${q.body.id}/answer`), m.host, { answer: 'Yes, to the host only.' })).status, 200);
  list = (await call('GET', P(m, '/questions'), m.ann)).body.questions; assert.equal(list[0].state, 'answered'); assert.equal(list[0].answer, 'Yes, to the host only.');
  assert.equal((await call('POST', P(m, `/questions/${q.body.id}/hide`), m.host, {})).status, 200);
  assert.equal((await call('GET', P(m, '/questions'), m.bo)).body.questions.length, 0);                                           // hidden for guests
  assert.equal((await call('GET', P(m, '/questions'), m.host)).body.questions[0].state, 'hidden');                                // the host still sees it
  assert.equal((await call('POST', P(m, `/questions/${q.body.id}/vote`), m.bo, {})).status, 404);                                  // nobody can vote on a hidden question
  assert.equal((await call('POST', P(m, `/questions/${q.body.id}/hide`), m.host, { hidden: false })).status, 200); assert.equal((await call('GET', P(m, '/questions'), m.bo)).body.questions[0].state, 'answered');
  assert.equal((await call('POST', P(m, '/questions/not-a-uuid/vote'), m.bo, {})).status, 400);
  assert.equal((await call('POST', P(other, `/questions/${q.body.id}/answer`), other.host, { answer: 'cross-meeting' })).status, 404);   // a question id from another meeting is not reachable
  assert.equal((await call('GET', P(other, '/questions'), other.host)).body.questions.length, 0);
});

test('timer: only the host runs it, the server owns the clock, limits are enforced, everyone is told', async () => {
  const m = await meeting(); events.length = 0;
  assert.equal((await call('POST', P(m, '/timer'), m.ann, { action: 'start', seconds: 60 })).status, 403);
  assert.equal((await call('POST', P(m, '/timer'), m.host, { action: 'start', seconds: 5 })).status, 400);
  assert.equal((await call('POST', P(m, '/timer'), m.host, { action: 'start', seconds: 99999 })).status, 400);
  assert.equal((await call('POST', P(m, '/timer'), m.host, { action: 'start', seconds: '60' })).status, 400);
  assert.equal((await call('POST', P(m, '/timer'), m.host, { action: 'explode' })).status, 400);
  const t = await call('POST', P(m, '/timer'), m.host, { action: 'start', seconds: 90 }); assert.equal(t.status, 200); assert.equal(t.body.running, true);
  const left = (Date.parse(t.body.endsAt) - Date.parse(t.body.serverNow)) / 1000; assert.ok(left > 85 && left <= 90, 'about 90 seconds left on the SERVER clock: ' + left);
  assert.ok(events.some((e) => e.target === 'meeting:' + m.mid && e.type === 'more' && e.payload.kind === 'timer' && e.payload.payload.running === true));
  const seen = (await call('GET', P(m, '/timer'), m.bo)).body; assert.equal(seen.running, true); assert.equal(seen.endsAt, t.body.endsAt);
  assert.equal((await call('POST', P(m, '/timer'), m.host, { action: 'stop' })).body.running, false); assert.equal((await call('GET', P(m, '/timer'), m.ann)).body.running, false);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM more_events WHERE meeting_id=$1 AND kind='timer'", [m.mid]); assert.equal(rows[0].n, 2);                       // the durable log has both
  const log = (await call('GET', P(m, '/events?after=0'), m.ann)).body.events; assert.equal(log.filter((e) => e.kind === 'timer').length, 2);
});

test('preferences: saved per person and per meeting; bad values are refused', async () => {
  const m = await meeting(), other = await meeting();
  assert.equal((await call('PUT', P(m, '/preferences'), m.ann, { layout: 'speaker', focusMode: true })).body.layout, 'speaker');
  assert.equal((await call('PUT', P(m, '/preferences'), m.ann, { focusMode: false })).body.layout, 'speaker');                               // a partial update keeps the rest
  assert.equal((await call('PUT', P(m, '/preferences'), m.ann, { layout: 'cinema' })).status, 400); assert.equal((await call('PUT', P(m, '/preferences'), m.ann, {})).status, 400);
  assert.equal((await call('GET', P(m, '/state'), m.ann)).body.preferences.layout, 'speaker'); assert.equal((await call('GET', P(m, '/state'), m.bo)).body.preferences.layout, null);      // not Bo's
  assert.equal((await call('GET', P(other, '/state'), other.ann)).body.preferences.layout, null);
});

test('attendance: host only, from the connection sessions Meet records', async () => {
  const m = await meeting();
  await pool.query("INSERT INTO participant_sessions(id,meeting_id,participant_id,connected_at,disconnected_at) VALUES($1,$2,$3,now()-interval '20 minutes',now()-interval '5 minutes')", [randomUUID(), m.mid, m.ids.ann]);
  await pool.query("INSERT INTO participant_sessions(id,meeting_id,participant_id,connected_at) VALUES($1,$2,$3,now()-interval '10 minutes')", [randomUUID(), m.mid, m.ids.host]);
  assert.equal((await call('GET', P(m, '/attendance'), m.ann)).status, 403);
  const a = (await call('GET', P(m, '/attendance'), m.host)).body.attendance; const ann = a.find((x) => x.name === 'Ann'), host = a.find((x) => x.name === 'Host');
  assert.equal(ann.online, false); assert.ok(ann.seconds >= 14 * 60 && ann.seconds <= 16 * 60); assert.equal(host.online, true); assert.equal(a.some((x) => x.name === 'Wes'), false);       // the waiting guest was never admitted
});

test('whiteboard: validation is strict (bounds, colours, ids, shapes)', () => {
  const good = { t: 'stroke', id: 'o1234567890abcdef', c: '#112233', w: 4, p: [[1, 2], [3, 4]] };
  assert.deepEqual(validateOp(good), good);
  for (const bad of [null, [], {}, { ...good, t: 'script' }, { ...good, id: 'x' }, { ...good, id: '<img onerror=1>' }, { ...good, c: 'red' }, { ...good, c: '#12345' }, { ...good, w: 0 }, { ...good, w: 99 }, { ...good, p: [] },
    { ...good, p: [[1, 2, 3]] }, { ...good, p: [[BOARD.w + 1, 0]] }, { ...good, p: [[NaN, 0]] }, { ...good, p: Array.from({ length: BOARD.maxPoints + 1 }, () => [1, 1]) },
    { t: 'shape', id: 'o1234567890abcdef', k: 'star', c: '#000000', w: 2, x1: 0, y1: 0, x2: 1, y2: 1 }, { t: 'text', id: 'o1234567890abcdef', s: '   ', c: '#000000', x: 1, y: 1, z: 20 },
    { t: 'text', id: 'o1234567890abcdef', s: 'x'.repeat(201), c: '#000000', x: 1, y: 1, z: 20 }, { t: 'text', id: 'o1234567890abcdef', s: 'ok', c: '#000000', x: 1, y: 1, z: 5 }, { t: 'erase', id: 'o1234567890abcdef' }]) assert.equal(validateOp(bad), null, JSON.stringify(bad).slice(0, 60));
  assert.deepEqual(validateOp({ t: 'clear', junk: 1 }), { t: 'clear' }); assert.deepEqual(validateOp({ t: 'erase', id: 'o1234567890abcdef', target: 'o0000000000000001' }), { t: 'erase', id: 'o1234567890abcdef', target: 'o0000000000000001' });
  assert.equal(validateOp({ t: 'text', id: 'o1234567890abcdef', s: '  hello ', c: '#000000', x: 5, y: 5, z: 24 }).s, 'hello');
});

test('whiteboard: host opens and controls it; guests draw only while allowed; replay from a cursor; clear is host only; another meeting is separate', async () => {
  const m = await meeting(), other = await meeting(); events.length = 0;
  const stroke = (id) => ({ t: 'stroke', id, c: '#dc2626', w: 4, p: [[10, 10], [50, 50]] });
  assert.equal((await call('GET', P(m, '/whiteboard'), m.ann)).body.board, null);
  assert.equal((await call('POST', P(m, '/whiteboard'), m.ann, { action: 'open' })).status, 403);
  assert.equal((await call('POST', P(m, '/whiteboard/ops'), m.host, { op: stroke('oaaaaaaaaaaaa001') })).status, 409);
  assert.equal((await call('POST', P(m, '/whiteboard'), m.host, { action: 'open' })).body.board.state, 'open'); assert.ok(events.some((e) => e.payload.kind === 'whiteboard.state'));
  assert.equal((await call('POST', P(m, '/whiteboard'), m.host, { action: 'bogus' })).status, 400);
  assert.equal((await call('POST', P(m, '/whiteboard/ops'), m.ann, { op: stroke('oaaaaaaaaaaaa002') })).status, 201);
  assert.equal((await call('POST', P(m, '/whiteboard/ops'), m.ann, { op: { ...stroke('oaaaaaaaaaaaa003'), c: 'javascript:1' } })).status, 400);
  assert.equal((await call('POST', P(m, '/whiteboard/ops'), m.waiting, { op: stroke('oaaaaaaaaaaaa004') })).status, 403);
  assert.equal((await call('POST', P(m, '/whiteboard/ops'), m.ann, { op: { t: 'clear' } })).status, 403);
  assert.equal((await call('POST', P(m, '/whiteboard'), m.host, { action: 'draw', allow: false })).body.board.allowDraw, false);
  assert.equal((await call('POST', P(m, '/whiteboard/ops'), m.bo, { op: stroke('oaaaaaaaaaaaa005') })).status, 403);
  assert.equal((await call('POST', P(m, '/whiteboard/ops'), m.host, { op: stroke('oaaaaaaaaaaaa006') })).status, 201);
  const all = (await call('GET', P(m, '/whiteboard'), m.bo)).body; assert.equal(all.ops.length, 2); assert.equal(all.ops[0].by, 'Ann'); assert.equal(all.ops[0].mine, false); assert.equal(all.board.allowDraw, false);
  const tail = (await call('GET', P(m, '/whiteboard?after=' + all.ops[0].seq), m.bo)).body; assert.equal(tail.ops.length, 1); assert.equal(tail.ops[0].op.id, 'oaaaaaaaaaaaa006');
  assert.equal((await call('GET', P(m, '/whiteboard?after=-1'), m.bo)).status, 400);
  assert.equal((await call('POST', P(m, '/whiteboard/ops'), m.host, { op: { t: 'erase', id: 'oaaaaaaaaaaaa007', target: 'oaaaaaaaaaaaa002' } })).status, 201);
  assert.equal((await call('POST', P(m, '/whiteboard/ops'), m.host, { op: { t: 'clear' } })).status, 201);
  assert.ok(events.some((e) => e.payload.kind === 'whiteboard.op'));
  assert.equal((await call('POST', P(m, '/whiteboard'), m.host, { action: 'close' })).body.board.state, 'closed'); assert.equal((await call('POST', P(m, '/whiteboard/ops'), m.host, { op: stroke('oaaaaaaaaaaaa008') })).status, 409);
  assert.equal((await call('GET', P(other, '/whiteboard'), other.host)).body.board, null);
});

test('Q&A: anonymous questions hide the name from guests but not from the host or the asker', async () => {
  const m = await meeting();
  const q = await call('POST', P(m, '/questions'), m.ann, { question: 'Who decides?', anonymous: true }); assert.equal(q.status, 201);
  await call('POST', P(m, '/questions'), m.ann, { question: 'Named question' });
  const seen = async (u) => (await call('GET', P(m, '/questions'), u)).body.questions.find((x) => x.question === 'Who decides?');
  assert.equal((await seen(m.bo)).author, 'Anonymous'); assert.equal((await seen(m.bo)).anonymous, true);
  assert.match((await seen(m.host)).author, /Ann/); assert.match((await seen(m.ann)).author, /Ann/);
  assert.equal((await call('GET', P(m, '/questions'), m.bo)).body.questions.find((x) => x.question === 'Named question').author, 'Ann');
});
