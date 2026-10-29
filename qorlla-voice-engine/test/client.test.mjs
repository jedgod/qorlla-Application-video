// The browser SDK's logic that needs no browser: duplicate delivery applied once (DR-04, client side), replay collapsing, resume after a reconnect and reconciliation against a REAL engine.
// Media (RTCPeerConnection, microphone) is covered by the Playwright specs in tests/.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { QorllaVoiceClient, EventLog, collapseReplay } from '../web/VoiceClient.mjs';
import { isolatedDb, identityProvider, wait } from './helpers.mjs';
import { harness, until, ORIGIN } from './harness.mjs';

test('EventLog: each durable id is applied once, ids without a number always pass, the cursor only grows, memory is bounded', () => {
  const log = new EventLog(3);
  assert.equal(log.accept(5), true); assert.equal(log.accept(5), false); assert.equal(log.cursor, 5); assert.equal(log.accept(3), true); assert.equal(log.cursor, 5);
  assert.equal(log.accept(undefined), true); assert.equal(log.accept(undefined), true); assert.equal(log.accept(0), true); assert.equal(log.accept('7'), true);
  log.accept(6); log.accept(7); log.accept(8); assert.ok(log.seen.size <= 3); assert.equal(log.cursor, 8);
});

test('collapseReplay: a ring for something that already ended never pops up again; only the latest roster survives; stale invitations go', () => {
  const call = (id, status) => ({ id, status, caller_id: 'a', callee_id: 'b' });
  const ev = (id, kind, payload) => ({ id, kind, payload });
  const batch = [ev(1, 'incoming', { call: call('c1', 'ringing') }), ev(2, 'state', { call: call('c1', 'missed') }), ev(3, 'incoming', { call: call('c2', 'ringing') }),
    ev(4, 'room_invite', { room: { id: 'r1' } }), ev(5, 'room_state', { room: { id: 'r1', status: 'live' } }), ev(6, 'room_state', { room: { id: 'r1', status: 'ended' } }), ev(7, 'room_invite', { room: { id: 'r2' } })];
  assert.deepEqual(collapseReplay(batch).map((e) => e.id), [2, 3, 6, 7]);
  assert.deepEqual(collapseReplay([]), []);
});

let db, idp, h, r, ext;
before(async () => { db = await isolatedDb(); if (!db) return; idp = await identityProvider(); h = harness({ db, idp }); r = await h.replica({ maintenance: false }); ext = await h.people(r, ['alice', 'bob']); });
after(async () => { if (h) await h.closeAll(); if (idp) await idp.close(); if (db) await db.drop(); });
const skip = (t) => !db && t.skip('no PostgreSQL reachable');

function sdk(account, deviceId) {
  const events = [];
  class W extends WebSocket { constructor(url, protocols) { super(url, protocols, { origin: ORIGIN }); } }
  const fetchImpl = (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers || {}), origin: ORIGIN } });
  const c = new QorllaVoiceClient(r.base, () => idp.token(account), (e) => events.push(e), { WebSocketImpl: W, fetchImpl, deviceId });
  return { c, events, of: (type, pred = () => true) => events.filter((e) => e.type === type && pred(e)) };
}

test('the SDK against a real engine: it connects with a device-bound ticket, applies a duplicated event once, and a reconnecting device resumes without replaying finished calls', async (t) => {
  if (skip(t)) return;
  const a = sdk('alice', r.device('alice')), b = sdk('bob', r.device('bob'));
  await a.c.connect(); await b.c.connect(); assert.ok(await until(() => a.of('ready')[0] && b.of('ready')[0])); assert.ok(b.of('ready')[0].cursor >= 0);
  const call = await a.c.dial(ext.bob); assert.equal(a.c.callId, call.id); assert.equal(a.c.generation, 1);
  const inc = await until(() => b.of('incoming')[0]); assert.ok(inc && inc.eventId, 'the durable event arrived with its id');
  b.c.queue({ ...inc }); b.c.queue({ ...inc }); await wait(200); assert.equal(b.of('incoming').length, 1, 'duplicate deliveries of the same event are applied once');
  assert.equal(b.c.log.cursor >= inc.eventId, true);
  // bob goes away; the call is rejected by someone else's action while he is offline (here: ended by alice), then he comes back with his cursor
  const cursor = b.c.log.cursor; b.c.disconnect();
  await a.c.hangup(); assert.ok(await until(() => a.of('state', (m) => m.call.status === 'ended')[0]));
  const b2 = sdk('bob', r.device('bob')); b2.c.log.cursor = cursor; await b2.c.connect();
  assert.ok(await until(() => b2.of('state', (m) => m.call.id === call.id && m.call.status === 'ended')[0]), 'the missed state change was replayed');
  await wait(300); assert.equal(b2.of('incoming').length, 0, 'the ring for a call that already ended is NOT shown again');
  assert.equal(b2.of('state').length, 1, 'exactly one state event, in order, once');
  // a client that thinks it is in a call the server no longer has learns that on reconnect
  b2.c.callId = '00000000-0000-4000-8000-000000000000'; b2.c.role = 'callee'; b2.c.ws.close(); await wait(200); await b2.c.connect();
  assert.ok(await until(() => b2.of('call_ended', (m) => m.reason === 'ended_while_offline')[0]), 'reconciliation noticed the call is gone'); assert.equal(b2.c.callId, null);
  a.c.disconnect(); b2.c.disconnect();
});

test('the same device id on the SDK is stable, and an explicit device id wins (a second device is a different id)', async (t) => {
  if (skip(t)) return;
  const x = sdk('alice', r.device('alice', 'phone')), y = sdk('alice', r.device('alice', 'laptop')); assert.notEqual(x.c.deviceId, y.c.deviceId);
  await x.c.connect(); await y.c.connect(); assert.ok(await until(() => x.of('ready')[0] && y.of('ready')[0])); assert.equal(x.of('ready')[0].deviceId, r.device('alice', 'phone')); x.c.disconnect(); y.c.disconnect();
});
