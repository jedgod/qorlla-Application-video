// Group calls (v1.5) on real PostgreSQL and real sockets: rooms, invitations, roster, host rules, mesh signaling relay, device fencing per seat, expiry, busy rules against one-to-one calls.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isolatedDb, identityProvider, wait } from './helpers.mjs';
import { harness, until, SDP } from './harness.mjs';

let db, idp, h, r, ext;
const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'hank'];
before(async () => {
  db = await isolatedDb(); if (!db) return; idp = await identityProvider(); h = harness({ db, idp }); r = await h.replica({ maintenance: false }); ext = await h.people(r, NAMES);
});
after(async () => { if (h) await h.closeAll(); if (idp) await idp.close(); if (db) await db.drop(); });
const skip = (t) => !db && t.skip('no PostgreSQL reachable');
const mk = (from, exts, title = '') => r.api(from, 'POST', '/v1/voice/rooms', { extensions: exts, title, deviceId: r.device(from) });
const act = (account, id, action, body = {}) => r.api(account, 'POST', `/v1/voice/rooms/${id}/${action}`, action === 'join' || action === 'device' ? { deviceId: r.device(account), ...body } : body);
const members = (room) => Object.fromEntries(room.members.map((m) => [m.account_id, m.status + (m.role === 'host' ? '/host' : '')]));
const cleanup = () => db.pool.query("UPDATE voice_rooms SET status='ended', ended_at=now() WHERE status='live'").then(() => db.pool.query("UPDATE voice_room_members SET status='left' WHERE status IN ('joined','invited')"));

test('a room: host creates and invites, invitees are told durably, join and roster, busy rules, and mesh signaling only between joined members', async (t) => {
  if (skip(t)) return; await cleanup();
  const sk = {}; for (const n of ['alice', 'bob', 'carol', 'dave']) sk[n] = await r.connect(n);
  const c = await mk('alice', [ext.bob, ext.carol], 'Standup'); assert.equal(c.status, 201); const id = c.body.room.id; assert.equal(c.body.generation, 1); assert.equal(c.body.room.title, 'Standup');
  assert.deepEqual(members(c.body.room), { alice: 'joined/host', bob: 'invited', carol: 'invited' });
  for (const n of ['bob', 'carol']) { const inv = await until(() => sk[n].of('room_invite')[0]); assert.ok(inv && inv.room.id === id && inv.eventId && inv.from.extension === ext.alice, n + ' was invited'); }
  assert.ok(await until(() => sk.alice.of('room_state')[0]));
  // busy rules cross one-to-one calls and rooms in both directions
  assert.equal((await r.dial('dave', ext.alice)).body.error, 'busy'); assert.equal((await r.dial('alice', ext.dave)).body.error, 'busy'); assert.equal((await mk('alice', [ext.dave])).body.error, 'busy');
  assert.equal((await r.dial('bob', ext.dave)).status, 201, 'being only invited does not make you busy'); await r.api('dave', 'POST', `/v1/voice/calls/${(await r.api('dave', 'GET', '/v1/voice/calls/live')).body.call.id}/reject`, {});
  // not joined yet: nothing is relayed to or from them
  sk.alice.send({ type: 'g_offer', roomId: id, to: 'bob', generation: 1, sdp: SDP }); await wait(250); assert.equal(sk.bob.of('g_offer').length, 0);
  assert.equal((await act('bob', id, 'join')).status, 200); assert.equal((await act('bob', id, 'join')).body.error, 'already_joined');
  const j = await act('carol', id, 'join'); assert.equal(j.body.generation, 1); assert.deepEqual(members(j.body.room), { alice: 'joined/host', bob: 'joined', carol: 'joined' });
  assert.ok(await until(() => sk.alice.of('room_state').find((m) => m.room.members.filter((x) => x.status === 'joined').length === 3)), 'everyone sees the full roster');
  // signaling: newer to older, with the sender's generation; the server stamps who it is from
  sk.carol.send({ type: 'g_offer', roomId: id, to: 'alice', generation: 1, sdp: SDP }); const off = await until(() => sk.alice.of('g_offer')[0]); assert.ok(off); assert.equal(off.from, 'carol'); assert.equal(off.roomId, id); assert.equal(off.gen, 1);
  assert.equal(sk.bob.of('g_offer').length, 0, 'only the addressee receives it');
  sk.alice.send({ type: 'g_answer', roomId: id, to: 'carol', generation: 1, sdp: SDP }); assert.ok(await until(() => sk.carol.of('g_answer')[0]));
  sk.bob.send({ type: 'g_ice', roomId: id, to: 'carol', generation: 1, candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0, evil: 1 } }); const ice = await until(() => sk.carol.of('g_ice')[0]); assert.deepEqual(Object.keys(ice.candidate).sort(), ['candidate', 'sdpMLineIndex', 'sdpMid', 'usernameFragment']);
  const n = sk.alice.inbox.length;
  sk.carol.send({ type: 'g_offer', roomId: id, to: 'alice', generation: 2, sdp: SDP }); sk.carol.send({ type: 'g_offer', roomId: id, to: 'alice', sdp: SDP }); sk.carol.send({ type: 'g_offer', roomId: id, to: 'carol', generation: 1, sdp: SDP });   // stale generation, none, to yourself
  sk.dave.send({ type: 'g_offer', roomId: id, to: 'alice', generation: 1, sdp: SDP }); sk.carol.send({ type: 'g_offer', roomId: id, to: 'dave', generation: 1, sdp: SDP });                                // a stranger in, and out to a stranger
  sk.carol.send({ type: 'g_offer', roomId: id, to: 'alice', generation: 1, sdp: 'not sdp' }); sk.carol.send({ type: 'g_offer', roomId: randomUUID(), to: 'alice', generation: 1, sdp: SDP });
  await wait(400); assert.equal(sk.alice.inbox.length, n); assert.equal(sk.dave.of('g_offer').length, 0);
  // reads: members only
  assert.equal((await r.api('bob', 'GET', `/v1/voice/rooms/${id}`)).status, 200); assert.equal((await r.api('dave', 'GET', `/v1/voice/rooms/${id}`)).status, 404); assert.equal((await r.api('alice', 'GET', '/v1/voice/rooms/not-an-id')).status, 400);
  assert.equal((await r.api('bob', 'GET', '/v1/voice/rooms/live')).body.room.id, id); assert.equal((await r.api('dave', 'GET', '/v1/voice/rooms/live')).body.room, null);
  Object.values(sk).forEach((s) => s.close()); await cleanup();
});

test('host rules: invite (cap and blocks), kick, host transfer, end, decline, and the room closes itself when empty', async (t) => {
  if (skip(t)) return; await cleanup();
  const sk = {}; for (const n of NAMES) sk[n] = await r.connect(n);
  const id = (await mk('alice', [ext.bob, ext.carol, ext.dave])).body.room.id; for (const n of ['bob', 'carol']) await act(n, id, 'join');
  // invite: joined members may; strangers and merely-invited people may not; the cap is the room size
  assert.equal((await act('erin', id, 'invite', { extension: ext.frank })).status, 404); assert.equal((await act('dave', id, 'invite', { extension: ext.frank })).status, 404);
  assert.equal((await act('bob', id, 'invite', { extension: ext.erin })).status, 200); assert.ok(await until(() => sk.erin.of('room_invite')[0]));
  assert.equal((await act('bob', id, 'invite', { extension: ext.erin })).body.reused, true, 'inviting twice is harmless'); assert.equal((await act('bob', id, 'invite', { extension: ext.alice })).body.reused, true);
  assert.equal((await act('bob', id, 'invite', { extension: ext.frank })).status, 200); assert.equal((await act('bob', id, 'invite', { extension: ext.gina })).body.error, 'room_full');   // 6 = alice, bob, carol, dave, erin, frank
  assert.equal((await act('bob', id, 'invite', { extension: '12' })).status, 400); assert.equal((await act('bob', id, 'invite', { extension: '999999' })).status, 404);
  // decline and a full room
  assert.equal((await act('frank', id, 'decline')).status, 200); assert.equal((await act('frank', id, 'decline')).status, 404, 'declining twice is refused');
  assert.equal((await act('gina', id, 'join')).status, 404);
  for (const n of ['dave', 'erin']) await act(n, id, 'join'); const full = await mk('frank', [ext.gina]); assert.equal(full.status, 201); await act('frank', full.body.room.id, 'leave');
  // kick: host only, never yourself
  assert.equal((await act('bob', id, 'kick', { accountId: 'carol' })).status, 403); assert.equal((await act('alice', id, 'kick', { accountId: 'alice' })).status, 403); assert.equal((await act('alice', id, 'kick', { accountId: 'nobody' })).status, 404);
  const kicked = await act('alice', id, 'kick', { accountId: 'carol' }); assert.equal(kicked.status, 200); assert.ok(!kicked.body.room.members.some((m) => m.account_id === 'carol'));
  const carolState = await until(() => sk.carol.of('room_state').find((m) => !m.room.members.some((x) => x.account_id === 'carol'))); assert.ok(carolState, 'the removed member is told');
  sk.carol.send({ type: 'g_offer', roomId: id, to: 'bob', generation: 2, sdp: SDP }); sk.carol.send({ type: 'g_offer', roomId: id, to: 'bob', generation: 1, sdp: SDP }); await wait(250); assert.equal(sk.bob.of('g_offer').length, 0);
  assert.equal((await r.dial('carol', ext.dave)).body.error, 'busy', 'dave is in the room'); assert.equal((await r.dial('carol', ext.gina)).status, 201); await r.api('gina', 'POST', `/v1/voice/calls/${(await r.api('gina', 'GET', '/v1/voice/calls/live')).body.call.id}/reject`, {});   // carol is free again
  // host leaves: the longest-serving member becomes host
  const left = await act('alice', id, 'leave'); assert.equal(left.status, 200); assert.equal(left.body.room.host_id, 'bob'); assert.equal(members(left.body.room).bob, 'joined/host');
  assert.equal((await act('dave', id, 'end')).status, 403, 'only the host ends it for everyone'); assert.equal((await act('alice', id, 'end')).status, 404);
  const ended = await act('bob', id, 'end'); assert.equal(ended.body.room.status, 'ended'); assert.equal(ended.body.room.end_reason, 'ended_by_host');
  for (const n of ['dave', 'erin']) assert.ok(await until(() => sk[n].of('room_state').find((m) => m.room.status === 'ended')), n + ' was told it ended');
  assert.equal((await act('bob', id, 'join')).status, 404); assert.equal((await act('dave', id, 'leave')).status, 404);
  // empty room closes itself and ends pending invitations
  const e = (await mk('alice', [ext.bob, ext.carol])).body.room; await act('bob', e.id, 'join'); await act('alice', e.id, 'leave'); const last = await act('bob', e.id, 'leave'); assert.equal(last.body.room.status, 'ended'); assert.equal(last.body.room.end_reason, 'empty');
  assert.equal((await db.pool.query("SELECT status FROM voice_room_members WHERE room_id=$1 AND account_id='carol'", [e.id])).rows[0].status, 'missed');
  Object.values(sk).forEach((s) => s.close()); await cleanup();
});

test('the seat is fenced like a call: a replaced device loses authority, peers learn the new generation, and the old device cannot renew', async (t) => {
  if (skip(t)) return; await cleanup();
  const a = await r.connect('alice', 'd1'), b1 = await r.connect('bob', 'd1'), b2 = await r.connect('bob', 'd2'), c = await r.connect('carol', 'd1');
  const id = (await mk('alice', [ext.bob, ext.carol])).body.room.id; await act('bob', id, 'join'); await act('carol', id, 'join');
  b1.send({ type: 'g_offer', roomId: id, to: 'alice', generation: 1, sdp: SDP }); assert.ok(await until(() => a.of('g_offer')[0]));
  const claim = await r.api('bob', 'POST', `/v1/voice/rooms/${id}/device`, { deviceId: r.device('bob', 'd2') }); assert.equal(claim.body.generation, 2);
  const rev = await until(() => b1.of('device_revoked')[0]); assert.ok(rev && rev.roomId === id && rev.revokedDevice === r.device('bob', 'd1') && rev.generation === 2);
  const seen = await until(() => c.of('room_state').find((m) => m.room.members.find((x) => x.account_id === 'bob' && x.generation === 2))); assert.ok(seen, 'peers learn bob has a new device generation');
  const n = a.inbox.length; b1.send({ type: 'g_offer', roomId: id, to: 'alice', generation: 1, sdp: SDP }); b1.send({ type: 'g_offer', roomId: id, to: 'alice', generation: 2, sdp: SDP }); await wait(300); assert.equal(a.inbox.length, n);
  b2.send({ type: 'g_offer', roomId: id, to: 'alice', generation: 2, sdp: SDP }); assert.ok(await until(() => a.of('g_offer').find((m) => m.gen === 2)));
  a.send({ type: 'g_answer', roomId: id, to: 'bob', generation: 1, sdp: SDP }); assert.ok(await until(() => b2.of('g_answer')[0])); assert.equal(b1.of('g_answer').length, 0, 'the answer goes to the NEW device only');
  assert.equal((await r.api('bob', 'POST', `/v1/voice/rooms/${id}/device-refresh`, { deviceId: r.device('bob', 'd1'), generation: 1 })).status, 409);
  assert.equal((await r.api('bob', 'POST', `/v1/voice/rooms/${id}/device-refresh`, { deviceId: r.device('bob', 'd2'), generation: 2 })).status, 200);
  assert.equal((await r.api('dave', 'POST', `/v1/voice/rooms/${id}/device`, { deviceId: r.device('dave') })).status, 404);
  [a, b1, b2, c].forEach((s) => s.close()); await cleanup();
});

test('inputs are validated, blocks are honoured, suspension removes a member, and nobody can be pulled in against their will', async (t) => {
  if (skip(t)) return; await cleanup();
  const d = r.device('alice');
  for (const body of [{}, { extensions: 'x', deviceId: d }, { extensions: [ext.bob], deviceId: 'nope' }, { extensions: ['12'], deviceId: d }, { extensions: Array(8).fill(ext.bob), deviceId: d }, { extensions: [], deviceId: d }]) assert.equal((await r.api('alice', 'POST', '/v1/voice/rooms', body)).status, 400, JSON.stringify(body).slice(0, 60));
  assert.equal((await mk('alice', ['999999'])).status, 404); assert.equal((await mk('alice', [ext.alice])).status, 404);
  assert.equal((await mk('alice', [ext.bob, ext.carol, ext.dave, ext.erin, ext.frank, ext.gina])).status, 400, 'a room holds at most 6 people');
  assert.equal((await r.api('alice', 'POST', '/v1/voice/rooms/not-an-id/join', { deviceId: d })).status, 400); assert.equal((await r.api('alice', 'POST', `/v1/voice/rooms/${randomUUID()}/explode`, {})).status, 400);
  assert.equal((await r.api(null, 'POST', '/v1/voice/rooms', { extensions: [ext.bob], deviceId: d })).status, 401);
  assert.equal((await r.api('carol', 'POST', '/v1/voice/blocks', { extension: ext.alice })).status, 201); assert.equal((await mk('alice', [ext.carol])).body.error, 'blocked'); assert.equal((await mk('carol', [ext.alice])).body.error, 'blocked');
  await r.api('carol', 'DELETE', '/v1/voice/blocks/' + ext.alice);
  const id = (await mk('alice', [ext.bob, ext.carol])).body.room.id; await act('bob', id, 'join');
  assert.equal((await act('carol', id, 'invite', { extension: ext.dave })).status, 404, 'an invited member cannot invite others');
  await r.api('carol', 'POST', '/v1/voice/blocks', { extension: ext.alice }); assert.equal((await act('bob', id, 'invite', { extension: ext.alice })).body.reused, true);
  const x = await r.api('dave', 'POST', '/v1/voice/blocks', { extension: ext.bob }); assert.equal(x.status, 201); assert.equal((await act('bob', id, 'invite', { extension: ext.dave })).body.error, 'blocked');
  const res = await r.admin('POST', '/identities/bob/enabled', { enabled: false }); assert.equal(res.status, 200);
  const room = (await r.api('alice', 'GET', `/v1/voice/rooms/${id}`)).body.room; assert.equal(room.members.some((m) => m.account_id === 'bob'), false, 'a suspended account is removed from the room'); assert.equal((await act('bob', id, 'join')).status, 404);
  await r.admin('POST', '/identities/bob/enabled', { enabled: true }); await r.api('carol', 'DELETE', '/v1/voice/blocks/' + ext.alice); await r.api('dave', 'DELETE', '/v1/voice/blocks/' + ext.bob);
  const u = (await r.api('alice', 'GET', '/v1/voice/usage')).body; assert.ok(u.groupRooms >= 1); assert.equal(typeof u.groupSeconds, 'number'); await cleanup();
});

test('invitations nobody answers become missed, and a seat whose device stopped renewing is dropped after the grace period', async (t) => {
  if (skip(t)) return; await cleanup();
  const a = await r.connect('alice'), b = await r.connect('bob');
  const id = (await mk('alice', [ext.bob, ext.carol])).body.room.id; await act('bob', id, 'join');
  await db.pool.query("UPDATE voice_room_members SET invited_at = now() - interval '10 minutes' WHERE room_id=$1 AND account_id='carol'", [id]);
  const store = (await import('../src/store.mjs')).createStore(db.pool); assert.equal(await store.rooms.expireInvites(60), 1); r.voice.kick();
  assert.equal((await db.pool.query("SELECT status FROM voice_room_members WHERE room_id=$1 AND account_id='carol'", [id])).rows[0].status, 'missed');
  assert.ok(await until(() => a.of('room_state').find((m) => !m.room.members.some((x) => x.account_id === 'carol'))), 'the room is told');
  assert.equal(await store.rooms.expireInvites(60), 0, 'idempotent');
  await db.pool.query("UPDATE voice_room_members SET lease_expires_at = now() - interval '5 minutes' WHERE room_id=$1 AND account_id='bob'", [id]);
  assert.equal(await store.rooms.expireStaleMembers(120), 1); r.voice.kick(); assert.equal((await db.pool.query("SELECT status FROM voice_room_members WHERE room_id=$1 AND account_id='bob'", [id])).rows[0].status, 'left');
  assert.ok(await until(() => b.of('room_state').find((m) => !m.room.members.some((x) => x.account_id === 'bob'))), 'the dropped member is told');
  assert.equal(await store.rooms.expireStaleMembers(120), 0); assert.equal((await r.dial('bob', ext.dave)).status, 201, 'bob is no longer stuck in a room'); await r.api('dave', 'POST', `/v1/voice/calls/${(await r.api('dave', 'GET', '/v1/voice/calls/live')).body.call.id}/reject`, {});
  await store.rooms.leave(id, 'alice').catch(() => {}); a.close(); b.close(); await cleanup();
});

test('concurrent joins cannot exceed the room size, and one account cannot be in two rooms at once', async (t) => {
  if (skip(t)) return; await cleanup();
  const id = (await mk('alice', [ext.bob, ext.carol, ext.dave, ext.erin, ext.frank])).body.room.id;
  const out = await Promise.all(['bob', 'carol', 'dave', 'erin', 'frank'].map((n) => act(n, id, 'join'))); assert.ok(out.every((x) => x.status === 200));
  assert.equal(Number((await db.pool.query("SELECT count(*) n FROM voice_room_members WHERE room_id=$1 AND status='joined'", [id])).rows[0].n), 6);
  await cleanup();
  const two = (await mk('gina', [ext.hank])).body.room.id, rival = await mk('hank', [ext.gina]); assert.equal(rival.status, 201, 'an invitation alone does not make hank busy');
  assert.equal((await act('hank', two, 'join')).body.error, 'busy', 'hank now hosts another room'); assert.equal((await act('gina', rival.body.room.id, 'join')).body.error, 'busy', 'and gina hosts the first one');
  assert.equal((await act('gina', two, 'leave')).status, 200); assert.equal((await act('gina', rival.body.room.id, 'join')).status, 200, 'free again after leaving'); await cleanup();
});
