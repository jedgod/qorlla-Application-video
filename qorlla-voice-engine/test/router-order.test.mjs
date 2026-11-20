// R8 receiver-side ordering, without any infrastructure: a fake socket, a fake PostgreSQL replay. The two-replica, real-Redis proof is ordering-r8.redis.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceRouter } from '../src/router.mjs';
import { wait } from './helpers.mjs';

const sock = (account = 'bob') => ({ account, deviceId: 'd', readyState: 1, bufferedAmount: 0, sent: [], closed: null, send(m) { this.sent.push(JSON.parse(m)); }, close(code, reason) { this.closed = [code, reason]; this.readyState = 3; } });
const ev = (id, status = 'ringing') => ({ type: 'state', eventId: id, kind: 'state', call: { id: 'c1', status } });
const ids = (ws) => ws.sent.filter((m) => m.eventId).map((m) => m.eventId);
const db = (list) => async (_acct, after) => ({ events: list.filter((e) => e.eventId > after).map((e) => ({ id: e.eventId, kind: e.kind, payload: { type: e.type, call: e.call } })), hasMore: false });
const make = (list, o = {}) => { const r = new VoiceRouter({ replay: db(list), gapMs: 20, ...o }), ws = sock(); r.attach(ws); r.baseline(ws, 0); return { r, ws }; };

test('in order delivery is immediate; duplicates and replays of older events are dropped', () => {
  const { r, ws } = make([]); r.local('bob', null, ev(1), { prev: 0 }); r.local('bob', null, ev(3), { prev: 1 }); r.local('bob', null, ev(3), { prev: 1 }); r.local('bob', null, ev(1), { prev: 0 });
  assert.deepEqual(ids(ws), [1, 3]); assert.equal(r.order.dropped, 2);
});
test('a late predecessor that arrives inside the grace period is sent first, and nothing is read from the database', async () => {
  let reads = 0; const { r, ws } = make([ev(1), ev(2), ev(3)]); const rep = r.replay; r.replay = async (...a) => { reads++; return rep(...a); };
  r.local('bob', null, ev(2), { prev: 1 }); r.local('bob', null, ev(3), { prev: 2 }); assert.deepEqual(ids(ws), []); r.local('bob', null, ev(1), { prev: 0 }); assert.deepEqual(ids(ws), [1, 2, 3]); await wait(60); assert.equal(reads, 0);
});
test('a lost event is filled in from PostgreSQL, in order, before the event that revealed the gap', async () => {
  const { r, ws } = make([ev(1), ev(2), ev(3, 'ended')]); r.local('bob', null, ev(1), { prev: 0 }); r.local('bob', null, ev(3, 'ended'), { prev: 2 }); await wait(120);
  assert.deepEqual(ids(ws), [1, 2, 3]); assert.equal(ws.sent.at(-1).call.status, 'ended'); assert.equal(r.order.repaired >= 1, true);
});
test('a stale "ringing" or "active" that arrives after "ended" is never sent', () => {
  const { r, ws } = make([]); r.local('bob', null, ev(5, 'ended'), { prev: 0 }); r.local('bob', null, ev(3, 'active'), { prev: 2 }); r.local('bob', null, ev(2, 'ringing'), { prev: 1 });
  assert.deepEqual(ws.sent.map((m) => m.call.status), ['ended']);
});
test('a message without prev (an older replica) is only held to monotonic order', () => {
  const { r, ws } = make([]); r.local('bob', null, ev(4)); r.local('bob', null, ev(2)); r.local('bob', null, ev(6)); assert.deepEqual(ids(ws), [4, 6]);
});
test('when the database cannot repair the gap, the socket is closed so the client resumes by itself; nothing is delivered out of order', async () => {
  const { r, ws } = make([]); r.replay = async () => { throw Error('db_down'); }; r.local('bob', null, ev(1), { prev: 0 }); r.local('bob', null, ev(9), { prev: 8 }); await wait(1500);
  assert.deepEqual(ids(ws), [1]); assert.deepEqual(ws.closed, [1013, 'resync']); assert.equal(r.order.resynced, 1);
});
test('a flood of held events cannot grow memory: past the bound the socket is resynchronised', () => {
  const { r, ws } = make([]); r.replay = () => new Promise(() => {}); r.local('bob', null, ev(1), { prev: 0 }); for (let i = 0; i < 200; i++) r.local('bob', null, ev(1000 + i), { prev: 999 + i }); assert.deepEqual(ws.closed, [1013, 'resync']);
});
test('a predecessor that no longer exists in PostgreSQL (purged) cannot hold an event back for ever', async () => {
  const { r, ws } = make([]); r.local('bob', null, ev(9), { prev: 8 }); await wait(200); assert.deepEqual(ids(ws), [9]); assert.equal(ws.closed, null);
});
test('transient signaling and other accounts are untouched; another socket of the same account has its own order', () => {
  const r = new VoiceRouter({ replay: db([]), gapMs: 20 }), a = sock(), b = sock(), c = sock('carol'); [a, b, c].forEach((w) => { r.attach(w); r.baseline(w, 0); });
  c.readyState = 3;                                                                                                                                  // (carol's socket is closed: she gets nothing either way)
  r.local('bob', null, { type: 'offer', sdp: 'x' }); r.local('bob', null, ev(2), { prev: 1 }); r.local('carol', null, ev(2), { prev: 1 });
  assert.deepEqual(a.sent.map((m) => m.type), ['offer']); assert.deepEqual(ids(c), []); r.local('bob', null, ev(1), { prev: 0 }); assert.deepEqual(ids(a), [1, 2]); assert.deepEqual(ids(b), [1, 2]);
});
