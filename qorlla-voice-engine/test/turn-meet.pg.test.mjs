// Meet media credentials (v4.32) on the Voice Engine's own TURN services. A REAL engine on real PostgreSQL over real HTTP; the relay is replaced by a FAKE coturn admin CLI and a FAKE Redis (labelled): this proves
// OUR scoping, authentication, revocation and observation logic. It says nothing about a real relay (the A3.7.1 suite covers that) and nothing about what media contains.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createStore } from '../src/store.mjs';
import { makeAuthenticator } from '../src/auth.mjs';
import { createVoiceApp } from '../src/app.mjs';
import { createTurnControl, parseSessionUsage } from '../src/turn.mjs';
import { isolatedDb, identityProvider } from './helpers.mjs';

const ORIGIN = 'https://app.qorlla.test', ADMIN = 'a'.repeat(40), SHARED = 's'.repeat(40), CLIPW = 'cli-password';
const MEETING = randomUUID(), P1 = randomUUID(), P2 = randomUUID();

/** FAKE coturn admin CLI: password prompt, "> " prompts, `ps <user>`, `psp :<account>`, `cs <id>`. */
function fakeCli(sessions) {
  const server = net.createServer((sock) => {
    let stage = 'pw', buf = ''; sock.write('Enter password: ');
    sock.on('data', (d) => {
      buf += d.toString().replace(/\r/g, '');
      while (buf.includes('\n')) {
        const line = buf.slice(0, buf.indexOf('\n')).trim(); buf = buf.slice(buf.indexOf('\n') + 1);
        if (stage === 'pw') { if (line !== CLIPW) { sock.write('Enter password: '); continue; } stage = 'cmd'; sock.write('\n> '); continue; }
        if (line === 'quit') return sock.end();
        let hit = [];
        if (line.startsWith('ps ')) hit = sessions.filter((s) => s.user === line.slice(3)); else if (line.startsWith('psp :')) hit = sessions.filter((s) => s.user.endsWith(line.slice(4)));
        else if (line.startsWith('cs ')) { const i = sessions.findIndex((s) => s.id === line.slice(3)); if (i >= 0) sessions.splice(i, 1); }
        const text = hit.map((s, i) => `  ${i + 1}) id=${s.id}, user <${s.user}>:\n      realm=qorlla\n      usage: rp=${s.rp || 0}, rb=${s.rb || 0}, sp=${s.sp || 0}, sb=${s.sb || 0}\n`).join('');
        sock.write(text + '\n> ');
      }
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port, sessions })));
}
/** FAKE Redis: only what turn.mjs uses. */
function fakeRedis(store = { kv: new Map(), sets: new Map() }) {
  const chain = (ops) => new Proxy({}, { get: (_t, k) => (k === 'exec' ? async () => { for (const f of ops) await f(); } : (...a) => { ops.push(() => api[k](...a)); return chain(ops); }) });
  const api = {
    on() {}, async connect() {}, async quit() {}, async get(k) { return store.kv.get(k) ?? null; }, async set(k, v) { store.kv.set(k, v); }, async exists(k) { return store.kv.has(k) ? 1 : 0; },
    async sAdd(k, v) { (store.sets.get(k) || store.sets.set(k, new Set()).get(k)).add(v); }, async expire() {}, async sMembers(k) { return [...(store.sets.get(k) || [])]; },
    async del(k) { for (const x of [].concat(k)) { store.kv.delete(x); store.sets.delete(x); } }, multi() { return chain([]); }
  };
  return api;
}

let db, idp, cli, voice, base, env;
before(async () => {
  db = await isolatedDb(); if (!db) return;
  idp = await identityProvider(); cli = await fakeCli([]);
  env = { VOICE_JWKS_URL: idp.jwksUrl, VOICE_JWT_ISSUER: 'qorlla-main', VOICE_JWT_AUDIENCE: 'qorlla-voice', VOICE_ALLOWED_ORIGIN: ORIGIN, VOICE_ADMIN_SECRET: ADMIN, TURN_URLS: 'turn:turn.qorlla.test:3478', TURN_SHARED_SECRET: SHARED,
    TURN_CLI_HOST: '127.0.0.1', TURN_CLI_PORT: String(cli.port), TURN_CLI_PASSWORD: CLIPW };
  voice = createVoiceApp({ store: createStore(db.pool), db: db.pool, authenticate: makeAuthenticator(env), env, maintenanceMs: 150000 });
  base = 'http://127.0.0.1:' + (await voice.listen(0, '127.0.0.1'));
});
after(async () => { if (voice) await voice.close(); if (cli) await new Promise((r) => cli.server.close(r)); if (idp) await idp.close(); if (db) await db.drop(); });
const skip = (t) => !db && t.skip('no PostgreSQL reachable (set VOICE_TEST_DATABASE_URL)');
const call = async (path, body, secret = ADMIN) => { const r = await fetch(base + '/v1/voice/admin/turn' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-voice-admin-secret': secret } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const ask = (epoch = 1, who = P1, extra = {}) => call('/meet-credentials', { meetingId: MEETING, participantId: who, epoch, ...extra });

test('coturn usage lines parse into allocations and bytes; garbage parses to nothing', () => {
  const text = '  1) id=0030, user <q1>:\n      usage: rp=3, rb=300, sp=4, sb=400\n  2) id=0031, user <q2>:\n      no usage here\n';
  assert.deepEqual(parseSessionUsage(text), [{ id: '0030', user: 'q1', packets: 7, bytes: 700 }, { id: '0031', user: 'q2', packets: 0, bytes: 0 }]); assert.deepEqual(parseSessionUsage('nothing'), []);
});

test('meet credentials: admin only, one participant in one room epoch, short-lived, relay-only unless the caller says otherwise, never cached', async (t) => {
  if (skip(t)) return;
  assert.equal((await ask(1, P1, {})).status, 200); assert.equal((await call('/meet-credentials', { meetingId: MEETING, participantId: P1, epoch: 1 }, null)).status, 401, 'no secret');
  assert.equal((await call('/meet-credentials', { meetingId: MEETING, participantId: P1, epoch: 1 }, 'wrong'.repeat(9))).status, 401);
  const r = await ask(3, P1); assert.equal(r.status, 200); const t0 = r.body.iceServers.find((s) => s.username);
  assert.equal(r.body.iceTransportPolicy, 'relay'); assert.equal(r.body.principal, `meet:${MEETING}:${P1}:3`); assert.ok(r.body.expiresIn <= 600); const life = Number(t0.username.split(':')[0]) - Math.floor(Date.now() / 1000); assert.ok(life > 240 && life <= 300, 'REST credentials live 5 minutes by default (' + life + 's)'); assert.match(t0.username, new RegExp(`:meet:${MEETING}:${P1}:3$`), 'the credential names the participant AND the epoch');
  assert.equal((await ask(3, P1, { relayOnly: false })).body.iceTransportPolicy, 'all');
  const other = (await ask(3, P2)).body.iceServers.find((s) => s.username); assert.notEqual(other.username, t0.username); assert.notEqual(other.credential, t0.credential);
  const next = (await ask(4, P1)).body.iceServers.find((s) => s.username); assert.notEqual(next.credential, t0.credential, 'a new epoch is a new credential');
  for (const bad of [{ meetingId: 'x', participantId: P1, epoch: 1 }, { meetingId: MEETING, participantId: 'y', epoch: 1 }, { meetingId: MEETING, participantId: P1, epoch: -1 }, { meetingId: MEETING, participantId: P1, epoch: 'a' }, { meetingId: MEETING, participantId: P1 }, null])
    assert.equal((await call('/meet-credentials', bad)).status, 400);
  const raw = await fetch(base + '/v1/voice/admin/turn/meet-credentials', { method: 'POST', headers: { 'content-type': 'application/json', 'x-voice-admin-secret': ADMIN }, body: JSON.stringify({ meetingId: MEETING, participantId: P1, epoch: 1 }) }); assert.match(raw.headers.get('cache-control'), /no-store/);
  const idToken = await idp.token('some-user'); assert.equal((await fetch(base + '/v1/voice/admin/turn/meet-credentials', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + idToken }, body: '{}' })).status, 401, 'an ordinary signed-in user is not an admin');
});

test('observe and revoke: the relay\'s own allocations are reported per principal; revoking cancels exactly that principal\'s allocations and nothing else', async (t) => {
  if (skip(t)) return;
  const p = (e, w) => `meet:${MEETING}:${w}:${e}`; const exp = Math.floor(Date.now() / 1000) + 600;
  cli.sessions.push({ id: '0001', user: `${exp}:${p(1, P1)}`, rb: 1000, sb: 500 }, { id: '0002', user: `${exp}:${p(2, P1)}`, rb: 10, sb: 10 }, { id: '0003', user: `${exp}:${p(1, P2)}`, rb: 1, sb: 1 });
  let o = await call('/observe', { principals: [p(1, P1), p(2, P1), p(9, P2)] }); assert.equal(o.status, 200);
  const r1 = o.body.results[p(1, P1)]; assert.equal(r1.observed, true); assert.equal(r1.allocations, 1); assert.equal(r1.relayedBytes, 1500); assert.equal(r1.mode, 'rest');
  assert.equal(o.body.results[p(2, P1)].allocations, 1); assert.equal(o.body.results[p(9, P2)].allocations, 0); assert.match(o.body.note, /not proof/);
  const rv = await call('/revoke', { principals: [p(1, P1)] }); assert.equal(rv.status, 200); assert.equal(rv.body.results[p(1, P1)].sessions, 1); assert.deepEqual(rv.body.results[p(1, P1)].errors, []);
  assert.deepEqual(cli.sessions.map((s) => s.id).sort(), ['0002', '0003'], 'the old epoch\'s allocation is gone; the new epoch\'s and the other person\'s are untouched');
  assert.equal((await call('/observe', { principals: [p(1, P1)] })).body.results[p(1, P1)].allocations, 0);
  for (const bad of [{}, { principals: [] }, { principals: ['not-a-principal'] }, { principals: ['acct-1'] }, { principals: Array(201).fill(p(1, P1)) }]) { assert.ok([400, 413].includes((await call('/revoke', bad)).status)); assert.ok([400, 413].includes((await call('/observe', bad)).status)); }          // too many (or too large) is refused
  assert.equal((await call('/revoke', { principals: [p(1, P1)] }, 'nope'.repeat(11))).status, 401);
});

test('userdb mode (fake Redis): credentials are opaque and per principal; revoking deletes them and observation reports what is left; an unreachable relay is "unobserved", never "zero"', async () => {
  const store = { kv: new Map(), sets: new Map() }, sessions = []; const c = await fakeCli(sessions);
  const env2 = { TURN_AUTH_MODE: 'userdb', TURN_USERDB_REDIS_URL: 'redis://fake', TURN_REALM: 'qorlla.test', TURN_CREDENTIAL_SECRET: 'u'.repeat(40), TURN_CLI_HOST: '127.0.0.1', TURN_CLI_PORT: String(c.port), TURN_CLI_PASSWORD: CLIPW };
  const tc = createTurnControl({ env: env2, createRedis: () => fakeRedis(store) });
  try {
    const a = await tc.issue(`meet:${MEETING}:${P1}:1`), b = await tc.issue(`meet:${MEETING}:${P2}:1`); assert.notEqual(a.username, b.username); assert.ok(!a.username.includes(P1), 'the username does not reveal who it is for');
    sessions.push({ id: '0010', user: a.username, rb: 40, sb: 60 });
    const o = await tc.observeAccount(`meet:${MEETING}:${P1}:1`); assert.equal(o.observed, true); assert.equal(o.allocations, 1); assert.equal(o.relayedBytes, 100); assert.equal(o.credentials, 1);
    assert.equal((await tc.observeAccount(`meet:${MEETING}:${randomUUID()}:1`)).allocations, 0);
    const rv = await tc.revokeAccount(`meet:${MEETING}:${P1}:1`); assert.equal(rv.credentials, 1); assert.equal(rv.sessions, 1); assert.equal(sessions.length, 0);
    assert.equal((await tc.observeAccount(`meet:${MEETING}:${P1}:1`)).allocations, 0);
    await new Promise((r) => c.server.close(r)); const dead = await tc.observeAccount(`meet:${MEETING}:${P2}:1`); assert.equal(dead.observed, false); assert.equal(dead.reason, 'cli_error');
    assert.equal((await createTurnControl({ env: {} }).observeAccount('x')).reason, 'cli_not_configured');
  } finally { await tc.close(); }
});
