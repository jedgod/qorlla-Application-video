const { test, expect, request: pwRequest } = require('@playwright/test');
const { io } = require('socket.io-client');
const { createGuestSessions, rateLimit } = require('../guest-sessions');

// v4.6.1 guest authorization. Real server, real HTTP and real Socket.IO connections; no mocks except a fake clock in the pure
// session-store tests (expiry cannot be waited out in a test run).
test.use({ permissions: ['camera', 'microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });
const SEED = '858 9833 3712';
const ORIGIN_HEADERS = (baseURL) => ({ origin: baseURL });
const cookieOf = (res) => (res.headers()['set-cookie'] || '').split(';')[0];

async function actor(baseURL) { return pwRequest.newContext({ baseURL, extraHTTPHeaders: ORIGIN_HEADERS(baseURL) }); }
async function newMeeting(api, body = {}) {
  const r = await api.post('/api/meetings/create', { data: { topic: 'Security QA', hostId: 'usr_qa_' + Math.random().toString(36).slice(2, 8), ...body } });
  expect(r.status()).toBe(201); return r.json();
}
async function guest(baseURL, meetingId, name = 'Guest QA', hostKey) {
  const api = await actor(baseURL);
  const r = await api.post('/api/guest/sessions', { data: { meetingId, displayName: name, hostKey } });
  return { api, res: r, cookie: cookieOf(r), status: r.status() };
}
function connect(baseURL, cookie) {
  return io(baseURL, { transports: ['websocket'], forceNew: true, extraHeaders: cookie ? { cookie } : {} });
}
const once = (s, ev, ms = 4000) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('timeout waiting for ' + ev)), ms); s.once(ev, (d) => { clearTimeout(t); resolve(d); }); });
async function join(sock, meetingId, userId = 'x', userName = 'QA') {
  await new Promise((r) => (sock.connected ? r() : sock.once('connect', r)));
  const outcome = Promise.race([once(sock, 'room_state_updated').then((d) => ({ ok: true, d })), once(sock, 'error_response').then((d) => ({ ok: false, d }))]);
  sock.emit('join_room', { meetingId, userId, userName });
  return outcome;
}
async function register(baseURL, label) {
  const api = await actor(baseURL);
  const username = (label + Math.random().toString(36).slice(2, 8)).toLowerCase().slice(0, 20);
  const r = await api.post('/api/auth/register', { data: { username, displayName: 'QA ' + label, password: 'Guest-sec-9917!x' } });
  expect(r.status()).toBe(201); return { api, user: (await r.json()).user };
}

test.describe('guest session issuance', () => {
  test('resolve gives one generic answer for unknown, ended and guest-disabled meetings', async ({ baseURL }) => {
    const api = await actor(baseURL);
    const ok = await api.post('/api/guest/meetings/resolve', { data: { meetingId: SEED } });
    expect(ok.status()).toBe(200); expect((await ok.json()).eligible).toBe(true);
    const closed = (await newMeeting(api, { allowGuests: false })).meeting.meetingId;
    const bodies = [];
    for (const id of ['000 0000 0000', closed, 'not a meeting']) { const r = await api.post('/api/guest/meetings/resolve', { data: { meetingId: id } }); expect(r.status()).toBe(404); bodies.push(await r.text()); }
    expect(new Set(bodies).size).toBe(1);
  });

  test('a session is an HttpOnly SameSite=Strict cookie bound to the meeting; the token is never in the body', async ({ baseURL }) => {
    const g = await guest(baseURL, SEED, 'Ada');
    expect(g.status).toBe(201);
    const setCookie = g.res.headers()['set-cookie'];
    expect(setCookie).toMatch(/qorlla_guest=[A-Za-z0-9_-]{40,}/); expect(setCookie).toContain('HttpOnly'); expect(setCookie).toContain('SameSite=Strict');
    const body = await g.res.json();
    expect(body.kind).toBe('guest'); expect(body.session.meetingId).toBe(SEED); expect(body.session.role).toBe('participant');
    expect(body.session.capabilities).not.toContain('meeting:admin'); expect(JSON.stringify(body)).not.toContain(g.cookie.split('=')[1]);
    const me = await g.api.get('/api/guest/sessions/me'); expect(me.status()).toBe(200);
    const anon = await (await actor(baseURL)).get('/api/guest/sessions/me'); expect(anon.status()).toBe(401);
  });

  test('issuance rejects a missing name, a foreign Origin and non-JSON bodies; an incoming token is never reused', async ({ baseURL }) => {
    const api = await actor(baseURL);
    expect((await api.post('/api/guest/sessions', { data: { meetingId: SEED, displayName: '   ' } })).status()).toBe(400);
    const cross = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { origin: 'https://evil.example' } });
    expect((await cross.post('/api/guest/sessions', { data: { meetingId: SEED, displayName: 'x' } })).status()).toBe(403);
    expect((await api.post('/api/guest/sessions', { headers: { 'content-type': 'text/plain' }, data: 'meetingId=1' })).status()).toBe(415);
    const first = await guest(baseURL, SEED, 'One'); const second = await first.api.post('/api/guest/sessions', { data: { meetingId: SEED, displayName: 'Two' } });
    expect(cookieOf(second)).not.toBe(first.cookie);
    const stale = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { cookie: first.cookie } });
    expect((await stale.get('/api/guest/sessions/me')).status()).toBe(401);             // replaced session is dead
  });

  test('a client-supplied host id or role never makes a guest the host; only the one-time host key does', async ({ baseURL }) => {
    const api = await actor(baseURL);
    const created = await newMeeting(api, { hostId: 'host_claimed' });
    expect(created.hostKey).toBeTruthy(); expect(JSON.stringify(created)).not.toContain('hostKeyHash');
    const id = created.meeting.meetingId;
    const impostor = await guest(baseURL, id, 'Impostor');
    const s1 = connect(baseURL, impostor.cookie); const r1 = await join(s1, id, 'host_claimed', 'Impostor');
    expect(r1.ok).toBe(true); expect(r1.d.participants.find((p) => p.socketId === s1.id).role).toBe('participant');
    const wrongKey = await guest(baseURL, id, 'Wrong', 'not-the-key'); expect((await wrongKey.res.json()).session.role).toBe('participant');
    const host = await guest(baseURL, id, 'RealHost', created.hostKey);
    expect((await host.res.json()).session.role).toBe('host');
    const s2 = connect(baseURL, host.cookie); const r2 = await join(s2, id, 'whatever', 'RealHost');
    expect(r2.d.participants.find((p) => p.socketId === s2.id).role).toBe('host');
    s1.close(); s2.close();
  });
});

test.describe('socket admission, revocation and termination', () => {
  test('no session, wrong-meeting session and revoked session all fail closed', async ({ baseURL }) => {
    const api = await actor(baseURL);
    const a = (await newMeeting(api)).meeting.meetingId; const b = (await newMeeting(api)).meeting.meetingId;
    const none = connect(baseURL); const rn = await join(none, a); expect(rn.ok).toBe(false); expect(rn.d.code).toBe('guest_session_required');
    const ga = await guest(baseURL, a, 'A');
    const wrong = connect(baseURL, ga.cookie); const rw = await join(wrong, b); expect(rw.ok).toBe(false);
    const good = connect(baseURL, ga.cookie); expect((await join(good, a)).ok).toBe(true);
    const kicked = once(good, 'session_revoked');
    expect((await ga.api.post('/api/guest/sessions/revoke', { data: {} })).status()).toBe(204);
    expect((await kicked).reason).toBe('signed_out');
    const again = connect(baseURL, ga.cookie); expect((await join(again, a)).ok).toBe(false);   // the old cookie no longer works
    expect((await ga.api.get('/api/guest/sessions/me')).status()).toBe(401);
    for (const s of [none, wrong, good, again]) s.close();
  });

  test('host removal revokes the guest and the same cookie cannot come back; ending the meeting revokes everyone', async ({ baseURL }) => {
    const api = await actor(baseURL);
    const created = await newMeeting(api); const id = created.meeting.meetingId;
    const host = await guest(baseURL, id, 'Host', created.hostKey); const hs = connect(baseURL, host.cookie); expect((await join(hs, id)).ok).toBe(true);
    const g1 = await guest(baseURL, id, 'G1'); const s1 = connect(baseURL, g1.cookie); const j1 = await join(s1, id);
    const g2 = await guest(baseURL, id, 'G2'); const s2 = connect(baseURL, g2.cookie); expect((await join(s2, id)).ok).toBe(true);
    // a participant cannot remove anyone
    s2.emit('remove_participant', { targetSocketId: s1.id }); expect((await once(s2, 'error_response')).message).toMatch(/denied/i);
    const revoked = once(s1, 'session_revoked'); hs.emit('remove_participant', { targetSocketId: s1.id });
    expect((await revoked).reason).toBe('removed_by_host');
    expect((await g1.api.get('/api/guest/sessions/me')).status()).toBe(401);
    expect((await join(connect(baseURL, g1.cookie), id)).ok).toBe(false);
    void j1;
    // host ends the meeting
    const ended = once(s2, 'session_revoked'); hs.emit('terminate_meeting_session');
    expect((await ended).reason).toBe('meeting_ended');
    expect((await g2.api.get('/api/guest/sessions/me')).status()).toBe(401);
    expect((await host.api.get('/api/guest/sessions/me')).status()).toBe(401);
    expect((await (await actor(baseURL)).post('/api/guest/meetings/resolve', { data: { meetingId: id } })).status()).toBe(404);
    for (const s of [hs, s1, s2]) s.close();
  });

  test('a second connection with the same session takes over; the first is disconnected', async ({ baseURL }) => {
    const api = await actor(baseURL); const id = (await newMeeting(api)).meeting.meetingId;
    const g = await guest(baseURL, id, 'Twin'); const a = connect(baseURL, g.cookie); expect((await join(a, id)).ok).toBe(true);
    const gone = once(a, 'session_revoked'); const b = connect(baseURL, g.cookie); expect((await join(b, id)).ok).toBe(true);
    expect((await gone).reason).toBe('taken_over'); a.close(); b.close();
  });

  test('refresh rotates the token: the old cookie is dead, the new one works', async ({ baseURL }) => {
    const api = await actor(baseURL); const id = (await newMeeting(api)).meeting.meetingId;
    const g = await guest(baseURL, id, 'Rot'); const ref = await g.api.post('/api/guest/sessions/refresh', { data: {} });
    expect(ref.status()).toBe(200); const fresh = cookieOf(ref); expect(fresh).not.toBe(g.cookie);
    const old = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { cookie: g.cookie } }); expect((await old.get('/api/guest/sessions/me')).status()).toBe(401);
    const neu = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { cookie: fresh } }); expect((await neu.get('/api/guest/sessions/me')).status()).toBe(200);
  });
});

test.describe('legacy endpoints', () => {
  const calls = (id = SEED) => [
    ['get', `/api/docs/meeting/${encodeURIComponent(id)}`], ['post', '/api/docs/link-to-meeting', { documentId: 'x', meetingId: id }],
    ['get', '/api/appointments/slots?hostId=host_jane_doe&date=2030-01-07'], ['post', '/api/appointments/book', { hostId: 'host_jane_doe', topic: 't', startTimeString: '2030-01-07T15:00:00Z' }],
    ['post', '/api/notifications/trigger', { eventType: 'MEETING_INVITE', recipientUserId: 'usr_jane_doe', metadata: { a: 1 } }], ['get', '/api/notifications/audit-log'], ['get', '/api/notifications/mine'],
    ['post', '/api/post-meeting/conclude', { meetingId: id }], ['get', `/api/post-meeting/summary/${encodeURIComponent(id)}`]
  ];
  const fire = (api, [m, url, data]) => (m === 'get' ? api.get(url) : api.post(url, { data: data || {} }));

  test('anonymous callers are refused on every docs, appointments, notifications and post-meeting route', async ({ baseURL }) => {
    const api = await actor(baseURL);
    for (const c of calls()) { const r = await fire(api, c); expect([401, 403], `${c[0]} ${c[1]} -> ${r.status()}`).toContain(r.status()); }
    const up = await api.post('/api/docs/upload', { multipart: { attachedFile: { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }, targetMeetingId: SEED } });
    expect(up.status()).toBe(401);
    expect((await api.get('/api/notifications/audit-log')).status()).toBe(403);   // even the log is not readable without the internal token
  });

  test('guests: own-meeting documents only, no scheduling, no notification triggers, no cross-meeting access', async ({ baseURL }) => {
    const api = await actor(baseURL);
    const a = (await newMeeting(api)).meeting.meetingId, b = (await newMeeting(api)).meeting.meetingId;
    const ga = await guest(baseURL, a, 'Alice'), gb = await guest(baseURL, b, 'Bob');
    const upload = await ga.api.post('/api/docs/upload', { multipart: { attachedFile: { name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('secret plan') } } });
    expect(upload.status()).toBe(201); const doc = (await upload.json()).document;
    expect(doc.ownerId).toBeUndefined(); expect(doc.meetingId).toBeUndefined();
    const listA = await (await ga.api.get(`/api/docs/meeting/${encodeURIComponent(a)}`)).json(); expect(listA.documents.map((d) => d.documentId)).toContain(doc.documentId);
    // Bob (other meeting) cannot list A, upload into A, or link Alice's document into B
    expect((await gb.api.get(`/api/docs/meeting/${encodeURIComponent(a)}`)).status()).toBe(403);
    expect((await gb.api.post('/api/docs/upload', { multipart: { attachedFile: { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }, targetMeetingId: a } })).status()).toBe(403);
    expect((await gb.api.post('/api/docs/link-to-meeting', { data: { documentId: doc.documentId, meetingId: b } })).status()).toBe(404);
    expect((await gb.api.post('/api/docs/link-to-meeting', { data: { documentId: doc.documentId, meetingId: a } })).status()).toBe(403);
    const listB = await (await gb.api.get(`/api/docs/meeting/${encodeURIComponent(b)}`)).json(); expect(listB.documents).toHaveLength(0);
    // a guest upload without a target lands in the guest's own meeting, never in a workspace scope
    const seedList = await (await ga.api.get(`/api/docs/meeting/${encodeURIComponent(SEED)}`)); expect(seedList.status()).toBe(403);
    for (const c of calls(a).filter((x) => /appointments|notifications\/trigger|audit-log/.test(x[1]))) { const r = await fire(ga.api, c); expect(r.status(), `${c[1]}`).toBe(403); }
    expect((await ga.api.post('/api/post-meeting/conclude', { data: { meetingId: a } })).status()).toBe(403);   // not the host
    const mine = await ga.api.get('/api/notifications/mine'); expect(mine.status()).toBe(200); expect((await mine.json()).notifications).toEqual([]);
  });

  test('the host guest (host key) may conclude their own meeting but not another', async ({ baseURL }) => {
    const api = await actor(baseURL);
    const m1 = await newMeeting(api), m2 = await newMeeting(api);
    const h = await guest(baseURL, m1.meeting.meetingId, 'Host', m1.hostKey);
    expect((await h.api.post('/api/post-meeting/conclude', { data: { meetingId: m2.meeting.meetingId } })).status()).toBe(403);
    expect([200, 201, 404]).toContain((await h.api.post('/api/post-meeting/conclude', { data: { meetingId: m1.meeting.meetingId } })).status());   // authorised; 404 only if the archive mock has no such meeting
  });

  test('signed-in accounts keep working: scheduling, own notifications, workspace and meeting documents', async ({ baseURL }) => {
    const { api, user } = await register(baseURL, 'acct');
    const slots = await api.get('/api/appointments/slots?hostId=host_jane_doe&date=2030-01-07'); expect(slots.status()).toBe(200);
    expect((await api.get('/api/appointments/slots?hostId=host_jane_doe&date=garbage')).status()).toBe(400);
    expect((await api.post('/api/appointments/book', { data: { hostId: 'host_jane_doe', topic: 'x'.repeat(201), startTimeString: '2030-01-07T15:00:00Z' } })).status()).toBe(400);
    expect((await api.post('/api/appointments/book', { data: { hostId: 'host_jane_doe', topic: 'ok', startTimeString: '2001-01-07T15:00:00Z' } })).status()).toBe(400);
    expect((await api.post('/api/appointments/book', { data: { hostId: 'host_jane_doe', topic: 'ok', startTimeString: '2030-01-07T15:00:00Z', participantEmail: 'nope' } })).status()).toBe(400);
    // notifications: only to yourself, only supported events
    expect((await api.post('/api/notifications/trigger', { data: { eventType: 'MEETING_INVITE', recipientUserId: 'usr_jane_doe', metadata: { a: 1 } } })).status()).toBe(403);
    expect((await api.post('/api/notifications/trigger', { data: { eventType: 'SUMMARY_COMPLETED', recipientUserId: user.id, metadata: { topic: 't' } } })).status()).toBe(403);
    expect((await api.get('/api/notifications/audit-log')).status()).toBe(403);
    expect((await api.get('/api/notifications/mine')).status()).toBe(200);
    // an account hosting its own meeting: host is the account (create ignores a client hostId), no host key is issued
    const created = await (await api.post('/api/meetings/create', { data: { topic: 'Mine', hostId: 'someone_else' } })).json();
    expect(created.hostKey).toBeUndefined(); expect(created.meeting.hostId).toBe(user.id);
    const id = created.meeting.meetingId;
    const up = await api.post('/api/docs/upload', { multipart: { attachedFile: { name: 'w.txt', mimeType: 'text/plain', buffer: Buffer.from('w') } } });
    expect(up.status()).toBe(201);
    const up2 = await api.post('/api/docs/upload', { multipart: { attachedFile: { name: 'm.txt', mimeType: 'text/plain', buffer: Buffer.from('m') }, targetMeetingId: id } });
    expect(up2.status()).toBe(201);
    const list = await (await api.get(`/api/docs/meeting/${encodeURIComponent(id)}`)).json(); expect(list.documents).toHaveLength(1);
    // another account cannot see it
    const other = await register(baseURL, 'other');
    expect((await other.api.get(`/api/docs/meeting/${encodeURIComponent(id)}`)).status()).toBe(403);
    expect((await other.api.post('/api/docs/upload', { multipart: { attachedFile: { name: 'z.txt', mimeType: 'text/plain', buffer: Buffer.from('z') }, targetMeetingId: id } })).status()).toBe(403);
  });

  test('internal callers (shared token) can still notify; the token is never accepted when unset', async ({ baseURL }) => {
    const api = await actor(baseURL);
    const r = await api.post('/api/notifications/trigger', { headers: { 'x-internal-token': 'anything-not-configured-1234567890' }, data: { eventType: 'MEETING_INVITE', recipientUserId: 'usr_jane_doe', metadata: { a: 1 } } });
    expect(r.status()).toBe(401);                                // NOTIFY_INTERNAL_TOKEN is unset in the test server, so no header can match
  });
});

test('the per-IP limiter answers 429 with Retry-After once the budget is spent', () => {
  const saved = process.env.GUEST_RATE_LIMIT_MAX; delete process.env.GUEST_RATE_LIMIT_MAX;
  try {
    const lim = rateLimit(2); const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json() { return this; } };
    let passed = 0; for (let i = 0; i < 4; i++) lim({ ip: '10.0.0.9' }, res, () => { passed++; });
    expect(passed).toBe(2); expect(res.code).toBe(429); expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0);
  } finally { if (saved !== undefined) process.env.GUEST_RATE_LIMIT_MAX = saved; }
});

test.describe('session store (fake clock)', () => {
  function store() {
    let t = Date.parse('2030-01-01T00:00:00Z'); const meetings = new Map([['M1', { meetingId: 'M1', status: 'active' }]]);
    const s = createGuestSessions({ getMeeting: (id) => meetings.get(id), now: () => t });
    return { s, meetings, advance: (ms) => { t += ms; } };
  }
  const req = (token) => ({ headers: { cookie: `qorlla_guest=${token}` } });

  test('idle expiry and absolute lifetime both fail closed; refresh extends only up to the absolute deadline', () => {
    const { s, advance } = store(); const { token, session } = s.issue({ meetingId: 'M1', displayName: 'A' });
    expect(s.fromRequest(req(token))).toBeTruthy();
    advance(59 * 60 * 1000); const r1 = s.refresh(req(token)); expect(r1).toBeTruthy(); expect(s.fromRequest(req(token))).toBeNull();   // old token dead
    let cur = r1.token; let n = 0;
    while (n++ < 20) { advance(59 * 60 * 1000); const r = s.refresh(req(cur)); if (!r) break; cur = r.token; }
    expect(n).toBeLessThan(20); expect(s.fromRequest(req(cur))).toBeNull();                       // absolute 8 h limit reached
    expect(session.maxExpiresAt - session.issuedAt).toBe(8 * 60 * 60 * 1000);
  });

  test('wrong, expired, revoked and ended-meeting sessions are rejected; revokeMeeting drops them all', () => {
    const { s, meetings, advance } = store();
    expect(s.fromRequest(req('garbage'))).toBeNull(); expect(s.fromRequest({ headers: {} })).toBeNull();
    const a = s.issue({ meetingId: 'M1', displayName: 'A' }), b = s.issue({ meetingId: 'M1', displayName: 'B' });
    s.revokeSid(a.session.sid); expect(s.fromRequest(req(a.token))).toBeNull(); expect(s.fromRequest(req(b.token))).toBeTruthy();
    const dropped = []; s.setRevokeHandler((x, why) => dropped.push([x.sid, why]));
    meetings.get('M1').status = 'completed'; expect(s.fromRequest(req(b.token))).toBeNull(); expect(dropped[0][1]).toBe('meeting_ended');
    meetings.get('M1').status = 'active'; const c = s.issue({ meetingId: 'M1', displayName: 'C' }); s.revokeMeeting('M1'); expect(s.fromRequest(req(c.token))).toBeNull();
    const d = s.issue({ meetingId: 'M1', displayName: 'D' }); advance(61 * 60 * 1000); expect(s.fromRequest(req(d.token))).toBeNull();
  });

  test('eligibility honours guest policy, the invitation window and the evergreen demo meeting', () => {
    const { s } = store(); const now = Date.parse('2030-01-01T00:00:00Z');
    expect(s.eligibility({ status: 'scheduled', startTime: new Date(now).toISOString(), durationMinutes: 30 })).toBe(true);
    expect(s.eligibility({ status: 'scheduled', startTime: new Date(now).toISOString(), allowGuests: false })).toBe(false);
    expect(s.eligibility({ status: 'completed', startTime: new Date(now).toISOString() })).toBe(false);
    expect(s.eligibility({ status: 'scheduled', startTime: '2001-01-01T00:00:00Z', durationMinutes: 30 })).toBe(false);          // expired invitation
    expect(s.eligibility({ status: 'scheduled', startTime: '2001-01-01T00:00:00Z', evergreen: true })).toBe(true);
    expect(s.eligibility(undefined)).toBe(false);
  });
});

test.describe('guest journey in the browser', () => {
  test('Welcome -> Join Meeting -> Pre-Join -> meeting; the session cookie is invisible to page script; host removes the guest', async ({ browser, baseURL }) => {
    test.setTimeout(120000);
    const hostCtx = await browser.newContext({ baseURL }); const guestCtx = await browser.newContext({ baseURL });
    const host = await hostCtx.newPage(); const guestPage = await guestCtx.newPage();
    await host.goto('/index.html'); await host.fill('#displayName', 'Host Hana'); await host.click('#startMeetingBtn');
    await expect(host.locator('#meetingBar')).toBeVisible();
    const meetingId = (await host.locator('#meetingIdLabel').textContent()).trim();

    await guestPage.goto('/guest/welcome'); await guestPage.getByRole('link', { name: /Join Meeting/ }).first().click();
    await expect(guestPage).toHaveURL(/\/guest\/join-meeting$/);
    await guestPage.fill('#mid', meetingId); await guestPage.getByRole('button', { name: 'Continue' }).click();
    await expect(guestPage).toHaveURL(/\/prejoin$/); await expect(guestPage.locator('#pjTopic')).toContainText('You are joining');
    await guestPage.fill('#pjName', 'Guest Gil'); await guestPage.click('#pjTest'); await expect(guestPage.locator('#pjMsg')).toContainText('working');
    await guestPage.click('#pjGo');
    await expect(guestPage).toHaveURL(/\/index\.html\?meeting=/);
    await guestPage.click('#joinMeetingBtn'); await expect(guestPage.locator('#meetingBar')).toBeVisible();
    expect(await guestPage.evaluate(() => document.cookie)).not.toContain('qorlla_guest');
    expect((await guestCtx.cookies()).find((c) => c.name === 'qorlla_guest')).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
    await expect(host.locator('#videoGrid .tile')).toHaveCount(2);

    host.on('dialog', (d) => d.accept());
    await host.click('#peopleBtn');
    await host.locator('li', { hasText: 'Guest Gil' }).getByRole('button', { name: 'Remove' }).click();
    await expect(guestPage.locator('#toasts')).toContainText('removed you');
    await expect(host.locator('#videoGrid .tile')).toHaveCount(1);
    expect((await guestCtx.request.get('/api/guest/sessions/me')).status()).toBe(401);
    await hostCtx.close(); await guestCtx.close();
  });

  test('guest pages are localized from the shared catalogs and an unknown meeting is refused at pre-join', async ({ browser, baseURL }) => {
    const ctx = await browser.newContext({ baseURL }); const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('qorlla.locale', 'fr'); } catch (e) { /* storage unavailable */ } });
    await page.goto('/guest/welcome');
    await expect(page.locator('#v-welcome h1')).toHaveText('Bienvenue sur Qorlla'); await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await page.goto('/guest/meeting/000%200000%200000/prejoin');
    await expect(page.locator('#pjTopic')).toContainText('n’est pas valide'); await expect(page.locator('#pjGo')).toBeDisabled();
    await ctx.close();
  });
});
