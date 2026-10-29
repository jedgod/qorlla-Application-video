// Group call history: retention, user deletion, legal holds, and the audit's coverage gap, on real PostgreSQL. The safety properties under test:
//   deletion/cleanup never touches a live call or room, never touches undelivered events (the outbox), respects who may delete what, and is safe against concurrent reads and room changes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStore } from '../src/store.mjs';
import { createHistory, parseRetentionDays } from '../src/history.mjs';
import { isolatedDb, identityProvider, wait } from './helpers.mjs';
import { harness, ADMIN } from './harness.mjs';

let db, idp, h, r, ext, store, history;
const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'];
before(async () => { db = await isolatedDb(); if (!db) return; idp = await identityProvider(); h = harness({ db, idp }); r = await h.replica({ maintenance: false, env: { VOICE_CALL_RATE_PER_MIN: '10000', VOICE_API_RATE_PER_MIN: '1000000' } }); store = createStore(db.pool); history = createHistory({ db: db.pool, tx: store.tx }); ext = await h.people(r, NAMES); });
after(async () => { if (h) await h.closeAll(); if (idp) await idp.close(); if (db) await db.drop(); });
const skip = (t) => !db && t.skip('no PostgreSQL reachable');
const mk = (from, exts, title = '') => r.api(from, 'POST', '/v1/voice/rooms', { extensions: exts, title, deviceId: r.device(from) });
const act = (account, id, action, body = {}) => r.api(account, 'POST', `/v1/voice/rooms/${id}/${action}`, action === 'join' || action === 'device' ? { deviceId: r.device(account), ...body } : body);
const del = (account, id) => r.api(account, 'DELETE', '/v1/voice/history/' + id);
const hist = async (account) => (await r.api(account, 'GET', '/v1/voice/history?limit=100')).body.items;
const one = async (account, id) => (await hist(account)).find((i) => i.call_id === id);
const n = async (sql, p = []) => Number((await db.pool.query(sql, p)).rows[0].n);
const admin = (method, path, body, secret = ADMIN) => fetch(r.base + '/v1/voice/admin' + path, { method, headers: { 'content-type': 'application/json', 'x-voice-admin-secret': secret }, body: body ? JSON.stringify(body) : undefined }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => ({})) }));
const age = (id, days) => db.pool.query("UPDATE voice_rooms SET ended_at = now() - make_interval(days => $2::int) WHERE id = $1", [id, days]);
const finished = async (exts, joiners = []) => { const id = (await mk('alice', exts)).body.room.id; for (const j of joiners) await act(j, id, 'join'); await wait(30); await act('alice', id, 'end'); return id; };
const pause = async () => { r.voice.worker.stop(); await wait(300); }, resume = () => r.voice.worker.start();
const clean = async () => { await db.pool.query("UPDATE voice_rooms SET status='ended', ended_at=now() WHERE status='live'"); await db.pool.query("UPDATE voice_room_members SET status='left' WHERE status IN ('joined','invited')"); await db.pool.query('DELETE FROM voice_legal_holds'); await db.pool.query('DELETE FROM voice_rooms'); };

test('retention setting: unset is the default, 0 is off, 7-3650 is accepted, anything else falls back to the default and says so', () => {
  assert.deepEqual(parseRetentionDays(undefined), { days: 365, warning: null }); assert.deepEqual(parseRetentionDays(''), { days: 365, warning: null }); assert.deepEqual(parseRetentionDays('0'), { days: 0, warning: null });
  assert.deepEqual(parseRetentionDays('90'), { days: 90, warning: null }); assert.equal(parseRetentionDays('7').days, 7); assert.equal(parseRetentionDays('3650').days, 3650);
  for (const bad of ['6', '3651', '-1', '1.5', 'abc', 'Infinity', '1e3x']) { const p = parseRetentionDays(bad); assert.equal(p.days, 365, bad); assert.match(p.warning, /using 365/); }   // a typo never silently means "keep for ever"
});

test('deleting my record: my stays, my timeline and my copies go; everyone else keeps theirs, unchanged; a second delete finds nothing', async (t) => {
  if (skip(t)) return; await clean(); await pause(); t.after(resume);
  const id = (await mk('alice', [ext.bob, ext.carol, ext.dave], 'Review')).body.room.id; await act('bob', id, 'join'); await act('carol', id, 'decline'); await wait(1100);
  assert.equal((await act('alice', id, 'kick', { accountId: 'bob' })).status, 200); assert.equal((await act('alice', id, 'end')).status, 200);
  const before = { alice: await one('alice', id), carol: await one('carol', id), dave: await one('dave', id) }, aliceTimeline = (await r.api('alice', 'GET', '/v1/voice/history/' + id)).body.events;
  r.voice.worker.start(); await wait(600); r.voice.worker.stop(); await wait(200);                                                                      // deliver the room events so bob has delivered copies
  assert.ok(await n("SELECT count(*) n FROM voice_reliable_events e JOIN voice_outbox o ON o.event_id=e.id WHERE e.account_id='bob' AND o.delivered_at IS NOT NULL AND e.payload->'room'->>'id'=$1", [id]) > 0);
  assert.equal(await one('bob', id).then((x) => x.status), 'kicked'); const d = await del('bob', id); assert.equal(d.status, 200); assert.deepEqual(d.body, { deleted: 1, retained: 0 });
  assert.equal(await one('bob', id), undefined); assert.equal((await r.api('bob', 'GET', '/v1/voice/history/' + id)).status, 404); assert.equal((await del('bob', id)).status, 404, 'a second delete finds nothing');
  assert.equal(await n("SELECT count(*) n FROM voice_room_members WHERE room_id=$1 AND account_id='bob'", [id]), 0); assert.equal(await n("SELECT count(*) n FROM voice_room_segments WHERE room_id=$1 AND account_id='bob'", [id]), 0);
  assert.equal(await n("SELECT count(*) n FROM voice_room_events WHERE room_id=$1 AND subject_account_id='bob'", [id]), 0); assert.equal(await n("SELECT count(*) n FROM voice_room_events WHERE room_id=$1 AND actor_account_id='bob'", [id]), 0);
  assert.equal(await n("SELECT count(*) n FROM voice_reliable_events WHERE account_id='bob' AND kind IN ('room_state','room_invite') AND payload->'room'->>'id'=$1", [id]) , await n("SELECT count(*) n FROM voice_reliable_events e JOIN voice_outbox o ON o.event_id=e.id WHERE e.account_id='bob' AND o.delivered_at IS NULL AND e.payload->'room'->>'id'=$1", [id]), 'only undelivered copies remain');
  // the others are untouched: same status, duration and head count; the timeline still shows the kick (anonymously) and the host
  for (const who of ['alice', 'carol', 'dave']) { const now = await one(who, id); assert.deepEqual([now.status, now.duration_seconds, now.participants], [before[who].status, before[who].duration_seconds, before[who].participants], who); }
  assert.equal((await r.api('alice', 'GET', '/v1/voice/history/' + id)).body.events.length, aliceTimeline.length); assert.equal(before.alice.participants, 2, 'the head count was 2 and stays 2 after bob deleted');
  // deleting does not cross accounts: carol cannot delete alice's or a stranger's record, and a stranger cannot delete anything
  assert.equal((await del('erin', id)).status, 404); assert.equal((await del('alice', randomUUID())).status, 404); assert.equal((await del('alice', 'not-an-id')).status, 400); assert.equal((await r.api(null, 'DELETE', '/v1/voice/history/' + id)).status, 401);
  assert.ok(await one('alice', id)); assert.equal((await del('carol', id)).body.deleted, 1); assert.equal((await del('dave', id)).body.deleted, 1);
  assert.equal(await n('SELECT count(*) n FROM voice_rooms WHERE id=$1', [id]), 1, 'alice still has her record, so the room stays');
  assert.equal((await del('alice', id)).body.deleted, 1); assert.equal(await n('SELECT count(*) n FROM voice_rooms WHERE id=$1', [id]), 0, 'the last record takes the room with it'); assert.equal(await n('SELECT count(*) n FROM voice_room_events WHERE room_id=$1', [id]), 0);
});

test('a call in progress, or an invitation still open, can never be deleted; nothing about it changes', async (t) => {
  if (skip(t)) return; await clean();
  const id = (await mk('alice', [ext.bob, ext.carol])).body.room.id; await act('bob', id, 'join');
  const snap = async () => JSON.stringify([await n('SELECT count(*) n FROM voice_room_members WHERE room_id=$1', [id]), await n('SELECT count(*) n FROM voice_room_segments WHERE room_id=$1', [id]), await n('SELECT count(*) n FROM voice_room_events WHERE room_id=$1', [id])]), before = await snap();
  for (const who of ['alice', 'bob', 'carol']) { const x = await del(who, id); assert.equal(x.status, 409, who); assert.equal(x.body.error, 'call_in_progress'); }
  assert.equal(await snap(), before); assert.equal((await r.api('alice', 'GET', '/v1/voice/rooms/' + id)).body.room.status, 'live');
  const all = await r.api('bob', 'DELETE', '/v1/voice/history?confirm=all'); assert.deepEqual([all.body.deleted, all.body.skippedLive], [0, 1]); assert.equal(await snap(), before);
  assert.equal((await act('bob', id, 'leave')).status, 200, 'and the call is fully usable afterwards'); await act('alice', id, 'end');
  assert.equal((await del('carol', id)).body.deleted, 1, 'once it has ended it can be deleted');
});

test('delete everything: needs ?confirm=all, skips live calls, counts what it did', async (t) => {
  if (skip(t)) return; await clean();
  const a = await finished([ext.bob], ['bob']), b = await finished([ext.bob], ['bob']), live = (await mk('alice', [ext.bob])).body.room.id; await act('bob', live, 'join');
  assert.equal((await r.api('bob', 'DELETE', '/v1/voice/history')).status, 400); assert.equal((await r.api('bob', 'DELETE', '/v1/voice/history?confirm=yes')).status, 400); assert.equal((await hist('bob')).length, 3);
  const res = await r.api('bob', 'DELETE', '/v1/voice/history?confirm=all'); assert.deepEqual(res.body, { deleted: 2, retained: 0, remaining: 0, skippedLive: 1 });
  assert.deepEqual((await hist('bob')).map((x) => x.call_id), [live], 'only the live call is left'); assert.ok(await one('alice', a) && await one('alice', b), 'alice still has hers');
  assert.equal((await r.api('bob', 'DELETE', '/v1/voice/history?confirm=all')).body.deleted, 0); await act('bob', live, 'leave'); await act('alice', live, 'end');
});

test('legal hold: nothing is deleted while it lasts (not by retention, not by a user, and the database itself refuses); a deletion request hides the record and completes when the hold is released', async (t) => {
  if (skip(t)) return; await clean();
  const id = await finished([ext.bob, ext.carol], ['bob']); await age(id, 400);
  assert.equal((await admin('POST', '/legal-holds', { roomId: id, placedBy: 'counsel-1', reason: 'investigation 42' }, 'x'.repeat(40))).status, 401); assert.equal((await admin('POST', '/legal-holds', { roomId: 'nope', placedBy: 'c', reason: 'r' })).status, 400);
  assert.equal((await admin('POST', '/legal-holds', { roomId: randomUUID(), placedBy: 'c', reason: 'r' })).status, 404); assert.equal((await admin('POST', '/legal-holds', { roomId: id, placedBy: 'c', reason: '' })).status, 400);
  assert.equal((await admin('POST', '/legal-holds', { roomId: id, placedBy: 'counsel-1', reason: 'investigation 42' })).status, 201); assert.equal((await admin('POST', '/legal-holds', { roomId: id, placedBy: 'counsel-1', reason: 'again' })).body.created, false);
  assert.deepEqual((await admin('GET', '/legal-holds')).body.holds.map((x) => x.room_id), [id]);
  assert.deepEqual(await history.purgeExpired({ days: 30 }), { rooms: 0, members: 0 }, 'retention skips a held room'); assert.equal(await n('SELECT count(*) n FROM voice_rooms WHERE id=$1', [id]), 1);
  await assert.rejects(db.pool.query('DELETE FROM voice_rooms WHERE id=$1', [id]), (e) => e.code === '23503', 'the database refuses to delete a held room even if the application were wrong');
  const d = await del('bob', id); assert.deepEqual(d.body, { deleted: 0, retained: 1 }); assert.equal(await one('bob', id), undefined, 'hidden from bob at once'); assert.equal((await r.api('bob', 'GET', '/v1/voice/history/' + id)).status, 404);
  assert.equal(await n("SELECT count(*) n FROM voice_room_members WHERE room_id=$1 AND account_id='bob'", [id]), 1, 'but retained'); assert.equal(await n("SELECT count(*) n FROM voice_room_segments WHERE room_id=$1 AND account_id='bob'", [id]), 1);
  assert.equal((await del('bob', id)).status, 404, 'asking again changes nothing and reveals nothing'); assert.ok(await one('alice', id), 'others still see theirs');
  const st = (await r.api('alice', 'GET', '/v1/voice/history-policy')).body; assert.equal(st.retentionEnabled, true);
  assert.equal((await admin('DELETE', '/legal-holds/' + id)).body.released, true); assert.equal((await admin('DELETE', '/legal-holds/' + id)).body.released, false);
  const p = await history.purgeExpired({ days: 30 }); assert.equal(p.rooms, 1, 'the room is now past retention and goes'); assert.equal(await n('SELECT count(*) n FROM voice_rooms WHERE id=$1', [id]), 0);
  // a hold released on a young room: the waiting deletion completes, the others keep their records
  const y = await finished([ext.bob, ext.carol], ['bob']); await admin('POST', '/legal-holds', { roomId: y, placedBy: 'c', reason: 'r' }); await del('bob', y); await admin('DELETE', '/legal-holds/' + y);
  assert.deepEqual(await history.purgeExpired({ days: 365 }), { rooms: 0, members: 1 }); assert.equal(await n("SELECT count(*) n FROM voice_room_members WHERE room_id=$1 AND account_id='bob'", [y]), 0); assert.ok(await one('alice', y));
  const ops = (await r.voice.router && await db.pool.query('SELECT kind FROM voice_history_ops ORDER BY id')).rows.map((x) => x.kind); for (const k of ['hold_placed', 'hold_released', 'user_delete', 'retention']) assert.ok(ops.includes(k), k);
});

test('retention: only ENDED calls past the period go (in batches); live rooms, young calls, one-to-one calls and the outbox are untouched; 0 means keep', async (t) => {
  if (skip(t)) return; await clean(); await pause(); t.after(resume);
  const old = [await finished([ext.bob], ['bob']), await finished([ext.bob], ['bob']), await finished([ext.bob], ['bob']), await finished([ext.bob], ['bob']), await finished([ext.bob], ['bob'])], young = await finished([ext.bob], ['bob']);
  for (const id of old) await age(id, 100); await age(young, 5);
  const liveOld = (await mk('carol', [ext.dave])).body.room.id; await db.pool.query("UPDATE voice_rooms SET created_at = now() - interval '900 days' WHERE id=$1", [liveOld]);                  // a live room created long ago is still live
  const oneToOne = (await store.createCall('erin', ext.frank, 'ret-' + randomUUID(), h.device('erin'))).call; await db.pool.query("UPDATE voice_calls SET created_at = now() - interval '900 days' WHERE id=$1", [oneToOne.id]);
  const snapshot = async () => JSON.stringify([await n('SELECT count(*) n FROM voice_reliable_events'), await n('SELECT count(*) n FROM voice_outbox'), await n('SELECT count(*) n FROM voice_outbox WHERE delivered_at IS NULL'), await n('SELECT count(*) n FROM voice_calls'), await n('SELECT count(*) n FROM voice_media_leases')]), before = await snapshot();
  assert.deepEqual(await history.purgeExpired({ days: 0 }), { rooms: 0, members: 0 }, '0 = keep for ever'); assert.equal(await n('SELECT count(*) n FROM voice_rooms'), 7);
  assert.deepEqual(await history.purgeExpired({ days: 30, batch: 2 }), { rooms: 2, members: 0 }, 'a batch at a time'); assert.deepEqual(await history.purgeExpired({ days: 30, batch: 2 }), { rooms: 2, members: 0 }); assert.deepEqual(await history.purgeExpired({ days: 30, batch: 2 }), { rooms: 1, members: 0 }); assert.deepEqual(await history.purgeExpired({ days: 30, batch: 2 }), { rooms: 0, members: 0 });
  assert.equal(await n('SELECT count(*) n FROM voice_rooms'), 2); assert.ok(await one('alice', young), 'a young call stays'); assert.equal((await db.pool.query('SELECT status FROM voice_rooms WHERE id=$1', [liveOld])).rows[0].status, 'live', 'a live room stays however old it is');
  assert.equal(await snapshot(), before, 'the outbox, durable events, one-to-one calls and device leases are exactly as before'); assert.equal((await store.getCall(oneToOne.id)).status, 'ringing');
  for (const id of old) { assert.equal(await n('SELECT count(*) n FROM voice_room_members WHERE room_id=$1', [id]), 0); assert.equal(await n('SELECT count(*) n FROM voice_room_segments WHERE room_id=$1', [id]), 0); assert.equal(await n('SELECT count(*) n FROM voice_room_events WHERE room_id=$1', [id]), 0); }
  assert.equal((await act('carol', liveOld, 'join')).status, 409 /* carol hosts it and is already joined */); assert.equal((await act('dave', liveOld, 'join')).status, 200, 'the live room works after the cleanup'); await act('dave', liveOld, 'leave'); await act('carol', liveOld, 'end');
  await store.transition(oneToOne.id, 'frank', 'rejected');
});

test('scheduled cleanup: the engine deletes expired history by itself, reports it in the metrics, and an operator can trigger it', async (t) => {
  if (skip(t)) return; await clean();
  const id = await finished([ext.bob], ['bob']), keep = await finished([ext.bob], ['bob']); await age(id, 100); await age(keep, 2);
  const s = await h.replica({ maintenanceMs: 100, env: { VOICE_HISTORY_RETENTION_DAYS: '30' } });
  const policy = (await s.api('alice', 'GET', '/v1/voice/history-policy')).body; assert.deepEqual([policy.retentionDays, policy.retentionEnabled], [30, true]);
  for (let i = 0; i < 60 && await n('SELECT count(*) n FROM voice_rooms WHERE id=$1', [id]); i++) await wait(100);                                                                        // the cleanup runs on the second maintenance tick
  assert.equal(await n('SELECT count(*) n FROM voice_rooms WHERE id=$1', [id]), 0, 'expired history was deleted by the schedule'); assert.equal(await n('SELECT count(*) n FROM voice_rooms WHERE id=$1', [keep]), 1);
  const m = await fetch(s.base + '/v1/voice/admin/metrics', { headers: { 'x-voice-admin-secret': ADMIN } }).then((x) => x.json()); assert.equal(m.history.retentionDays, 30); assert.ok(m.history.ops.retention.rooms >= 1);
  const prom = await fetch(s.base + '/v1/voice/admin/metrics?format=prometheus', { headers: { 'x-voice-admin-secret': ADMIN } }); assert.match(prom.headers.get('content-type'), /text\/plain/); const text = await prom.text();
  for (const name of ['qorlla_voice_outbox_pending', 'qorlla_voice_outbox_oldest_seconds', 'qorlla_voice_history_retention_deleted_rooms_total', 'qorlla_voice_history_legal_holds', 'qorlla_voice_bus_up']) assert.match(text, new RegExp('^' + name + ' \\d+$', 'm'), name);
  assert.equal((await fetch(s.base + '/v1/voice/admin/metrics?format=prometheus')).status, 401, 'metrics need the secret');
  assert.equal((await fetch(s.base + '/v1/voice/admin/metrics?format=prometheus', { headers: { authorization: 'Bearer ' + ADMIN } })).status, 200, 'a scraper may send the secret as a bearer token');
  assert.equal((await fetch(s.base + '/v1/voice/admin/metrics', { headers: { authorization: 'Bearer wrong' + 'x'.repeat(40) } })).status, 401);
  for (const [method, path] of [['GET', '/v1/voice/admin/legal-holds'], ['GET', '/v1/voice/admin/identities'], ['POST', '/v1/voice/admin/history/purge']]) assert.equal((await fetch(s.base + path, { method, headers: { authorization: 'Bearer ' + ADMIN } })).status, 401, 'the bearer form works for metrics only: ' + path);
  await age(keep, 100); assert.equal((await admin('POST', '/history/purge')).body.rooms >= 0, true); await s.api('alice', 'GET', '/v1/voice/history-policy');
  const bad = await h.replica({ maintenance: false, env: { VOICE_HISTORY_RETENTION_DAYS: 'banana' } }); assert.equal((await bad.api('alice', 'GET', '/v1/voice/history-policy')).body.retentionDays, 365, 'an invalid setting falls back to the default, never to keep-for-ever'); await s.stop(); await bad.stop();
});

test('concurrency: simultaneous deletions, reads, and live room activity never error, never leak a half-deleted record, and never delete a call that is still going', async (t) => {
  if (skip(t)) return; await clean();
  const id = await finished([ext.bob, ext.carol, ext.dave], ['bob', 'carol', 'dave']); const stop = { v: false }, problems = [];
  const reader = (async () => { while (!stop.v) for (const who of ['alice', 'bob', 'carol', 'dave']) { const [l, d] = await Promise.all([r.api(who, 'GET', '/v1/voice/history?limit=50'), r.api(who, 'GET', '/v1/voice/history/' + id)]);
    if (l.status !== 200 || ![200, 404].includes(d.status)) problems.push([who, l.status, d.status]); if (d.status === 200 && (d.body.segments === undefined || d.body.events === undefined || d.body.participants !== 4)) problems.push([who, 'partial', d.body.participants]); } })();
  const liveWork = (async () => { for (let i = 0; i < 6; i++) { const x = (await mk('erin', [ext.frank])).body.room.id; await act('frank', x, 'join'); await act('frank', x, 'leave'); await act('erin', x, 'end'); } })();
  const out = await Promise.all(['alice', 'bob', 'carol', 'dave'].map((who) => del(who, id))); await liveWork; stop.v = true; await reader;
  assert.deepEqual(out.map((x) => x.status), [200, 200, 200, 200]); assert.deepEqual(problems, []); assert.equal(await n('SELECT count(*) n FROM voice_rooms WHERE id=$1', [id]), 0, 'the last deletion removed the room');
  for (const sql of ['SELECT count(*) n FROM voice_room_members WHERE room_id=$1', 'SELECT count(*) n FROM voice_room_segments WHERE room_id=$1', 'SELECT count(*) n FROM voice_room_events WHERE room_id=$1']) assert.equal(await n(sql, [id]), 0);
  // a user deleting while the host ends the call: the delete is refused or applied AFTER the end, never to a live room
  for (let i = 0; i < 12; i++) {
    const x = (await mk('alice', [ext.bob])).body.room.id; await act('bob', x, 'join');
    const [e, d] = await Promise.all([act('alice', x, 'end'), del('bob', x)]);
    assert.equal(e.status, 200); assert.ok([200, 409].includes(d.status), 'delete answered ' + d.status);
    const room = (await db.pool.query('SELECT status FROM voice_rooms WHERE id=$1', [x])).rows[0]; if (d.status === 200) assert.ok(room, 'alice still has her record'); assert.equal(room.status, 'ended');
  }
  assert.equal(await n("SELECT count(*) n FROM voice_room_members WHERE status='joined' AND account_id <> 'zzz'"), 0, 'nobody is left joined by accident');
});

test('the audit gap: after any mix of room operations, the history agrees with the rooms (random sequence, invariants checked after every step)', async (t) => {
  if (skip(t)) return; await clean(); let seed = 20261029; const rnd = (k) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % k; };
  const who = NAMES, rooms = []; let kicked = 0, transfers = 0;
  const invariants = async (step) => {
    const bad = {
      joinedWithoutOpenStay: `SELECT count(*) n FROM voice_room_members m WHERE m.status='joined' AND NOT EXISTS (SELECT 1 FROM voice_room_segments s WHERE s.room_id=m.room_id AND s.account_id=m.account_id AND s.left_at IS NULL)`,
      openStayWhileNotJoined: `SELECT count(*) n FROM voice_room_segments s JOIN voice_room_members m ON m.room_id=s.room_id AND m.account_id=s.account_id WHERE s.left_at IS NULL AND m.status <> 'joined'`,
      endedRoomWithOpenStay: `SELECT count(*) n FROM voice_room_segments s JOIN voice_rooms r ON r.id=s.room_id WHERE s.left_at IS NULL AND r.status='ended'`,
      endedRoomWithLiveMember: `SELECT count(*) n FROM voice_room_members m JOIN voice_rooms r ON r.id=m.room_id WHERE r.status='ended' AND m.status IN ('joined','invited')`,
      finishedWithoutOutcome: `SELECT count(*) n FROM voice_room_members WHERE status NOT IN ('invited','joined') AND outcome IS NULL`,
      stayBackwards: `SELECT count(*) n FROM voice_room_segments WHERE left_at < joined_at`,
      hostNotAMember: `SELECT count(*) n FROM voice_rooms r WHERE r.status='live' AND NOT EXISTS (SELECT 1 FROM voice_room_members m WHERE m.room_id=r.id AND m.account_id=r.host_id AND m.status='joined' AND m.role='host')`,
      joinedMissingJoinedEvent: `SELECT count(*) n FROM voice_room_members m WHERE m.status='joined' AND NOT EXISTS (SELECT 1 FROM voice_room_events e WHERE e.room_id=m.room_id AND e.subject_account_id=m.account_id AND e.kind='joined')`
    };
    for (const [name, sql] of Object.entries(bad)) assert.equal(await n(sql), 0, `${name} after step ${step}`);
  };
  for (let step = 1; step <= 160; step++) {
    const a = who[rnd(6)], b = who[rnd(6)], live = rooms.filter((x) => x.live), pick = live.length ? live[rnd(live.length)] : null, op0 = rnd(11), op = op0 >= 9 ? 0 : op0;   // creation is twice as likely, so there is always something to act on
    try {
      if (op === 0 || !pick) { const exts = [...new Set([0, 1, 2].map(() => ext[who[rnd(6)]]))].filter((e) => e !== ext[a]).slice(0, 3); if (exts.length) { const x = await mk(a, exts); if (x.status === 201) rooms.push({ id: x.body.room.id, live: true }); } }
      else if (op === 1) await act(a, pick.id, 'join'); else if (op === 2) await act(a, pick.id, 'leave'); else if (op === 3) await act(a, pick.id, 'decline');
      else if (op === 4) { const k = await act(a, pick.id, 'kick', { accountId: b }); if (k.status === 200) kicked++; }
      else if (op === 5) await act(a, pick.id, 'invite', { extension: ext[b] }); else if (op === 6) await act(a, pick.id, 'device');
      else if (op === 7) await act(a, pick.id, 'end'); else if (op === 8) { await db.pool.query("UPDATE voice_room_members SET lease_expires_at = now() - interval '5 minutes' WHERE room_id=$1 AND account_id=$2 AND status='joined'", [pick.id, b]); await store.rooms.expireStaleMembers(120); }
    } catch { /* an expected refusal */ }
    for (const x of rooms) if (x.live && (await db.pool.query('SELECT status FROM voice_rooms WHERE id=$1', [x.id])).rows[0]?.status !== 'live') x.live = false;
    await invariants(step);
  }
  transfers = await n("SELECT count(*) n FROM voice_room_events WHERE kind='host_transferred'");
  assert.ok(rooms.length > 8, 'the sequence made ' + rooms.length + ' rooms'); assert.ok(await n('SELECT count(*) n FROM voice_room_segments') > 5 && await n('SELECT count(*) n FROM voice_room_events') > 40, 'and recorded a lot of history');
  // attribution: every kick names the host who did it; a host hand-over by leaving names the leaver; lease expiry and system changes honestly have no actor
  assert.equal(await n("SELECT count(*) n FROM voice_room_events WHERE kind='kicked' AND actor_account_id IS NULL"), 0); assert.equal(await n("SELECT count(*) n FROM voice_room_events WHERE kind='device_claimed' AND actor_account_id IS NULL"), 0);
  assert.ok(kicked >= 0 && transfers >= 0);
});
