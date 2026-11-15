import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerBreakouts } from '../server/breakouts.mjs';
import { createMediaRelay, mediaEvidence, principalOf } from '../server/media-relay.mjs';

// Relay-only media for rooms (v4.32). The Voice Engine is replaced by a FAKE http server speaking its /v1/voice/admin/turn/* contract (labelled): this proves OUR scoping, revocation on move/end/leave, fail-closed behaviour
// and honest labels. It says nothing about a real relay (that is the Voice Engine's A3.7.1 suite) and nothing about what media contains. Real PostgreSQL (TEST_PG_URL).
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres';
const SQL = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];
const dbName = 'mr_' + Math.random().toString(36).slice(2, 10), SECRET = 'v'.repeat(40); let admin, pool;
test.before(async () => { admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${dbName}`); pool = new pg.Pool({ connectionString: URL.replace(/\/[^/]*$/, '/' + dbName), max: 8 }); pool.on('error', () => {}); for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8')); });
test.after(async () => { await pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {}); await admin?.end(); });

/** FAKE Voice Engine admin TURN API */
async function fakeVoice() {
  const st = { calls: [], down: false, noTurn: false, observe: {} };
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => (raw += d)); req.on('end', () => {
      const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (st.down) return req.socket.destroy();
      if (req.headers['x-voice-admin-secret'] !== SECRET) return send(401, { error: 'unauthorized' });
      const b = JSON.parse(raw || '{}'); st.calls.push({ path: req.url, body: b });
      if (req.url.endsWith('/meet-credentials')) { if (st.noTurn) return send(503, { error: 'turn_not_configured' }); const principal = principalOf(b.meetingId, b.participantId, b.epoch); return send(200, { principal, iceTransportPolicy: b.relayOnly === false ? 'all' : 'relay', expiresIn: 600, iceServers: [{ urls: ['stun:x'] }, { urls: ['turn:relay.test:3478'], username: '9999:' + principal, credential: 'c-' + b.epoch }] }); }
      if (req.url.endsWith('/revoke')) return send(200, { results: Object.fromEntries(b.principals.map((p) => [p, { mode: 'rest', credentials: 0, sessions: 1, errors: [] }])) });
      if (req.url.endsWith('/observe')) return send(200, { results: Object.fromEntries(b.principals.map((p) => [p, st.observe[p] || { observed: true, allocations: 0, relayedBytes: 0 }])) });
      send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); return { st, url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((r) => server.close(r)) };
}
const quiet = { error() {} };

test('configuration fails closed: a short secret or a non-http URL refuses to start; with no URL the module is simply off', () => {
  assert.throws(() => createMediaRelay({ env: { VOICE_ENGINE_URL: 'http://x', VOICE_ENGINE_ADMIN_SECRET: 'short' } }), /at least 32/); assert.throws(() => createMediaRelay({ env: { VOICE_ENGINE_URL: 'ftp://x', VOICE_ENGINE_ADMIN_SECRET: SECRET } }), /http/);
  const off = createMediaRelay({ env: {} }); assert.equal(off.configured, false);
});

test('credentials name the participant AND the room epoch; relay-only follows ICE_TRANSPORT_POLICY; an unreachable or unconfigured relay is an error, never a direct fallback', async () => {
  const v = await fakeVoice(); const mid = randomUUID(), pid = randomUUID();
  try {
    const r = createMediaRelay({ env: { VOICE_ENGINE_URL: v.url, VOICE_ENGINE_ADMIN_SECRET: SECRET, ICE_TRANSPORT_POLICY: 'relay' }, logger: quiet });
    const ice = await r.iceFor(mid, pid, 3, [{ urls: ['stun:public'] }]); assert.equal(ice.iceTransportPolicy, 'relay'); assert.equal(ice.perEpoch, true); assert.equal(ice.expiresIn, 600);
    assert.deepEqual(ice.iceServers.map((s) => s.urls[0]), ['stun:public', 'turn:relay.test:3478'], 'public STUN kept, only the credentialed relay added'); assert.match(ice.iceServers[1].username, new RegExp(`${mid}:${pid}:3$`));
    assert.deepEqual(v.st.calls[0].body, { meetingId: mid, participantId: pid, epoch: 3, relayOnly: true });
    assert.equal((await createMediaRelay({ env: { VOICE_ENGINE_URL: v.url, VOICE_ENGINE_ADMIN_SECRET: SECRET }, logger: quiet }).iceFor(mid, pid, 1)).iceTransportPolicy, 'all');
    v.st.noTurn = true; await assert.rejects(r.iceFor(mid, pid, 4), (e) => e.code === 'turn_not_configured'); v.st.noTurn = false;
    v.st.down = true; await assert.rejects(r.iceFor(mid, pid, 5), (e) => e.code === 'relay_unreachable'); v.st.down = false;
    await assert.rejects(createMediaRelay({ env: { VOICE_ENGINE_URL: v.url, VOICE_ENGINE_ADMIN_SECRET: 'w'.repeat(40) }, logger: quiet }).iceFor(mid, pid, 1), (e) => e.code === 'relay_refused', 'a wrong secret is refused');
  } finally { await v.close(); }
});

async function rig() {
  const v = await fakeVoice(); const relay = createMediaRelay({ env: { VOICE_ENGINE_URL: v.url, VOICE_ENGINE_ADMIN_SECRET: SECRET, ICE_TRANSPORT_POLICY: 'relay' }, logger: quiet });
  const sent = [], sockMap = new Map(), active = new Map(); const io = { sockets: { sockets: sockMap }, to: (sid) => ({ emit: (type, payload) => sent.push({ sid, type, payload }) }) };
  const fail = (res, status, error) => res.status(status).json({ error }); const app = express(); app.use(express.json());
  const auth = (req, res, next) => { try { req.user = JSON.parse(req.get('x-user')); next(); } catch { fail(res, 401, 'x'); } };
  const member = async (req, res, next) => { const { rows } = await pool.query("SELECT 1 FROM participants WHERE id=$1 AND meeting_id=$2 AND admission='admitted'", [req.user.participantId, req.params.id]); rows.length ? next() : fail(res, 403, 'x'); };
  const b = registerBreakouts({ app, io, db: pool, auth, member, fail, active, room: (id) => 'm:' + id, tickMs: 3600_000, relay, relayObserveMs: 3600_000 });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, path, user, body) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'x-user': JSON.stringify(user) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const mid = randomUUID(), P = {}; await pool.query("INSERT INTO meetings(id,title,host_secret_hash) VALUES($1,'t','x')", [mid]);
  for (const [i, n] of ['Host', 'Ann', 'Bo'].entries()) { const id = randomUUID(); await pool.query('INSERT INTO participants(id,meeting_id,display_name,role,admission) VALUES($1,$2,$3,$4,$5)', [id, mid, n, i ? 'guest' : 'host', 'admitted']); P[n.toLowerCase()] = { id, user: { participantId: id, meetingId: mid, role: i ? 'guest' : 'host', name: n } }; }
  await b.ensure(mid); active.set(mid, new Map()); for (const k of Object.keys(P)) { const sid = 'sock-' + k; active.get(mid).set(P[k].id, sid); sockMap.set(sid, { data: { user: P[k].user } }); }
  const url = (s = '') => `/api/meetings/${mid}/breakouts${s}`;
  return { v, relay, b, call, mid, P, url, close: async () => { b.stop(); await new Promise((r) => server.close(r)); await v.close(); } };
}
const revoked = (v) => v.st.calls.filter((c) => c.path.endsWith('/revoke')).flatMap((c) => c.body.principals);

test('moving rooms revokes the OLD epoch\'s relay credentials; ending the rooms revokes the rest; a person who leaves loses theirs', async () => {
  const t = await rig(); const { v, relay, b, mid, P, url, call } = t;
  const roomA = (await call('POST', url('/rooms'), P.host.user, { name: 'A' })).body.id, roomB = (await call('POST', url('/rooms'), P.host.user, { name: 'B' })).body.id;
  await call('POST', url('/assign'), P.host.user, { participantId: P.ann.id, roomId: roomA }); await call('POST', url('/assign'), P.host.user, { participantId: P.bo.id, roomId: roomA }); await call('POST', url('/start'), P.host.user, { minutes: 10 }); await b.settle(mid);
  await relay.iceFor(mid, P.ann.id, b.epochOf(mid, P.ann.id)); await relay.iceFor(mid, P.bo.id, b.epochOf(mid, P.bo.id)); assert.equal(b.epochOf(mid, P.ann.id), 1);
  await call('POST', url('/assign'), P.host.user, { participantId: P.ann.id, roomId: roomB }); await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(revoked(v), [principalOf(mid, P.ann.id, 1)], 'Ann left room A: her epoch-1 credentials and allocations are cancelled'); assert.equal(b.epochOf(mid, P.ann.id), 2);
  await relay.iceFor(mid, P.ann.id, 2); await relay.revokeParticipant(mid, P.bo.id); assert.ok(revoked(v).includes(principalOf(mid, P.bo.id, 1)), 'leaving revokes');
  await call('POST', url('/recall'), P.host.user, {}); await new Promise((r) => setTimeout(r, 100)); assert.ok(revoked(v).includes(principalOf(mid, P.ann.id, 2)), 'ending the rooms revokes what is left');
  assert.equal((await relay.revokeEpoch(mid, randomUUID(), 1)).revoked, 0, 'nothing that was never handed out is revoked');
  await t.close();
});

test('the host list says only what is known: Client reported, Relay observed, or Media verification unavailable; never "verified"; an unreachable relay is "unobserved", not zero', async () => {
  assert.deepEqual(mediaEvidence({ client: 'switching', relay: null }).labels, ['Media verification unavailable']);
  assert.deepEqual(mediaEvidence({ client: 'client_reported', relay: null }).labels, ['Client reported']);
  assert.deepEqual(mediaEvidence({ client: 'client_reported', relay: { observed: true, allocations: 1, relayedBytes: 10 } }).labels, ['Client reported', 'Relay observed']);
  assert.deepEqual(mediaEvidence({ client: 'switching', relay: { observed: true, allocations: 1, relayedBytes: 0 } }).labels, ['Media verification unavailable'], 'an allocation with no traffic is not "observed media"'); assert.equal(mediaEvidence({ client: 'failed', relay: { observed: false } }).relay, 'unobserved');
  const t = await rig(); const { v, relay, b, mid, P, url, call } = t;
  const a = (await call('POST', url('/rooms'), P.host.user, { name: 'A' })).body.id; await call('POST', url('/assign'), P.host.user, { participantId: P.ann.id, roomId: a }); await call('POST', url('/start'), P.host.user, { minutes: 10 }); await b.settle(mid);
  const ann = async () => (await call('GET', url(''), P.host.user)).body.rooms[0].members.find((m) => m.name === 'Ann');
  const epoch = b.epochOf(mid, P.ann.id); await relay.iceFor(mid, P.ann.id, epoch);
  assert.deepEqual((await ann()).evidence.labels, ['Media verification unavailable']); assert.equal((await ann()).evidence.verified, false);
  b.ready(mid, P.ann.id, { epoch, ok: true }); assert.deepEqual((await ann()).evidence.labels, ['Client reported']);
  v.st.observe[principalOf(mid, P.ann.id, epoch)] = { observed: true, allocations: 2, relayedBytes: 5000 }; assert.equal(await b.observeRelay(), 1);
  assert.deepEqual((await ann()).evidence.labels, ['Client reported', 'Relay observed']); assert.equal((await ann()).evidence.relay, 'traffic');
  await b.settle(mid); await new Promise((r) => setTimeout(r, 100)); assert.equal((await pool.query('SELECT relay_observation FROM more_breakout_moves WHERE meeting_id=$1 AND participant_id=$2 AND epoch=$3', [mid, P.ann.id, epoch])).rows[0].relay_observation, 'traffic_observed');
  v.st.down = true; await b.observeRelay(); assert.equal((await ann()).evidence.relay, 'unobserved'); assert.deepEqual((await ann()).evidence.labels, ['Client reported'], 'an unreachable relay removes "Relay observed" instead of inventing zero traffic'); v.st.down = false;
  await call('POST', url('/assign'), P.host.user, { participantId: P.ann.id, roomId: null }); await new Promise((r) => setTimeout(r, 50));
  assert.notEqual((await call('GET', url(''), P.host.user)).body.unassigned.find((m) => m.name === 'Ann').evidence.relay, 'traffic', 'observations of an old epoch never carry over to the new one');
  await t.close();
});
