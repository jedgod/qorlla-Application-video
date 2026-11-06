// Entitlement enforcement in front of the Meet API. The stub app mirrors Meet's real route shapes
// (bridge create, /api/meetings/:id/join, ...) and records whether a handler was ever reached.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { createTestDb, newCustomer, seedSubscription, skip } from './helpers/db.js';
import { AccessService } from '../src/accessService.js';
import { createMeetGuard } from '../src/meetGuard.js';

describe('Meet guard (PostgreSQL)', { skip }, () => {
  let db, service, meetings, reached, server, base, guardDeny, guardAllow, denyBase, allowBase, downServer, downBase;
  before(async () => {
    db = await createTestDb();
    service = new AccessService({ pool: db.poolFor('runtime') });
    meetings = new Map();                                                   // id|code -> { customerId, participantCount }
    reached = [];
    const lookupMeeting = async (idOrCode) => { if (idOrCode === 'boom') throw new Error('meet db down'); return meetings.get(idOrCode) || null; };

    const build = (guard) => {
      const app = express();
      app.use(express.json());
      const bridgeAuth = (req, res, next) => (req.get('x-qorlla-bridge-secret') === 'secret' ? next() : res.status(401).json({ error: 'Bridge authentication required' }));
      const hit = (name) => (req, res) => { reached.push(name); res.status(200).json({ reached: name }); };
      app.post('/api/integrations/scheduled-meetings', bridgeAuth, guard.bridgeCreate(), hit('bridge-create'));
      app.post('/api/meetings/:id/join', guard.join(), (req, res) => { reached.push('join'); const m = meetings.get(req.params.id); return m ? res.json({ joined: true }) : res.status(404).json({ error: 'Meeting unavailable' }); });
      app.post('/api/meetings/:id/recording/start', guard.feature('meetings.cloud_recording', { customerOf: async (req) => meetings.get(req.params.id)?.customerId ?? null }), hit('recording'));
      app.post('/api/meetings/:id/webinar', guard.feature('meetings.webinar_mode', { customerOf: async (req) => meetings.get(req.params.id)?.customerId ?? null }), hit('webinar'));
      const s = createServer(app);
      return new Promise((r) => s.listen(0, '127.0.0.1', () => r([s, `http://127.0.0.1:${s.address().port}`])));
    };
    [server, base] = await build(createMeetGuard({ service, lookupMeeting }));                       // unowned: 'basic' (default)
    [guardDeny, denyBase] = await build(createMeetGuard({ service, lookupMeeting, unowned: 'deny' }));
    [guardAllow, allowBase] = await build(createMeetGuard({ service, lookupMeeting, unowned: 'allow' }));
    [downServer, downBase] = await build(createMeetGuard({ service: new AccessService({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none', connectionTimeoutMs: 300 }), lookupMeeting }));
  });
  after(async () => { for (const s of [server, guardDeny, guardAllow, downServer]) s.close(); await db.drop(); });

  const customer = async (plan, o) => { const c = newCustomer(); await seedSubscription(db.owner, c, { plan, ...o }); return c; };
  const req = (b, path, body, headers = {}) => fetch(b + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });
  const bridge = (body, b = base) => req(b, '/api/integrations/scheduled-meetings', body, { 'x-qorlla-bridge-secret': 'secret' });
  const meeting = (id, customerId, participantCount) => meetings.set(id, { customerId, participantCount });
  const mark = () => reached.length;

  test('bridge create: the trusted caller must name a valid customer; the bridge secret still comes first', async () => {
    const pro = await customer('pro');
    const m = mark();
    assert.equal((await req(base, '/api/integrations/scheduled-meetings', { customerId: pro })).status, 401, 'no bridge secret');
    for (const bad of [{}, { customerId: 'x' }, { customerId: 5 }, { customerId: "' OR 1=1" }]) assert.equal((await bridge(bad)).status, 400, JSON.stringify(bad));
    assert.equal(reached.length, m, 'no handler ran');
    assert.equal((await bridge({ customerId: pro, title: 'Sync' })).status, 200);
  });

  test('bridge create enforces the plan: webinar, recording, breakout rooms, participants and duration', async () => {
    const [basic, pro, biz] = [await customer('basic'), await customer('pro'), await customer('business')];
    const code = async (c, body) => { const r = await bridge({ customerId: c, ...body }); return [r.status, (await r.json()).code]; };
    assert.deepEqual(await code(basic, { recording: true }), [403, 'feature_not_available']);
    assert.deepEqual(await code(pro, { recording: true }), [200, undefined]);
    assert.deepEqual(await code(pro, { breakoutRooms: true }), [200, undefined]);
    assert.deepEqual(await code(basic, { breakoutRooms: true }), [403, 'feature_not_available']);
    assert.deepEqual(await code(pro, { webinar: true }), [403, 'feature_not_available']);
    assert.deepEqual(await code(biz, { webinar: true }), [200, undefined]);
    assert.deepEqual(await code(basic, { maxParticipants: 100 }), [200, undefined]);
    assert.deepEqual(await code(basic, { maxParticipants: 101 }), [403, 'limit_exceeded']);
    assert.deepEqual(await code(biz, { maxParticipants: 300 }), [200, undefined]);
    assert.deepEqual(await code(biz, { maxParticipants: 301 }), [403, 'limit_exceeded']);
    assert.deepEqual(await code(basic, { durationMinutes: 40 }), [200, undefined]);
    assert.deepEqual(await code(basic, { durationMinutes: 41 }), [403, 'limit_exceeded']);
    assert.deepEqual(await code(biz, { durationMinutes: 100000 }), [200, undefined], 'unlimited');
    for (const bad of [0, -3, 1.5, '50', null]) assert.equal((await bridge({ customerId: basic, maxParticipants: bad })).status, 400, String(bad));
    assert.deepEqual(await code(basic, { recording: true, maxParticipants: 5 }), [403, 'feature_not_available'], 'the first denial wins');
  });

  test('bridge create for a lapsed customer is refused with 402 for paid features and still allows the free tier', async () => {
    const paused = await customer('pro', { status: 'paused' });
    const r = await bridge({ customerId: paused, recording: true });
    assert.equal(r.status, 402); assert.equal((await r.json()).code, 'subscription_inactive');
    assert.equal((await bridge({ customerId: paused, title: 'free meeting' })).status, 200, 'meetings.host is a free feature');
    assert.equal((await bridge({ customerId: paused, maxParticipants: 101 })).status, 403, 'and the free limits apply');
  });

  test('join: the participant cap is the customer\'s plan and counts the person joining', async () => {
    const [basic, biz] = [await customer('basic'), await customer('business')];
    meeting('b99', basic, 99); meeting('b100', basic, 100); meeting('z299', biz, 299); meeting('z300', biz, 300);
    const join = (id) => req(base, `/api/meetings/${id}/join`, { name: 'x' });
    assert.equal((await join('b99')).status, 200, 'the 100th person fits');
    const full = await join('b100');
    assert.equal(full.status, 403); assert.equal((await full.json()).code, 'limit_exceeded');
    assert.equal((await join('z299')).status, 200); assert.equal((await join('z300')).status, 403);
  });

  test('join: an unknown meeting reaches Meet unchanged (404 is Meet\'s to give), and the guard never invents data', async () => {
    const r = await req(base, '/api/meetings/nope/join', { name: 'x' });
    assert.equal(r.status, 404); assert.equal((await r.json()).error, 'Meeting unavailable');
  });

  test('join: anonymous meetings (no customer) get the FREE plan by default - never unlimited; policy is configurable', async () => {
    meeting('anon99', null, 99); meeting('anon100', null, 100);
    const j = (b, id) => req(b, `/api/meetings/${id}/join`, { name: 'x' });
    assert.equal((await j(base, 'anon99')).status, 200); assert.equal((await j(base, 'anon100')).status, 403);
    assert.equal((await j(denyBase, 'anon99')).status, 402, "unowned:'deny'");
    assert.equal((await j(allowBase, 'anon100')).status, 200, "unowned:'allow' (explicit opt-in)");
    meeting('badowner', 'not-a-uuid', 10);
    assert.equal((await j(base, 'badowner')).status, 200, 'a malformed owner is treated as anonymous, not as a bypass');
    assert.equal((await j(base, 'badowner')).status, 200);
  });

  test('join: a lapsed customer\'s meetings fall back to free limits, not to the paid ones', async () => {
    const lapsed = await customer('business', { status: 'canceled' });
    meeting('lap100', lapsed, 100); meeting('lap50', lapsed, 50);
    assert.equal((await req(base, '/api/meetings/lap100/join', { name: 'x' })).status, 403, 'would be fine on business (300), not on the free plan (100)');
    assert.equal((await req(base, '/api/meetings/lap50/join', { name: 'x' })).status, 200);
  });

  test('generic feature gates: recording and webinar follow the meeting\'s customer', async () => {
    const [basic, pro, biz] = [await customer('basic'), await customer('pro'), await customer('business')];
    meeting('rb', basic, 1); meeting('rp', pro, 1); meeting('rz', biz, 1); meeting('ra', null, 1);
    const rec = (id) => req(base, `/api/meetings/${id}/recording/start`, {});
    assert.equal((await rec('rb')).status, 403); assert.equal((await rec('rp')).status, 200); assert.equal((await rec('ra')).status, 403, 'anonymous = free plan = no recording');
    const web = (id) => req(base, `/api/meetings/${id}/webinar`, {});
    assert.equal((await web('rp')).status, 403); assert.equal((await web('rz')).status, 200);
    assert.throws(() => createMeetGuard({ service }).feature('meetings.cloud_recording', {}), /customerOf/);
  });

  test('FAIL CLOSED: if the entitlement database or the Meet lookup fails, the handler is never reached (503)', async () => {
    const m = mark();
    assert.equal((await bridge({ customerId: newCustomer() }, downBase)).status, 503);
    meeting('dbdown', newCustomer(), 1);
    assert.equal((await req(downBase, '/api/meetings/dbdown/join', { name: 'x' })).status, 503);
    assert.equal((await req(downBase, '/api/meetings/dbdown/recording/start', {})).status, 503);
    assert.equal((await req(base, '/api/meetings/boom/join', { name: 'x' })).status, 503, 'lookup failure');
    meeting('negcount', newCustomer(), -1); meeting('nancount', newCustomer(), 'many');
    assert.equal((await req(base, '/api/meetings/negcount/join', { name: 'x' })).status, 503, 'an impossible participant count is not trusted');
    assert.equal((await req(base, '/api/meetings/nancount/join', { name: 'x' })).status, 503);
    const bodies = await Promise.all([bridge({ customerId: newCustomer() }, downBase)].map(async (p) => (await p).text()));
    assert.doesNotMatch(bodies.join(), /ECONNREFUSED|127\.0\.0\.1|postgres|meet db down/);
    assert.equal(reached.length, m, 'no handler ran for any of them');
  });

  test('configuration is validated', () => {
    assert.throws(() => createMeetGuard({}), /AccessService/);
    assert.throws(() => createMeetGuard({ service, unowned: 'maybe' }), /unowned/);
  });

  test('a burst of 40 simultaneous joins is answered consistently, with no errors or lock contention (the guard takes no locks)', async () => {
    const basic = await customer('basic');
    meeting('burst', basic, 99);
    const rs = await Promise.all(Array.from({ length: 40 }, () => req(base, '/api/meetings/burst/join', { name: 'x' })));
    assert.equal(rs.every((r) => r.status === 200), true);
  });
});
