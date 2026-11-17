'use strict';
// Archive / delete in Meeting History are per person. Run: NODE_PATH=<a node_modules with express> node --test tests/history-archive.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { registerHistory } = require('../history');

const now = Date.now();
const mk = (id, over = {}) => ({ meetingId: id, title: 'Meeting ' + id, hostId: 'host', hostName: 'Host', joinedAccounts: ['guest'], status: 'completed', actualStartAt: now - 3600e3, actualEndAt: now - 1800e3, lastActivityAt: now - 1800e3, attendance: [], ...over });

async function rig() {
  const state = new Map(); for (const id of ['111 1111 1111', '222 2222 2222', '333 3333 3333']) state.set(id, mk(id));
  let saves = 0, app = express(); app.use(express.json());
  const auth = { getUser: (req) => (req.headers['x-user'] ? { id: String(req.headers['x-user']), name: String(req.headers['x-user']) } : null) };
  registerHistory({ app, meetingsState: state, saveSnapshotSoon: () => { saves++; }, auth, activeRooms: new Map(), fetchActivity: null, decorate: null });
  const server = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
  const call = async (user, method, path, body) => { const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ } return { status: r.status, body: j }; };
  return { state, call, saves: () => saves, close: () => new Promise((r) => server.close(r)) };
}
const ids = (r) => r.body.meetings.map((m) => m.meetingId).sort();
const enc = (id) => encodeURIComponent(id);

test('the list says archive is supported; nothing is hidden at first', async () => {
  const t = await rig(); const r = await t.call('guest', 'GET', '/api/history/meetings'); assert.equal(r.status, 200); assert.equal(r.body.canArchive, true); assert.equal(r.body.total, 3); assert.equal(r.body.meetings[0].archived, false); await t.close();
});

test('archive hides it from that person only, appears under view=archived, and can be undone', async () => {
  const t = await rig(); const id = '111 1111 1111';
  const a = await t.call('guest', 'POST', `/api/history/meetings/${enc(id)}/archive`, {}); assert.equal(a.status, 200); assert.equal(a.body.archived, true); assert.ok(t.saves() >= 1);
  assert.deepEqual(ids(await t.call('guest', 'GET', '/api/history/meetings')), ['222 2222 2222', '333 3333 3333']);
  const arch = await t.call('guest', 'GET', '/api/history/meetings?view=archived'); assert.deepEqual(ids(arch), [id]); assert.equal(arch.body.meetings[0].archived, true);
  assert.equal((await t.call('host', 'GET', '/api/history/meetings')).body.total, 3, 'the host still sees all three');
  assert.equal((await t.call('guest', 'GET', `/api/history/meetings/${enc(id)}`)).status, 200, 'an archived meeting can still be opened');
  const u = await t.call('guest', 'POST', `/api/history/meetings/${enc(id)}/archive`, { archived: false }); assert.equal(u.body.archived, false); assert.equal((await t.call('guest', 'GET', '/api/history/meetings')).body.total, 3); assert.equal(t.state.get(id).hiddenBy, undefined, 'nothing left behind'); await t.close();
});

test('delete removes it from that person\'s History for good, is not undone by archive, and leaves the record and others untouched', async () => {
  const t = await rig(); const id = '222 2222 2222'; const before = JSON.stringify({ ...t.state.get(id), hiddenBy: undefined });
  const d = await t.call('guest', 'DELETE', `/api/history/meetings/${enc(id)}`); assert.equal(d.status, 200); assert.equal(d.body.deleted, true);
  assert.deepEqual(ids(await t.call('guest', 'GET', '/api/history/meetings')), ['111 1111 1111', '333 3333 3333']); assert.equal((await t.call('guest', 'GET', '/api/history/meetings?view=archived')).body.total, 0);
  assert.equal((await t.call('guest', 'GET', `/api/history/meetings/${enc(id)}`)).status, 404); assert.equal((await t.call('guest', 'POST', `/api/history/meetings/${enc(id)}/archive`, {})).status, 404, 'a deleted meeting cannot be brought back from the screen');
  assert.equal((await t.call('host', 'GET', `/api/history/meetings/${enc(id)}`)).status, 200); assert.equal((await t.call('host', 'GET', '/api/history/meetings')).body.total, 3);
  assert.equal(JSON.stringify({ ...t.state.get(id), hiddenBy: undefined }), before, 'the frozen record is unchanged'); await t.close();
});

test('a person can only hide meetings they are part of; anonymous is refused; unfinished meetings are refused; the flag never reaches the public view', async () => {
  const t = await rig(); const id = '333 3333 3333';
  assert.equal((await t.call('stranger', 'POST', `/api/history/meetings/${enc(id)}/archive`, {})).status, 404); assert.equal((await t.call('stranger', 'DELETE', `/api/history/meetings/${enc(id)}`)).status, 404);
  assert.equal((await t.call(null, 'DELETE', `/api/history/meetings/${enc(id)}`)).status, 401); assert.equal((await t.call(null, 'POST', `/api/history/meetings/${enc(id)}/archive`, {})).status, 401);
  t.state.set('444 4444 4444', mk('444 4444 4444', { status: 'active', actualEndAt: null, lastActivityAt: Date.now() })); const live = await t.call('host', 'DELETE', `/api/history/meetings/${enc('444 4444 4444')}`); assert.ok([404, 409].includes(live.status), 'live meeting: ' + live.status);
  assert.equal(t.state.get('444 4444 4444').hiddenBy, undefined, 'nothing was recorded for a live meeting');
  await t.call('guest', 'POST', `/api/history/meetings/${enc(id)}/archive`, {}); const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8'); assert.match(src, /hiddenBy: _hb/, 'publicMeeting strips hiddenBy'); await t.close();
});
