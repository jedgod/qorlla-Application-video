// Group call history on real PostgreSQL: every outcome, rejoin segments, timeline, privacy between accounts, exact pagination, atomicity with the room change, migration backfill, concurrency.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createStore } from '../src/store.mjs';
import { decodeCursor } from '../src/history.mjs';
import { isolatedDb, identityProvider, wait } from './helpers.mjs';
import { harness } from './harness.mjs';

let db, idp, h, r, ext, store;
const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'];
before(async () => { db = await isolatedDb(); if (!db) return; idp = await identityProvider(); h = harness({ db, idp }); r = await h.replica({ maintenance: false }); store = createStore(db.pool); ext = await h.people(r, NAMES); });
after(async () => { if (h) await h.closeAll(); if (idp) await idp.close(); if (db) await db.drop(); });
const skip = (t) => !db && t.skip('no PostgreSQL reachable');
const mk = (from, exts, title = '') => r.api(from, 'POST', '/v1/voice/rooms', { extensions: exts, title, deviceId: r.device(from) });
const act = (account, id, action, body = {}) => r.api(account, 'POST', `/v1/voice/rooms/${id}/${action}`, action === 'join' ? { deviceId: r.device(account), ...body } : body);
const hist = async (account, q = '') => (await r.api(account, 'GET', '/v1/voice/history' + q)).body;
const item = async (account, id) => (await hist(account, '?limit=100')).items.find((i) => i.call_id === id);
const detail = (account, id) => r.api(account, 'GET', '/v1/voice/history/' + id);
const clean = () => db.pool.query("UPDATE voice_rooms SET status='ended', ended_at=now() WHERE status='live'").then(() => db.pool.query("UPDATE voice_room_members SET status='left' WHERE status IN ('joined','invited')"));

test('every outcome, rejoin segments summing to the duration, host transfer, and a timeline that is correct for each person', async (t) => {
  if (skip(t)) return; await clean();
  const id = (await mk('alice', [ext.bob, ext.carol, ext.dave], 'Standup')).body.room.id;
  assert.equal((await item('alice', id)).status, 'ongoing'); assert.equal((await item('alice', id)).role, 'host'); assert.equal((await item('carol', id)).status, 'ringing'); assert.equal((await item('erin', id)), undefined, 'a stranger sees nothing');
  await act('bob', id, 'join'); await act('carol', id, 'decline'); await wait(1100);
  assert.equal((await item('carol', id)).status, 'declined'); assert.equal((await item('bob', id)).status, 'ongoing'); assert.equal((await item('dave', id)).status, 'ringing');
  // bob leaves and rejoins: two segments, one total duration
  await act('bob', id, 'leave'); assert.equal((await item('bob', id)).status, 'completed'); await wait(1100);
  // alice (host) leaves while bob is out: nobody else is joined -> then bob rejoins? bob is no longer invited, so alice stays; she re-invites him
  assert.equal((await act('alice', id, 'invite', { extension: ext.bob })).status, 200); await act('bob', id, 'join'); await wait(1100);
  const d = (await detail('bob', id)).body; assert.equal(d.segments.length, 2, 'two stays'); assert.ok(d.segments[0].left_at && d.segments[1].left_at === null);
  assert.equal(d.status, 'ongoing'); assert.equal(d.room_name, 'Standup');
  // host leaves: bob becomes host and the change is on the timeline for everyone
  await act('alice', id, 'leave'); assert.equal((await item('bob', id)).role, 'host');
  const ended = await act('bob', id, 'end'); assert.equal(ended.status, 200);
  const fin = { alice: await item('alice', id), bob: await item('bob', id), carol: await item('carol', id), dave: await item('dave', id) };
  assert.deepEqual([fin.alice.status, fin.bob.status, fin.carol.status, fin.dave.status], ['completed', 'completed', 'declined', 'cancelled']);
  assert.equal(fin.dave.duration_seconds, 0); assert.ok(fin.alice.duration_seconds >= 3, 'alice was in for over 3 s: ' + fin.alice.duration_seconds); assert.equal(fin.alice.room_status, 'ended'); assert.equal(fin.alice.end_reason, 'ended_by_host'); assert.ok(fin.alice.ended_at && fin.alice.started_at);
  const bd = (await detail('bob', id)).body, total = bd.segments.reduce((s, x) => s + Math.round((new Date(x.left_at) - new Date(x.joined_at)) / 1000), 0);
  assert.ok(Math.abs(total - bd.duration_seconds) <= 1, 'duration is the sum of the segments'); assert.equal(bd.participants, 2, 'alice and bob took part; the others are only counted');
  const kinds = (u) => detail(u, id).then((x) => x.body.events.map((e) => e.event_type + ':' + e.subject_scope));
  assert.deepEqual(await kinds('bob'), ['invited:self', 'joined:self', 'left:self', 'invited:self', 'joined:self', 'host_transferred:self', 'left:self']);
  assert.ok((await kinds('carol')).includes('host_transferred:other') && (await kinds('carol')).includes('declined:self'), 'carol sees that the host changed, without who');
  assert.equal(JSON.stringify((await detail('carol', id)).body).includes('alice') || JSON.stringify((await detail('carol', id)).body).includes('bob'), false, 'no other participant is identified');
});

test('kicked, missed (invitation expired) and a lease-expired stay are recorded; a suspended invitee is missed', async (t) => {
  if (skip(t)) return; await clean();
  const id = (await mk('alice', [ext.bob, ext.carol, ext.dave, ext.erin])).body.room.id; await act('bob', id, 'join'); await act('carol', id, 'join'); await wait(600);
  assert.equal((await act('alice', id, 'kick', { accountId: 'bob' })).status, 200); const bob = await item('bob', id); assert.equal(bob.status, 'kicked'); assert.ok(bob.duration_seconds >= 0);
  assert.ok((await detail('bob', id)).body.events.some((e) => e.event_type === 'kicked'));
  assert.equal((await detail('bob', id)).body.segments.every((s) => s.left_at), true, 'a kick closes the stay');
  await db.pool.query("UPDATE voice_room_members SET invited_at = now() - interval '10 minutes' WHERE room_id=$1 AND account_id='dave'", [id]); assert.equal(await store.rooms.expireInvites(60), 1);
  assert.equal((await item('dave', id)).status, 'missed');
  assert.equal((await r.admin('POST', '/identities/erin/enabled', { enabled: false })).status, 200); assert.equal((await item('erin', id)).status, 'missed'); await r.admin('POST', '/identities/erin/enabled', { enabled: true });
  await db.pool.query("UPDATE voice_room_members SET lease_expires_at = now() - interval '5 minutes' WHERE room_id=$1 AND account_id='carol'", [id]); assert.equal(await store.rooms.expireStaleMembers(120), 1);
  const carol = await item('carol', id); assert.equal(carol.status, 'completed'); assert.equal((await detail('carol', id)).body.segments.every((s) => s.left_at), true);
  await act('alice', id, 'end');
  // the room emptied by the last person leaving also cancels the invitations still open
  const e = (await mk('alice', [ext.bob])).body.room.id; await act('alice', e, 'leave'); assert.equal((await item('bob', e)).status, 'cancelled'); assert.equal((await item('alice', e)).status, 'completed');
  assert.deepEqual((await detail('bob', e)).body.events.map((x) => x.event_type), ['invited', 'cancelled']);
});

test('privacy and validation: only your own calls, no other account ids, bounded input, no caching', async (t) => {
  if (skip(t)) return; await clean();
  const id = (await mk('alice', [ext.bob], 'Private')).body.room.id; await act('bob', id, 'join');
  assert.equal((await detail('carol', id)).status, 404); assert.equal((await detail('alice', randomUUID())).status, 404); assert.equal((await detail('alice', 'not-an-id')).status, 400);
  assert.equal((await r.api(null, 'GET', '/v1/voice/history')).status, 401); assert.equal((await r.api(null, 'GET', '/v1/voice/history/' + id)).status, 401);
  assert.ok(!(await hist('carol', '?limit=100')).items.some((i) => i.call_id === id), 'carol was never in this room');
  const own = await r.api('bob', 'GET', '/v1/voice/history'); assert.equal(own.headers.get('cache-control'), 'private, no-store');
  const text = JSON.stringify(own.body); for (const other of ['alice', 'carol', 'dave']) assert.ok(!text.includes('"' + other + '"'), 'no other account in the list');
  for (const q of ['?limit=0', '?limit=101', '?limit=abc', '?limit=1.5', '?limit=-1']) assert.equal((await r.api('bob', 'GET', '/v1/voice/history' + q)).status, 400, q);
  for (const q of ['?cursor=garbage', '?cursor=' + Buffer.from('{"at":"yesterday","id":"x"}').toString('base64url'), '?cursor=' + 'a'.repeat(600)]) assert.equal((await r.api('bob', 'GET', '/v1/voice/history' + q)).body.error, 'invalid_cursor', q);
  assert.throws(() => decodeCursor(Buffer.from('{"at":"2026-01-01T00:00:00.123456Z","id":"nope"}').toString('base64url')), /invalid_cursor/);
  await act('bob', id, 'leave'); await act('alice', id, 'end');
});

test('pagination never skips or repeats a call, even when many calls share the same timestamp', async (t) => {
  if (skip(t)) return; await clean(); await db.pool.query("DELETE FROM voice_rooms"); const ids = [];
  for (let i = 0; i < 9; i++) { const x = (await mk('alice', [ext.bob])).body.room.id; ids.push(x); await act('alice', x, 'end'); }
  const walk = async (limit) => { const seen = []; let cursor = null, pages = 0; do { const p = await hist('alice', `?limit=${limit}` + (cursor ? '&cursor=' + cursor : '')); seen.push(...p.items.map((i) => i.call_id)); cursor = p.nextCursor; pages++; } while (cursor && pages < 30); return { seen, pages }; };
  let w = await walk(4); assert.equal(w.pages, 3); assert.equal(new Set(w.seen).size, 9); assert.deepEqual([...w.seen].sort(), [...ids].sort());
  const times = (await db.pool.query('SELECT created_at FROM voice_rooms ORDER BY created_at DESC')).rows.map((x) => +x.created_at); assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
  await db.pool.query("UPDATE voice_rooms SET created_at = timestamptz '2026-01-01 10:00:00.123456+00'");                         // every call at the very same microsecond
  for (const limit of [1, 2, 4, 9, 25]) { w = await walk(limit); assert.equal(new Set(w.seen).size, 9, 'limit ' + limit); assert.equal(w.seen.length, 9, 'no repeats at limit ' + limit); }
  assert.equal((await hist('alice', '?limit=9')).nextCursor, null);
});

test('the history commits with the room change or not at all (a failed transaction leaves no room, segment or timeline entry)', async (t) => {
  if (skip(t)) return; await clean();
  const failing = { connect: async () => { const c = await db.pool.connect(), q = c.query, release = c.release; c.query = (sql, ...a) => (typeof sql === 'string' && sql.includes('INSERT INTO voice_outbox') ? Promise.reject(new Error('simulated crash')) : q.call(c, sql, ...a)); c.release = (...x) => { c.query = q; c.release = release; return release.apply(c, x); }; return c; }, query: (...a) => db.pool.query(...a) };
  const count = async (sql) => Number((await db.pool.query(sql)).rows[0].n), before = { rooms: await count('SELECT count(*) n FROM voice_rooms'), seg: await count('SELECT count(*) n FROM voice_room_segments'), ev: await count('SELECT count(*) n FROM voice_room_events') };
  await assert.rejects(createStore(failing).rooms.createRoom('alice', [ext.bob], { deviceId: h.device('alice') }), /simulated crash/);
  assert.deepEqual({ rooms: await count('SELECT count(*) n FROM voice_rooms'), seg: await count('SELECT count(*) n FROM voice_room_segments'), ev: await count('SELECT count(*) n FROM voice_room_events') }, before);
  const room = (await store.rooms.createRoom('alice', [ext.bob], { deviceId: h.device('alice') })).room; await assert.rejects(createStore(failing).rooms.join(room.id, 'bob', h.device('bob')), /simulated crash/);
  assert.equal((await item('bob', room.id)).status, 'ringing'); assert.equal(await count(`SELECT count(*) n FROM voice_room_segments WHERE account_id='bob'`), 0); await store.rooms.end(room.id, 'alice');
});

test('concurrency: simultaneous joins and leaves leave exactly one closed stay each, never an open one', async (t) => {
  if (skip(t)) return; await clean();
  const who = ['bob', 'carol', 'dave', 'erin', 'frank'], id = (await mk('alice', who.map((n) => ext[n]))).body.room.id;
  assert.ok((await Promise.all(who.map((n) => act(n, id, 'join')))).every((x) => x.status === 200)); await wait(300);
  assert.ok((await Promise.all(who.map((n) => act(n, id, 'leave')))).every((x) => x.status === 200));
  const rows = (await db.pool.query('SELECT account_id, count(*)::int n, count(*) FILTER (WHERE left_at IS NULL)::int open FROM voice_room_segments WHERE room_id=$1 GROUP BY account_id', [id])).rows;
  assert.equal(rows.length, 6); for (const x of rows) assert.equal(x.n, 1, x.account_id), assert.equal(x.open, x.account_id === 'alice' ? 1 : 0, x.account_id + ' open stays');
  for (const n of who) assert.equal((await item(n, id)).status, 'completed'); assert.equal((await item('alice', id)).status, 'ongoing'); await act('alice', id, 'end'); assert.equal((await item('alice', id)).status, 'completed');
  assert.equal(Number((await db.pool.query('SELECT count(*) n FROM voice_room_segments WHERE left_at IS NULL AND room_id=$1', [id])).rows[0].n), 0, 'ending the room closes every stay');
});

test('the migration backfills rooms that existed before it, and running it twice changes nothing', async (t) => {
  if (skip(t)) return; await clean();
  const old = randomUUID(), sql = readFileSync(new URL('../sql/007_group_history.sql', import.meta.url), 'utf8');
  await db.pool.query("INSERT INTO voice_rooms(id, host_id, title, status, ended_at, end_reason) VALUES($1,'alice','Legacy','ended', now(), 'ended_by_host')", [old]);
  await db.pool.query("INSERT INTO voice_room_members(room_id, account_id, role, status, joined_at, left_at) VALUES($1,'alice','host','left', now() - interval '10 minutes', now() - interval '5 minutes')", [old]);
  await db.pool.query("INSERT INTO voice_room_members(room_id, account_id, role, status) VALUES($1,'bob','member','declined'),($1,'carol','member','removed'),($1,'dave','member','missed')", [old]);
  await db.pool.query(sql); const first = await db.pool.query('SELECT count(*)::int n FROM voice_room_segments WHERE room_id=$1', [old]); await db.pool.query(sql);
  assert.equal(first.rows[0].n, 1); assert.equal(Number((await db.pool.query('SELECT count(*) n FROM voice_room_segments WHERE room_id=$1', [old])).rows[0].n), 1, 'idempotent');
  const s = Object.fromEntries(await Promise.all(['alice', 'bob', 'carol', 'dave'].map(async (n) => [n, await item(n, old)]))); assert.deepEqual([s.alice.status, s.bob.status, s.carol.status, s.dave.status], ['completed', 'declined', 'kicked', 'missed']);
  assert.ok(Math.abs(s.alice.duration_seconds - 300) <= 1, 'the legacy duration is recovered from joined_at/left_at');
});
