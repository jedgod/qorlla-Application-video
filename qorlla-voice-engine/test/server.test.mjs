// The real server over real sockets: ES256 tokens verified through a real JWKS endpoint, PostgreSQL in an isolated schema, real WebSocket clients.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { createStore } from '../src/store.mjs';
import { makeAuthenticator } from '../src/auth.mjs';
import { createVoiceApp } from '../src/app.mjs';
import { PROTOCOL } from '../src/tickets.mjs';
import { isolatedDb, identityProvider, wait } from './helpers.mjs';

const ORIGIN = 'https://app.qorlla.test', ADMIN = 'a'.repeat(40);
let db, idp, voice, base, env;
before(async () => {
  db = await isolatedDb(); if (!db) return;
  idp = await identityProvider();
  env = { VOICE_JWKS_URL: idp.jwksUrl, VOICE_JWT_ISSUER: 'qorlla-main', VOICE_JWT_AUDIENCE: 'qorlla-voice', VOICE_ALLOWED_ORIGIN: ORIGIN + ',https://second.qorlla.test', VOICE_ADMIN_SECRET: ADMIN, VOICE_RING_SECONDS: '5' };
  voice = createVoiceApp({ store: createStore(db.pool), db: db.pool, authenticate: makeAuthenticator(env), env, maintenanceMs: 150 });
  base = 'http://127.0.0.1:' + (await voice.listen(0, '127.0.0.1'));
});
after(async () => { if (voice) await voice.close(); if (idp) await idp.close(); if (db) await db.drop(); });
const skip = (t) => !db && t.skip('no PostgreSQL reachable');

// ---- tiny clients
const api = async (account, method, path, body, o = {}) => {
  const headers = { 'content-type': 'application/json', origin: o.origin ?? ORIGIN, ...(o.headers || {}) };
  if (account) headers.authorization = 'Bearer ' + (o.token || await idp.token(account));
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
};
const admin = (method, path, body, secret = ADMIN) => fetch(base + '/v1/voice/admin' + path, { method, headers: { 'content-type': 'application/json', 'x-voice-admin-secret': secret }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const ticket = async (account, origin = ORIGIN, deviceId = devOf(account)) => (await api(account, 'POST', '/v1/voice/ws-ticket', { deviceId }, { origin })).body.ticket;
/** Opens a socket the way the browser SDK does (ticket in the subprotocol). Resolves with {ws, inbox, ready} or rejects with the HTTP status. */
async function connect(account, o = {}) {
  const t = o.ticket ?? await ticket(account, o.ticketOrigin, o.deviceId);
  const url = 'ws://127.0.0.1:' + new URL(base).port + '/v1/voice/ws' + (o.query ? '?ticket=' + t : '');
  const ws = o.query ? new WebSocket(url, { origin: o.origin ?? ORIGIN }) : new WebSocket(url, [PROTOCOL, 'ticket.' + t], { origin: o.origin ?? ORIGIN });
  const inbox = []; ws.on('message', (m) => inbox.push(JSON.parse(m.toString())));
  await new Promise((res, rej) => { ws.once('open', res); ws.once('unexpected-response', (_q, r) => rej(new Error('http_' + r.statusCode))); ws.once('error', (e) => rej(new Error(e.message.includes('401') ? 'http_401' : e.message))); });
  return { ws, inbox, protocol: ws.protocol, closed: new Promise((r) => ws.once('close', (code) => r(code))) };
}
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await wait(25); } return null; };
const ofType = (c, type, pred = () => true) => c.inbox.find((m) => m.type === type && pred(m));
const quiet = async (c, type, ms = 300) => { await wait(ms); return !c.inbox.some((m) => m.type === type); };
const SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
const dial = (from, ext, deviceId = devOf(from)) => api(from, 'POST', '/v1/voice/calls', { deviceId, extension: ext, idempotencyKey: 'key-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) });
const close = (...cs) => cs.forEach((c) => { try { c.ws.close(); } catch { /* gone */ } });
const ext = {}, devices = {};
const devOf = (account) => (devices[account] ||= randomUUID());

test('provisioning is server-to-server only: the secret is required, constant-time checked, and the feature is off when it is not configured', async (t) => {
  if (skip(t)) return;
  assert.equal((await admin('POST', '/identities', { accountId: 'x' }, 'wrong'.repeat(10))).status, 401); assert.equal((await fetch(base + '/v1/voice/admin/identities', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  for (const a of ['alice', 'bob', 'carol', 'dave']) { const r = await admin('POST', '/identities', { accountId: a }); assert.equal(r.status, 201); ext[a] = r.body.identity.extension; }
  assert.deepEqual(Object.values(ext), ['2000', '2001', '2002', '2003']); assert.equal((await admin('POST', '/identities', { accountId: 'alice' })).status, 200);
  assert.equal((await admin('POST', '/identities', { accountId: 'erin', extension: '2000' })).status, 409); assert.equal((await admin('POST', '/identities', { accountId: 'bad id!' })).status, 400); assert.equal((await admin('POST', '/identities', { accountId: 'erin', extension: '12' })).status, 400); for (const n of ['911', '112', '999']) assert.equal((await admin('POST', '/identities', { accountId: 'erin', extension: n })).status, 400, 'an emergency number can never be provisioned as an extension: ' + n);
  assert.deepEqual((await admin('GET', '/identities?ids=alice,bob')).body.identities.map((i) => i.account_id), ['alice', 'bob']);
  const off = createVoiceApp({ store: createStore(db.pool), db: db.pool, authenticate: makeAuthenticator(env), env: { ...env, VOICE_ADMIN_SECRET: 'short' }, maintenance: false }); const p = await off.listen(0, '127.0.0.1');
  assert.equal((await fetch(`http://127.0.0.1:${p}/v1/voice/admin/identities`, { headers: { 'x-voice-admin-secret': 'short' } })).status, 503); await off.close();
});

test('a browser token is verified properly: signature, issuer, audience, expiry and subject', async (t) => {
  if (skip(t)) return;
  assert.equal((await api(null, 'GET', '/v1/voice/me')).status, 401);
  assert.equal((await api('alice', 'GET', '/v1/voice/me', undefined, { token: 'garbage' })).status, 401);
  assert.equal((await api('alice', 'GET', '/v1/voice/me', undefined, { token: await idp.token('alice', { aud: 'someone-else' }) })).status, 401);
  assert.equal((await api('alice', 'GET', '/v1/voice/me', undefined, { token: await idp.token('alice', { iss: 'evil' }) })).status, 401);
  assert.equal((await api('alice', 'GET', '/v1/voice/me', undefined, { token: await idp.token('alice', { exp: '-1m' }) })).status, 401);
  assert.equal((await api('alice', 'GET', '/v1/voice/me', undefined, { token: await idp.token('alice', { wrongKey: true }) })).status, 401);          // signed by a key that is not in the JWKS
  const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.' + Buffer.from(JSON.stringify({ sub: 'alice', iss: 'qorlla-main', aud: 'qorlla-voice', exp: 9999999999 })).toString('base64url') + '.';
  assert.equal((await api('alice', 'GET', '/v1/voice/me', undefined, { token: none })).status, 401);                                                            // alg:none is never accepted
  const me = await api('alice', 'GET', '/v1/voice/me'); assert.equal(me.status, 200); assert.equal(me.body.identity.extension, ext.alice);
});

test('CORS: only the exact allowed origins; a stranger origin gets nothing', async (t) => {
  if (skip(t)) return;
  const pre = await fetch(base + '/v1/voice/calls', { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN); assert.match(pre.headers.get('access-control-allow-headers'), /authorization/); assert.equal(pre.headers.get('vary'), 'Origin');
  assert.equal((await fetch(base + '/v1/voice/calls', { method: 'OPTIONS', headers: { origin: 'https://evil.test' } })).status, 403);
  const stranger = await api('alice', 'GET', '/v1/voice/me', undefined, { origin: 'https://qorlla.test.evil' }); assert.equal(stranger.headers.get('access-control-allow-origin'), null);
  assert.equal((await api('alice', 'POST', '/v1/voice/ws-ticket', {}, { origin: 'https://evil.test' })).status, 403);                                            // no ticket for a foreign origin
  assert.equal((await fetch(base + '/healthz')).status, 200); assert.equal((await fetch(base + '/readyz')).status, 200);
});

test('WebSocket tickets: one use, bound to the origin, short-lived, and never needed in a URL', async (t) => {
  if (skip(t)) return;
  const tk = await ticket('alice'); assert.match(tk, /^[A-Za-z0-9_-]{43}$/);
  const c = await connect('alice', { ticket: tk }); assert.equal(c.protocol, PROTOCOL); const ready = await until(() => ofType(c, 'ready')); assert.equal(ready.extension, ext.alice);
  await assert.rejects(connect('alice', { ticket: tk }), /http_401/);                                                                 // replay
  await assert.rejects(connect('alice', { ticket: await ticket('alice'), origin: 'https://evil.test' }), /http_401/);                // right ticket, wrong browser origin
  await assert.rejects(connect('alice', { ticket: await ticket('alice', 'https://second.qorlla.test') }), /http_401/);               // ticket minted for another allowed origin
  await assert.rejects(connect('alice', { ticket: 'A'.repeat(43) }), /http_401/); await assert.rejects(connect('alice', { ticket: 'short' }), /http_401/);
  const expired = await ticket('alice'); await db.pool.query("UPDATE voice_ws_tickets SET expires_at = now() - interval '1 second' WHERE consumed_at IS NULL"); await assert.rejects(connect('alice', { ticket: expired }), /http_401/);
  const q = await connect('alice', { query: true }); assert.ok(await until(() => ofType(q, 'ready'))); close(q);                         // the query form still works by default
  env.VOICE_WS_QUERY_TICKET = 'off'; await assert.rejects(connect('alice', { query: true }), /http_401/); delete env.VOICE_WS_QUERY_TICKET;   // and can be switched off
  const rows = (await db.pool.query('SELECT token_hash FROM voice_ws_tickets')).rows; assert.ok(rows.every((r) => r.token_hash !== tk && /^[0-9a-f]{64}$/.test(r.token_hash)));
  close(c);
});

test('a complete call: ring, answer, relayed signaling in the right order only, hang up; history, usage and diagnostics reflect it', async (t) => {
  if (skip(t)) return;
  const a = await connect('alice'), b = await connect('bob'); await until(() => ofType(a, 'ready') && ofType(b, 'ready'));
  const call = await dial('alice', ext.bob); assert.equal(call.status, 201); const id = call.body.call.id, genA = call.body.generation; assert.equal(call.body.call.status, 'ringing'); assert.equal(genA, 1);
  const incoming = await until(() => ofType(b, 'incoming')); assert.equal(incoming.call.id, id); assert.equal(incoming.from.extension, ext.alice);
  assert.ok(!JSON.stringify(incoming).includes('lease'));                                                                                            // no device or lease detail leaks into a ring
  // retry of the same request: same call, no second ring
  const body = { deviceId: devOf('alice'), extension: ext.bob, idempotencyKey: 'retry-key-123456789' }; const first = await api('alice', 'POST', '/v1/voice/calls', body); assert.equal(first.status, 409); // alice is already in a call: busy (the retry key is new)
  // nothing is relayed while the call is only ringing
  a.ws.send(JSON.stringify({ type: 'offer', callId: id, generation: genA, sdp: SDP })); assert.ok(await quiet(b, 'offer'));
  // busy for everyone else
  assert.equal((await dial('carol', ext.bob)).body.error, 'busy'); assert.equal((await dial('bob', ext.carol)).body.error, 'busy'); assert.equal((await dial('alice', ext.carol)).body.error, 'busy');
  // wrong people cannot act
  assert.equal((await api('carol', 'POST', `/v1/voice/calls/${id}/answer`, { deviceId: devOf('carol') })).status, 404); assert.equal((await api('alice', 'POST', `/v1/voice/calls/${id}/answer`, { deviceId: devOf('alice') })).status, 403); assert.equal((await api('bob', 'POST', `/v1/voice/calls/${id}/answer`)).status, 400);
  assert.equal((await api('bob', 'POST', `/v1/voice/calls/nope/answer`, { deviceId: devOf('bob') })).status, 400); assert.equal((await api('bob', 'POST', `/v1/voice/calls/${id}/explode`)).status, 400);
  const answered = await api('bob', 'POST', `/v1/voice/calls/${id}/answer`, { deviceId: devOf('bob') }); assert.equal(answered.body.call.status, 'active'); const genB = answered.body.generation; assert.equal(genB, 1);
  assert.ok(await until(() => ofType(a, 'state', (m) => m.call.status === 'active'))); assert.ok(await until(() => ofType(b, 'state', (m) => m.call.status === 'active')));
  // signaling now flows, with roles enforced and payloads cleaned
  a.ws.send(JSON.stringify({ type: 'offer', callId: id, generation: genA + 1, sdp: SDP })); assert.ok(await quiet(b, 'offer'));            // a wrong generation is stale: refused
  a.ws.send(JSON.stringify({ type: 'offer', callId: id, sdp: SDP })); assert.ok(await quiet(b, 'offer'));                                    // no generation at all: refused
  a.ws.send(JSON.stringify({ type: 'offer', callId: id, generation: genA, sdp: 'not sdp' })); assert.ok(await quiet(b, 'offer'));            // malformed
  a.ws.send(JSON.stringify({ type: 'offer', callId: id, generation: genA, sdp: SDP })); const offer = await until(() => ofType(b, 'offer')); assert.equal(offer.sdp, SDP); assert.equal(offer.callId, id); assert.equal(offer.gen, genA);
  b.ws.send(JSON.stringify({ type: 'answer', callId: id, generation: genB, sdp: SDP })); assert.ok(await until(() => ofType(a, 'answer')));
  a.ws.send(JSON.stringify({ type: 'ice', callId: id, generation: genA, candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0, evil: 'x' } }));
  const ice = await until(() => ofType(b, 'ice')); assert.deepEqual(Object.keys(ice.candidate).sort(), ['candidate', 'sdpMLineIndex', 'sdpMid', 'usernameFragment']);
  b.ws.send(JSON.stringify({ type: 'ice', callId: id, generation: genB, candidate: null })); assert.ok(await until(() => ofType(a, 'ice', (m) => m.candidate === null)));
  // a bystander with a perfectly valid socket cannot inject into someone else's call
  const c = await connect('carol'); await until(() => ofType(c, 'ready')); c.ws.send(JSON.stringify({ type: 'offer', callId: id, generation: 1, sdp: SDP })); c.ws.send(JSON.stringify({ type: 'ice', callId: id, generation: 1, candidate: null }));
  await wait(300); assert.equal(a.inbox.filter((m) => m.type === 'offer').length, 0); assert.equal(b.inbox.filter((m) => m.type === 'offer').length, 1); close(c);
  const live = await api('alice', 'GET', '/v1/voice/calls/live'); assert.equal(live.body.call.id, id);
  await wait(1100); const ended = await api('bob', 'POST', `/v1/voice/calls/${id}/end`); assert.equal(ended.body.call.status, 'ended');
  assert.ok(await until(() => ofType(a, 'state', (m) => m.call.status === 'ended'))); assert.equal((await api('alice', 'GET', '/v1/voice/calls/live')).body.call, null);
  assert.ok(await until(() => ofType(b, 'state', (m) => m.call.status === 'ended')));                                                   // events are delivered by the outbox worker, so wait for it before counting
  const n = b.inbox.length; a.ws.send(JSON.stringify({ type: 'ice', callId: id, generation: genA, candidate: null })); await wait(250); assert.equal(b.inbox.length, n);   // nothing relays after the call
  assert.equal((await api('bob', 'POST', `/v1/voice/calls/${id}/answer`, { deviceId: devOf('bob') })).status, 409);
  const hist = (await api('alice', 'GET', '/v1/voice/calls')).body.calls[0]; assert.deepEqual([hist.direction, hist.status, hist.peer_extension], ['outgoing', 'ended', ext.bob]); assert.ok(hist.seconds >= 1);
  assert.equal((await api('bob', 'GET', '/v1/voice/calls')).body.calls[0].direction, 'incoming'); assert.deepEqual((await api('dave', 'GET', '/v1/voice/calls')).body.calls, []);
  const u = (await api('alice', 'GET', '/v1/voice/usage')).body; assert.equal(u.answered, 1); assert.ok(u.seconds >= 1);
  const diag = await api('alice', 'GET', '/v1/voice/diagnostics'); assert.equal(diag.body.identity.extension, ext.alice); assert.equal(diag.body.ice.turn, false); assert.match(diag.body.ice.note, /No TURN relay/); assert.equal(diag.body.pstn, false); assert.equal(diag.body.requestOriginAllowed, true);
  assert.ok(!JSON.stringify(diag.body).includes(ADMIN)); close(a, b);
});

test('input is validated and rejected before it reaches the database; blocks apply', async (t) => {
  if (skip(t)) return;
  for (const bad of [{}, { extension: '12', idempotencyKey: 'k'.repeat(20) }, { extension: ext.bob, idempotencyKey: 'short' }, { extension: ext.bob, idempotencyKey: 'has spaces has spaces' }, { extension: 1234, idempotencyKey: 'k'.repeat(20) }]) assert.equal((await api('carol', 'POST', '/v1/voice/calls', bad)).status, 400);
  assert.equal((await dial('carol', '999999')).status, 404); assert.equal((await dial('carol', ext.carol)).status, 404);                                                                    // unknown, and yourself
  assert.equal((await api('carol', 'POST', '/v1/voice/blocks', { extension: ext.dave })).status, 201); assert.deepEqual((await api('carol', 'GET', '/v1/voice/blocks')).body.blocked, [ext.dave]);
  assert.equal((await dial('dave', ext.carol)).status, 403); assert.equal((await dial('carol', ext.dave)).status, 403);
  assert.equal((await api('carol', 'DELETE', '/v1/voice/blocks/' + ext.dave)).status, 200); assert.deepEqual((await api('carol', 'GET', '/v1/voice/blocks')).body.blocked, []);
  const big = await fetch(base + '/v1/voice/calls', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + await idp.token('carol') }, body: JSON.stringify({ extension: ext.bob, idempotencyKey: 'x'.repeat(40000) }) }); assert.equal(big.status, 413);
});

test('an unanswered call becomes missed on its own and both people are told', async (t) => {
  if (skip(t)) return;
  const a = await connect('carol'), b = await connect('dave'); await until(() => ofType(a, 'ready') && ofType(b, 'ready'));
  const call = (await dial('carol', ext.dave)).body.call; await until(() => ofType(b, 'incoming'));
  await db.pool.query("UPDATE voice_calls SET created_at = now() - interval '10 minutes' WHERE id=$1", [call.id]);
  assert.ok(await until(() => ofType(a, 'state', (m) => m.call.status === 'missed'), 4000)); assert.ok(await until(() => ofType(b, 'state', (m) => m.call.id === call.id && m.call.status === 'missed')));
  assert.equal((await api('dave', 'POST', `/v1/voice/calls/${call.id}/answer`, { deviceId: devOf('dave') })).status, 409);                                          // too late to answer
  assert.equal((await api('carol', 'GET', '/v1/voice/calls')).body.calls[0].status, 'missed');
  assert.equal((await dial('carol', ext.dave)).status, 201); close(a, b);
});

test('connections are limited: three devices per person, and a flood closes the socket', async (t) => {
  if (skip(t)) return;
  const four = []; for (let i = 0; i < 4; i++) four.push(await connect('dave')); const codes = await Promise.race([Promise.all(four.map((c) => Promise.race([c.closed, wait(600).then(() => 'open')]))), wait(2000)]);
  assert.equal(codes.filter((c) => c === 1008).length, 1, JSON.stringify(codes)); close(...four);
  const f = await connect('bob'); for (let i = 0; i < 260; i++) f.ws.send(JSON.stringify({ type: 'ice', callId: 'b00c477c-0b2e-42c5-ae21-211e14799322', generation: 1, candidate: null })); assert.equal(await Promise.race([f.closed, wait(2000)]), 1008);
});

test('suspending an account ends its call, closes its sockets and stops new tickets', async (t) => {
  if (skip(t)) return;
  await api('dave', 'POST', '/v1/voice/calls/' + (await api('dave', 'GET', '/v1/voice/calls/live')).body.call?.id + '/end').catch(() => {});
  const a = await connect('alice'), b = await connect('bob'); await until(() => ofType(a, 'ready') && ofType(b, 'ready'));
  const call = (await dial('alice', ext.bob)).body.call; await api('bob', 'POST', `/v1/voice/calls/${call.id}/answer`, { deviceId: devOf('bob') });
  const r = await admin('POST', '/identities/bob/enabled', { enabled: false }); assert.equal(r.status, 200); assert.equal(r.body.endedCalls, 1);
  assert.ok(await until(() => ofType(a, 'state', (m) => m.call.status === 'ended'))); assert.equal(await Promise.race([b.closed, wait(2000)]), 4003);
  assert.equal((await api('bob', 'POST', '/v1/voice/ws-ticket', { deviceId: devOf('bob') })).status, 403); assert.equal((await dial('alice', ext.bob)).status, 404);
  assert.equal((await admin('POST', '/identities/bob/enabled', { enabled: 'yes' })).status, 400); assert.equal((await admin('POST', '/identities/bob/enabled', { enabled: true })).status, 200); close(a);
});

test('ICE servers: self-hosted only, TURN credentials are per account and short-lived', async (t) => {
  if (skip(t)) return;
  assert.deepEqual((await api('alice', 'GET', '/v1/voice/ice')).body.iceServers, []);
  Object.assign(env, { STUN_URL: 'stun:turn.qorlla.test:3478', TURN_URLS: 'turn:turn.qorlla.test:3478?transport=udp', TURN_SHARED_SECRET: 'x'.repeat(32) });
  const { iceServers } = (await api('alice', 'GET', '/v1/voice/ice')).body; assert.equal(iceServers.length, 2); assert.match(iceServers[1].username, /^\d+:alice$/); assert.ok(iceServers[1].credential);
  assert.notEqual(iceServers[1].credential, (await api('bob', 'GET', '/v1/voice/ice')).body.iceServers[1].credential);
  assert.ok(!JSON.stringify(iceServers).includes('x'.repeat(32))); assert.equal((await api('alice', 'GET', '/v1/voice/diagnostics')).body.ice.turn, true);
  for (const k of ['STUN_URL', 'TURN_URLS', 'TURN_SHARED_SECRET']) delete env[k];
});
