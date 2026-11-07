// Subscription enforcement in the REAL Meet server (server/index.js as a child process) against real PostgreSQL databases:
// atomic admission under concurrent joins, reconnects, duration enforced across reconnects/restarts, downgrades, suspension,
// anonymous meetings, bridge entitlements, fail-closed behaviour and the rollout switch.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createMeetDb, startMeet, http, connectSocket, sourceId, sleep, skip } from './helpers/meet-harness.mjs';
import { createTestDb, newCustomer, seedSubscription } from '../../qorlla-subscription-access/tests/helpers/db.js';

const until = async (fn, ms = 8000, step = 50) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); } return null; };

describe('Meet subscription enforcement (real server, PostgreSQL)', { skip }, () => {
  let sub, meet, server, h, extra = [];
  const enforceEnv = (o = {}) => ({ SUBSCRIPTION_ENFORCEMENT: 'enforce', SUBSCRIPTION_DATABASE_URL: sub.url('runtime'), SUBSCRIPTION_SWEEP_MS: '300', ...o });
  before(async () => {
    sub = await createTestDb(); meet = await createMeetDb();
    server = await startMeet({ meetUrl: meet.url, env: enforceEnv() }); assert.ok(server.up, server.logs.join('').slice(-600)); h = http(server.base);
  });
  after(async () => { for (const s of [server, ...extra]) await s?.stop(); await meet.drop(); await sub.drop(); });

  // ---- fixtures ---------------------------------------------------------------------------------------------------------------
  const override = (customerId, feature, value) => sub.owner.query(
    `INSERT INTO entitlement_overrides (customer_id, feature_key, value, reason, created_by, expires_at) VALUES ($1,$2,$3,'test limit','t', now() + interval '1 day')
     ON CONFLICT (customer_id, feature_key) DO UPDATE SET value = EXCLUDED.value`, [customerId, feature, JSON.stringify(value)]);
  /** A customer, a scheduled meeting for it (through the bridge), and the host's token. */
  async function owned({ plan = 'basic', overrides = {}, api = h } = {}) {
    const customerId = newCustomer(); await seedSubscription(sub.owner, customerId, { plan });
    for (const [f, v] of Object.entries(overrides)) await override(customerId, f, v);
    const b = await api.bridge({ sourceId: sourceId(), title: 'Board meeting', ownerName: 'Owner', customerId });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    const hj = await api.join(b.body.meetingId, 'Host', b.body.hostSecret);
    assert.equal(hj.status, 200, JSON.stringify(hj.body));
    return { customerId, meetingId: b.body.meetingId, hostSecret: b.body.hostSecret, hostToken: hj.body.token, hostPid: hj.body.participantId };
  }
  const row = async (id) => (await meet.pool.query(`SELECT *, EXTRACT(EPOCH FROM (deadline_at - started_at)) / 60 AS minutes FROM meetings WHERE id=$1`, [id])).rows[0];
  const seats = async (id) => Number((await meet.pool.query(`SELECT count(*) AS n FROM participants WHERE meeting_id=$1`, [id])).rows[0].n);

  // ---- 1. atomic admission ------------------------------------------------------------------------------------------------------
  test('ATOMIC ADMISSION: 30 simultaneous joins for a meeting with 4 free seats admit exactly 4 - repeated over 6 meetings', async () => {
    for (let round = 0; round < 6; round++) {
      const m = await owned({ overrides: { 'meetings.participants': 5 } });             // the host holds seat 1
      const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => h.join(m.meetingId, 'Guest ' + i)));
      const ok = rs.filter((r) => r.status === 200).length, full = rs.filter((r) => r.status === 403 && r.body.error === 'Meeting is full').length;
      assert.equal(ok, 4, `round ${round}: admitted ${ok}`);
      assert.equal(full, 26, `round ${round}: refused ${full}`);
      assert.equal(await seats(m.meetingId), 5, 'the database never holds more than the limit');
    }
  });

  test('the host is always admitted, even when the meeting is full (and is counted)', async () => {
    const m = await owned({ overrides: { 'meetings.participants': 2 } });
    assert.equal((await h.join(m.meetingId, 'G1')).status, 200);
    assert.equal((await h.join(m.meetingId, 'G2')).status, 403, 'full');
    assert.equal((await h.join(m.meetingId, 'Host again', m.hostSecret)).status, 200, 'the host is not locked out of their own meeting');
    assert.equal(await seats(m.meetingId), 3);
  });

  test('RECONNECT: leaving frees the seat; coming back needs a seat again, decided atomically', async () => {
    const m = await owned({ overrides: { 'meetings.participants': 3 } });
    const g1 = (await h.join(m.meetingId, 'G1')).body, g2 = (await h.join(m.meetingId, 'G2')).body;
    const host = await connectSocket(server.base, m.hostToken), s1 = await connectSocket(server.base, g1.token), s2 = await connectSocket(server.base, g2.token);
    assert.ok(host.socket && s1.socket && s2.socket, 'all three connect');
    s2.socket.close();
    assert.ok(await until(async () => (await meet.pool.query('SELECT left_at FROM participants WHERE id=$1', [g2.participantId])).rows[0].left_at), 3000, 'the disconnect released the seat');
    const g3 = await h.join(m.meetingId, 'G3'); assert.equal(g3.status, 200, 'the freed seat can be taken');
    const back = await connectSocket(server.base, g2.token);
    assert.equal(back.error, 'Meeting is full', 'G2 left, someone else took the seat: returning is refused');
    s1.socket.close();
    await until(async () => (await meet.pool.query('SELECT left_at FROM participants WHERE id=$1', [g1.participantId])).rows[0].left_at, 3000);
    const back2 = await connectSocket(server.base, g2.token);
    assert.ok(back2.socket, 'a seat is free again, so G2 is re-admitted');
    for (const s of [host, back2]) s.socket?.close();
  });

  test('two clients racing to re-enter through ONE free seat: exactly one wins', async () => {
    const m = await owned({ overrides: { 'meetings.participants': 3 } });
    const gs = []; for (let i = 0; i < 2; i++) gs.push((await h.join(m.meetingId, 'G' + i)).body);
    const socks = await Promise.all(gs.map((g) => connectSocket(server.base, g.token))); socks.forEach((s) => s.socket?.close());
    await until(async () => Number((await meet.pool.query('SELECT count(*) AS n FROM participants WHERE meeting_id=$1 AND left_at IS NULL', [m.meetingId])).rows[0].n) === 1, 4000);   // only the host remains
    const extraGuests = []; for (let i = 0; i < 1; i++) extraGuests.push((await h.join(m.meetingId, 'X' + i)).body);          // seats: host + X0 = 2 of 3
    const results = await Promise.all(gs.map((g) => connectSocket(server.base, g.token)));
    assert.equal(results.filter((r) => r.socket).length, 1, 'one seat, two claimants, one admitted');
    assert.equal(results.filter((r) => r.error === 'Meeting is full').length, 1);
    results.forEach((r) => r.socket?.close());
  });

  test('joins whose socket never connects stop holding a seat after the grace period (no phantom-seat denial of service)', async () => {
    const m = await owned({ overrides: { 'meetings.participants': 3 } });
    for (let i = 0; i < 2; i++) assert.equal((await h.join(m.meetingId, 'ghost' + i)).status, 200);
    assert.equal((await h.join(m.meetingId, 'late')).status, 403, 'two fresh joins hold their seats');
    await meet.pool.query(`UPDATE participants SET joined_at = now() - interval '2 minutes' WHERE meeting_id=$1 AND role='guest'`, [m.meetingId]);
    assert.equal((await h.join(m.meetingId, 'late')).status, 200, 'abandoned joins no longer count');
  });

  // ---- 2. duration ----------------------------------------------------------------------------------------------------------------
  test('the DEADLINE is fixed at first admission from the plan: basic 40, pro 1800, business unlimited, an override wins, anonymous 40', async () => {
    const expect = async (m, minutes) => { const r = await row(m.meetingId); assert.ok(r.started_at); if (minutes === null) assert.equal(r.deadline_at, null); else assert.equal(Math.round(r.minutes), minutes); };
    await expect(await owned({ plan: 'basic' }), 40);
    await expect(await owned({ plan: 'pro' }), 1800);
    await expect(await owned({ plan: 'business' }), null);
    await expect(await owned({ plan: 'basic', overrides: { 'meetings.duration_minutes': 90 } }), 90);
    const anon = await h.anonymous(); const r = await row(anon.body.meetingId);
    assert.equal(Math.round(r.minutes), 40); assert.equal(r.customer_id, null);
  });

  test('the deadline cannot be extended by re-joining, a new host session, an upgrade, or any number of reconnects', async () => {
    const m = await owned({ plan: 'basic' });
    const before = (await row(m.meetingId)).deadline_at.toISOString();
    await h.join(m.meetingId, 'Host again', m.hostSecret);                              // a second host session ("host transfer")
    for (let i = 0; i < 3; i++) { const c = await connectSocket(server.base, m.hostToken); c.socket?.close(); await sleep(60); }
    await sub.owner.query(`UPDATE subscriptions SET plan_code='enterprise' WHERE customer_id=$1`, [m.customerId]);                    // upgraded mid-meeting
    await h.join(m.meetingId, 'Latecomer');
    assert.equal((await row(m.meetingId)).deadline_at.toISOString(), before, 'unchanged');
  });

  test('when the deadline passes the SERVER ends the meeting: sockets are told and dropped, joins/reconnects/requests are refused', async () => {
    const m = await owned({ plan: 'basic' });
    const guest = (await h.join(m.meetingId, 'G')).body;
    const hs = await connectSocket(server.base, m.hostToken), gs = await connectSocket(server.base, guest.token);
    assert.ok(hs.socket && gs.socket);
    assert.equal((await h.get(m.meetingId, m.hostToken)).status, 200);
    await meet.pool.query(`UPDATE meetings SET deadline_at = now() - interval '1 second' WHERE id=$1`, [m.meetingId]);
    assert.ok(await until(async () => (await row(m.meetingId)).ended_at, 4000), 'the sweeper ended it');
    const r = await row(m.meetingId); assert.equal(r.end_reason, 'time_limit');
    assert.ok(await until(() => hs.events.find((e) => e[0] === 'meeting-ended'), 3000), 'the host was told');
    assert.deepEqual(hs.events.find((e) => e[0] === 'meeting-ended')[1], { reason: 'time_limit' });
    assert.ok(await until(() => gs.socket.disconnected, 3000), 'and dropped');
    assert.ok([403, 404].includes((await h.join(m.meetingId, 'Late')).status), 'no new joins');
    assert.ok([403, 404].includes((await h.join(m.meetingId, 'Host', m.hostSecret)).status), 'not even the host rejoins');
    assert.ok((await connectSocket(server.base, m.hostToken)).error, 'no reconnect');
    assert.equal((await h.get(m.meetingId, m.hostToken)).status, 403, 'no authenticated requests');
  });

  test('"ending soon" is announced once, five minutes out', async () => {
    const m = await owned({ plan: 'basic' });
    const hs = await connectSocket(server.base, m.hostToken);
    await meet.pool.query(`UPDATE meetings SET deadline_at = now() + interval '4 minutes' WHERE id=$1`, [m.meetingId]);
    const note = await until(() => hs.events.find((e) => e[0] === 'meeting-ending-soon'), 4000);
    assert.ok(note && note[1].secondsLeft <= 240 && note[1].secondsLeft > 200);
    await sleep(900);
    assert.equal(hs.events.filter((e) => e[0] === 'meeting-ending-soon').length, 1);
    assert.ok((await row(m.meetingId)).warned_at);
    hs.socket.close();
  });

  // ---- 3. downgrades and suspension ----------------------------------------------------------------------------------------------
  test('DOWNGRADE applies to the next join: people already in stay, new ones are held to the new limit; an upgrade opens seats', async () => {
    const m = await owned({ overrides: { 'meetings.participants': 3 } });
    const g = (await h.join(m.meetingId, 'G1')).body; await h.join(m.meetingId, 'G2');
    const gs = await connectSocket(server.base, g.token);
    await override(m.customerId, 'meetings.participants', 2);
    assert.equal((await h.join(m.meetingId, 'G3')).status, 403, 'new joins see the lower limit');
    assert.equal(gs.socket.connected, true, 'the running session is untouched');
    await override(m.customerId, 'meetings.participants', 10);
    assert.equal((await h.join(m.meetingId, 'G3')).status, 200, 'an upgrade is honoured at once');
    gs.socket.close();
  });

  test('a lapsed subscription (paused) falls back to the free plan\'s limits; it does not block free meetings', async () => {
    const customerId = newCustomer(); await seedSubscription(sub.owner, customerId, { plan: 'business', status: 'paused' });
    const b = await h.bridge({ sourceId: sourceId(), title: 'Lapsed', ownerName: 'O', customerId });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(Math.round((await (async () => { await h.join(b.body.meetingId, 'H', b.body.hostSecret); return row(b.body.meetingId); })()).minutes), 40, 'free-plan duration');
    const webinar = await h.bridge({ sourceId: sourceId(), title: 'Webinar', ownerName: 'O', customerId, webinar: true });
    assert.equal(webinar.status, 402, 'paid features are refused with 402');
  });

  test('SUSPENSION: a suspended customer cannot join, and their running meetings are ended by the server', async () => {
    const m = await owned({ plan: 'pro' });
    const g = (await h.join(m.meetingId, 'G')).body;
    const hs = await connectSocket(server.base, m.hostToken), gs = await connectSocket(server.base, g.token);
    await sub.owner.query(`INSERT INTO customers (id, name, created_by, status) VALUES ($1,'Suspended Co','t','suspended')`, [m.customerId]);
    assert.ok(await until(async () => (await row(m.meetingId)).ended_at, 4000), 'the sweeper ended it');
    assert.equal((await row(m.meetingId)).end_reason, 'account_suspended');
    assert.deepEqual((await until(() => hs.events.find((e) => e[0] === 'meeting-ended'), 3000))[1], { reason: 'account_suspended' });
    assert.ok(await until(() => gs.socket.disconnected, 3000));
    const m2 = await owned({ plan: 'pro' });
    await sub.owner.query(`INSERT INTO customers (id, name, created_by, status) VALUES ($1,'Also suspended','t','suspended')`, [m2.customerId]);
    await sleep(0);
    const r = await h.join(m2.meetingId, 'Guest');
    assert.ok([403, 404].includes(r.status), 'no new joins: ' + JSON.stringify(r.body));
    await sub.owner.query(`UPDATE customers SET status='active' WHERE id=$1`, [m.customerId]);
    assert.equal((await owned({ plan: 'pro' })).hostToken.length > 10, true, 'other customers are unaffected');
  });

  // ---- 4. anonymous ---------------------------------------------------------------------------------------------------------------
  test('ANONYMOUS meetings get the free plan: 100 seats (one host + 99) under 110 simultaneous joins, and a 40 minute deadline', async () => {
    const a = await h.anonymous('Open house', 'Host');
    const rs = await Promise.all(Array.from({ length: 110 }, (_, i) => h.join(a.body.meetingId, 'Guest ' + i)));
    assert.equal(rs.filter((r) => r.status === 200).length, 99);
    assert.equal(rs.filter((r) => r.status === 403).length, 11);
    assert.equal(await seats(a.body.meetingId), 100);
    assert.equal(Math.round((await row(a.body.meetingId)).minutes), 40);
  });

  // ---- 5. bridge ------------------------------------------------------------------------------------------------------------------
  test('BRIDGE: the customer is mandatory and strictly validated; the plan gates webinar/recording/breakout rooms and the counts; flags are stored', async () => {
    const basic = newCustomer(), pro = newCustomer(), biz = newCustomer();
    await seedSubscription(sub.owner, basic, { plan: 'basic' }); await seedSubscription(sub.owner, pro, { plan: 'pro' }); await seedSubscription(sub.owner, biz, { plan: 'business' });
    const req = (customerId, extra = {}) => h.bridge({ sourceId: sourceId(), title: 'T', ownerName: 'O', ...(customerId === undefined ? {} : { customerId }), ...extra });
    assert.equal((await req(undefined)).status, 400, 'no customer');
    assert.equal((await req('not-a-uuid')).status, 400);
    assert.equal((await req(basic, { recording: true })).status, 403, 'recording needs pro');
    assert.equal((await req(basic, { breakoutRooms: true })).status, 403);
    assert.equal((await req(pro, { webinar: true })).status, 403, 'webinar needs business');
    assert.equal((await req(basic, { maxParticipants: 101 })).status, 403);
    assert.equal((await req(biz, { maxParticipants: 300 })).status, 201);
    for (const bad of ['100', 0, -1, 1.5, null, true, 1e999]) assert.equal((await req(biz, { maxParticipants: bad })).status, 400, 'maxParticipants ' + String(bad));
    const ok = await req(pro, { recording: true, breakoutRooms: true });
    assert.equal(ok.status, 201);
    const stored = (await row(ok.body.meetingId));
    assert.deepEqual([stored.customer_id, stored.entitled_features], [pro, { recording: true, webinar: false, breakoutRooms: true }]);
  });

  test('BRIDGE: a retry of an already-registered schedule is idempotent even if the customer has since lapsed or been suspended', async () => {
    const customerId = newCustomer(); await seedSubscription(sub.owner, customerId, { plan: 'pro' });
    const body = { sourceId: sourceId(), title: 'Weekly', ownerName: 'O', customerId, recording: true, maxParticipants: 100 };       // pro: allowed once
    const first = await h.bridge(body); assert.equal(first.status, 201);
    await sub.owner.query(`UPDATE subscriptions SET status='canceled' WHERE customer_id=$1`, [customerId]);
    assert.equal((await h.bridge({ ...body, sourceId: sourceId() })).status, 402, 'a NEW schedule with the same request is refused now (the customer lapsed)');
    const again = await h.bridge(body);
    assert.equal(again.status, 200); assert.equal(again.body.created, false); assert.equal(again.body.meetingId, first.body.meetingId);
  });

  // ---- 6. failure modes and the switch ------------------------------------------------------------------------------------------
  test('FAIL CLOSED: with the entitlement database unreachable, owned joins, reconnects and bridge creates are refused (503); nothing is allowed through', async () => {
    const m = await owned({ overrides: { 'meetings.participants': 5 } });
    const g = (await h.join(m.meetingId, 'G')).body; const gs = await connectSocket(server.base, g.token); gs.socket.close();
    await until(async () => (await meet.pool.query('SELECT left_at FROM participants WHERE id=$1', [g.participantId])).rows[0].left_at, 3000);
    const broken = await startMeet({ meetUrl: meet.url, env: enforceEnv({ SUBSCRIPTION_DATABASE_URL: 'postgres://nobody:x@127.0.0.1:1/none' }) }); extra.push(broken);
    assert.ok(broken.up); const bh = http(broken.base);
    assert.equal((await bh.join(m.meetingId, 'Guest')).status, 503);
    assert.equal((await bh.join(m.meetingId, 'Host', m.hostSecret)).status, 503, 'even the host: the deadline cannot be decided');
    assert.equal((await connectSocket(broken.base, g.token)).error, 'Entitlement check unavailable', 'a returning participant needs a seat decision');
    assert.equal((await bh.bridge({ sourceId: sourceId(), title: 'T', ownerName: 'O', customerId: m.customerId })).status, 503);
    assert.equal((await bh.anonymous()).status, 201, 'anonymous meetings use the built-in free plan and need no database');
    assert.doesNotMatch(broken.logs.join('') && (await bh.join(m.meetingId, 'X')).body.error, /ECONNREFUSED|postgres|127\.0\.0\.1/);
    await broken.stop();
  });

  test('refuses to start in enforce mode without an entitlement database (it will not silently run unenforced)', async () => {
    const s = await startMeet({ meetUrl: meet.url, env: { SUBSCRIPTION_ENFORCEMENT: 'enforce', SUBSCRIPTION_DATABASE_URL: '' } });
    assert.equal(s.up, false); assert.notEqual(await Promise.race([s.exited, sleep(3000).then(() => 'still running')]), 'still running');
    assert.match(s.logs.join(''), /SUBSCRIPTION_DATABASE_URL/);
  });

  test('LOG mode decides and records but never blocks - the safe first step of a rollout', async () => {
    const logm = await startMeet({ meetUrl: meet.url, env: enforceEnv({ SUBSCRIPTION_ENFORCEMENT: 'log' }) }); extra.push(logm);
    assert.ok(logm.up); const lh = http(logm.base);
    const customerId = newCustomer(); await seedSubscription(sub.owner, customerId, { plan: 'basic' }); await override(customerId, 'meetings.participants', 2);
    const b = await lh.bridge({ sourceId: sourceId(), title: 'T', ownerName: 'O', customerId, recording: true });          // basic has no recording
    assert.equal(b.status, 201, 'allowed in log mode');
    assert.equal((await row(b.body.meetingId)).customer_id, customerId, 'the customer is recorded even though the guard said "would refuse"');
    const noCustomer = await lh.bridge({ sourceId: sourceId(), title: 'T', ownerName: 'O' });
    assert.equal(noCustomer.status, 201, 'a caller that does not send customerId yet still works');
    const hj = await lh.join(b.body.meetingId, 'H', b.body.hostSecret); assert.equal(hj.status, 200);
    for (let i = 0; i < 4; i++) assert.equal((await lh.join(b.body.meetingId, 'G' + i)).status, 200, 'over the limit, still allowed');
    await sleep(300);
    const text = logm.logs.join('');
    assert.match(text, /would_refuse_bridge_create/); assert.match(text, /"why":"meeting_full"/, 'the over-limit joins were reported as would-be refusals');
    assert.equal((await row(b.body.meetingId)).deadline_at, null, 'and no deadline is enforced');
    await logm.stop();
  });

  test('OFF (the default) leaves Meet exactly as it was, even on a database that does not have the new columns', async () => {
    const old = await createMeetDb(); await old.pool.query('ALTER TABLE meetings DROP COLUMN customer_id, DROP COLUMN entitled_features, DROP COLUMN started_at, DROP COLUMN deadline_at, DROP COLUMN warned_at, DROP COLUMN end_reason'); await old.pool.query('ALTER TABLE participants DROP COLUMN connected_at');
    const off = await startMeet({ meetUrl: old.url, env: {} }); extra.push(off);
    try {
      assert.ok(off.up, off.logs.join('').slice(-500)); const oh = http(off.base);
      const a = await oh.anonymous(); assert.equal(a.status, 201);
      const rs = await Promise.all(Array.from({ length: 150 }, (_, i) => oh.join(a.body.meetingId, 'G' + i)));
      assert.equal(rs.filter((r) => r.status === 200).length, 150, 'no cap, as before');
      const b = await oh.bridge({ sourceId: sourceId(), title: 'T', ownerName: 'O' }); assert.equal(b.status, 201, 'no customerId needed');
      const s = await connectSocket(off.base, a.body.token); assert.ok(s.socket); s.socket.close();
    } finally { await off.stop(); await old.drop(); }
  });

  test('RESTART: a meeting whose deadline passed while the server was down is ended at start-up; one that has time left is ended on time by the timer alone', async () => {
    const past = await owned({ plan: 'basic' }), future = await owned({ plan: 'basic' }), quiet = await owned({ plan: 'basic' });
    const f = await connectSocket(server.base, future.hostToken); f.socket.close();
    await server.stop();
    await meet.pool.query(`UPDATE meetings SET deadline_at = now() - interval '5 minutes' WHERE id=$1`, [past.meetingId]);
    await meet.pool.query(`UPDATE meetings SET deadline_at = now() + interval '9 seconds' WHERE id=$1`, [future.meetingId]);
    await meet.pool.query(`UPDATE meetings SET deadline_at = now() + interval '6 seconds' WHERE id=$1`, [quiet.meetingId]);
    server = await startMeet({ meetUrl: meet.url, env: enforceEnv({ SUBSCRIPTION_SWEEP_MS: '3600000' }) }); h = http(server.base);      // the sweeper will not tick again for an hour
    assert.ok(server.up);
    assert.ok(await until(async () => (await row(past.meetingId)).ended_at, 2000), 'ended at start-up');
    assert.equal((await row(past.meetingId)).end_reason, 'time_limit');
    const c = await connectSocket(server.base, future.hostToken);
    assert.ok(c.socket, 'still running after the restart');
    assert.ok(await until(() => c.events.find((e) => e[0] === 'meeting-ended'), 14000), 'the TIMER ended it (no sweeper)');
    assert.ok((await row(future.meetingId)).ended_at);
    assert.ok(await until(async () => (await row(quiet.meetingId)).ended_at, 8000), 'a meeting nobody reconnects to is ended by the start-up timer alone (sweeper off, no request, no socket)');
    assert.equal((await row(quiet.meetingId)).end_reason, 'time_limit');
    await server.stop();
    server = await startMeet({ meetUrl: meet.url, env: enforceEnv() }); h = http(server.base);                                          // back to the normal fast sweeper
  });

  test('RESTART: seats are released and every client re-enters through admission, so the limit holds across a restart', async () => {
    const m = await owned({ overrides: { 'meetings.participants': 3 } });
    const g = [(await h.join(m.meetingId, 'A')).body, (await h.join(m.meetingId, 'B')).body];
    const conns = await Promise.all([m.hostToken, g[0].token, g[1].token].map((t) => connectSocket(server.base, t)));
    assert.ok(conns.every((c) => c.socket));
    await server.stop();
    server = await startMeet({ meetUrl: meet.url, env: enforceEnv() }); h = http(server.base);
    assert.equal((await meet.pool.query('SELECT count(*)::int AS n FROM participants WHERE meeting_id=$1 AND left_at IS NULL', [m.meetingId])).rows[0].n, 0, 'no stale seats');
    const intruder = (await h.join(m.meetingId, 'Intruder')).body;                       // joins in the window before the others reconnect (seat count restarts at 0)
    const back = await Promise.all([m.hostToken, g[0].token, g[1].token, intruder.token].map((t) => connectSocket(server.base, t)));
    assert.equal(back.filter((c) => c.socket).length, 3, 'three seats: host + two of the three guests');
    assert.equal(back.filter((c) => c.error === 'Meeting is full').length, 1);
    back.forEach((c) => c.socket?.close());
  });
  test('OVERDUE ON THE REQUEST PATH: with the sweeper not running at all, a join, a reconnect and an authenticated request each see that the meeting is over', async () => {
    const mdb = await createMeetDb(); const rowOn = async (id) => (await mdb.pool.query('SELECT * FROM meetings WHERE id=$1', [id])).rows[0];
    const slow = await startMeet({ meetUrl: mdb.url, env: enforceEnv({ SUBSCRIPTION_SWEEP_MS: '3600000' }) }); extra.push(slow); assert.ok(slow.up);
    const sh = http(slow.base);
    const expire = (id) => mdb.pool.query(`UPDATE meetings SET deadline_at = now() - interval '1 second' WHERE id=$1`, [id]);
    // (a) a join
    const a = await owned({ api: sh }); await expire(a.meetingId);
    const j = await sh.join(a.meetingId, 'Late'); assert.equal(j.status, 403); assert.equal(j.body.error, 'Meeting time limit reached');
    assert.equal((await rowOn(a.meetingId)).end_reason, 'time_limit', 'and the meeting is now ended');
    // (b) a returning participant's socket
    const b = await owned({ api: sh }); const gb = (await sh.join(b.meetingId, 'G')).body;
    const first = await connectSocket(slow.base, gb.token); first.socket.close();
    await until(async () => (await mdb.pool.query('SELECT left_at FROM participants WHERE id=$1', [gb.participantId])).rows[0].left_at, 3000);
    await expire(b.meetingId);
    assert.equal((await connectSocket(slow.base, gb.token)).error, 'Meeting time limit reached');
    // (c) any authenticated request
    const c = await owned({ api: sh }); await expire(c.meetingId);
    assert.equal((await sh.get(c.meetingId, c.hostToken)).status, 403);
    assert.equal((await rowOn(c.meetingId)).end_reason, 'time_limit');
    await slow.stop(); await mdb.drop();
  });

  test('SUSPENSION blocks joins and returning participants immediately, before any sweeper has run', async () => {
    const mdb = await createMeetDb(); const rowOn = async (id) => (await mdb.pool.query('SELECT * FROM meetings WHERE id=$1', [id])).rows[0];
    const slow = await startMeet({ meetUrl: mdb.url, env: enforceEnv({ SUBSCRIPTION_SWEEP_MS: '3600000' }) }); extra.push(slow); assert.ok(slow.up);
    const sh = http(slow.base);
    const m = await owned({ plan: 'pro', api: sh });
    const g = (await sh.join(m.meetingId, 'G')).body; const first = await connectSocket(slow.base, g.token); first.socket.close();
    await until(async () => (await mdb.pool.query('SELECT left_at FROM participants WHERE id=$1', [g.participantId])).rows[0].left_at, 3000);
    await sub.owner.query(`INSERT INTO customers (id, name, created_by, status) VALUES ($1,'Suspended','t','suspended')`, [m.customerId]);
    const j = await sh.join(m.meetingId, 'New'); assert.equal(j.status, 403); assert.equal(j.body.error, 'Account suspended');
    assert.equal((await sh.join(m.meetingId, 'Host', m.hostSecret)).status, 403, 'not even the host of a suspended account');
    assert.equal((await connectSocket(slow.base, g.token)).error, 'Account suspended');
    await slow.stop(); await mdb.drop();
  });

});
