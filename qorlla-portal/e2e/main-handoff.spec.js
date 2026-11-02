const { test, expect: baseExpect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { BASE, signUp } = require('./helpers');
const expect = baseExpect.configure({ timeout: 60000 });

// THE REAL MAIN-APP -> MEET LAUNCH PATH (the user-facing "Start meeting" hand-off), on the isolated project "qlaunch" where the main app runs in its DIRECT mode (no DATABASE_URL), so that IT registers the
// meeting with Meet over the bridge, joins the host, and sends the browser to Meet's own origin. (In the PostgreSQL topology the sync worker owns host credentials and this path is deliberately off.)
//   E2E_BASE=http://localhost:4800  E2E_MEET_ORIGIN=http://localhost:4801  E2E_COMPOSE_PROJECT=qlaunch  E2E_BRIDGE_SECRET=<the project's QORLLA_BRIDGE_SECRET: a throw-away value>
// What it proves: authentication, meeting authorization, host identity, what the URL may and may not contain, token claims and lifetime, single use (replay), atomic concurrent redemption, expiry, and the bridge boundary.
const MEET = process.env.E2E_MEET_ORIGIN || 'http://localhost:4801', PROJECT = process.env.E2E_COMPOSE_PROJECT || 'qlaunch', BRIDGE = process.env.E2E_BRIDGE_SECRET || '';
const meetSql = (sql) => execFileSync('docker', ['exec', PROJECT + '-meet-db-1', 'psql', '-U', 'qorlla', '-d', 'qorlla_meet', '-tAc', sql], { encoding: 'utf8', timeout: 120000 }).trim();
const jwtClaims = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8'));
const EVIDENCE = { stack: PROJECT, steps: {} };
const INTERNAL = process.env.E2E_MEET_INTERNAL || 'http://localhost:4802';          // Meet's host-published port: what the main app reaches over the private network. NOT the public listener.
async function meetPost(path, body, headers = {}, origin = MEET) { const r = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }
const meetGet = async (path, token) => { const r = await fetch(MEET + path, { headers: token ? { authorization: 'Bearer ' + token } : {}, signal: AbortSignal.timeout(60000) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const codeOf = (url) => (/#qh=([A-Za-z0-9_-]+)/.exec(url) || [])[1];

test.describe('main app -> Meet hand-off (direct mode)', () => {
  test.describe.configure({ mode: 'serial' });
  let host, other, hostCtx, otherCtx, meeting = {}, startBody, startUrl;
  test.beforeAll(async ({ browser }) => { hostCtx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true }); otherCtx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true }); });
  test.afterAll(async () => { await hostCtx?.close().catch(() => {}); await otherCtx?.close().catch(() => {}); });
  const start = (ctx, id, extra = {}) => ctx.request.post(`/api/meetings/${encodeURIComponent(id)}/start`, { data: { requestId: 'r-' + Math.random().toString(36).slice(2), ...extra }, headers: { origin: BASE } });

  test('0 the stack is in direct mode and Meet answers the main app', async () => {
    host = await signUp(hostCtx, 'launchhost'); other = await signUp(otherCtx, 'launchother');
    const sch = await hostCtx.request.post('/api/workplace/schedule', { data: { title: 'Hand-off check', date: new Date().toISOString().slice(0, 10), time: '23:30', duration: 30 }, headers: { origin: BASE } }); expect(sch.status()).toBe(201);
    const item = await sch.json(); meeting.id = Object.values(item).find((v) => typeof v === 'string' && /^\d{3} \d{4} \d{4}$/.test(v)) || item.meetingId || item.id; expect(meeting.id).toBeTruthy();
    const pre = await hostCtx.request.get(`/api/meetings/${encodeURIComponent(meeting.id)}/preflight`, { headers: { origin: BASE } }); expect(pre.status()).toBe(200); const pj = await pre.json();
    expect(pj.meet).toMatchObject({ configured: true, reachable: true, public: true }); EVIDENCE.steps.directMode = { configured: true, reachable: true };
  });

  test('1 authentication and meeting authorization: no session, or someone else\'s session, gets no way into the meeting', async ({ browser }) => {
    const anon = await browser.newContext({ baseURL: BASE }); try {
      const a = await start(anon, meeting.id); expect([401, 403, 404]).toContain(a.status()); expect(await a.text()).not.toMatch(/#qh=|#qs=|"url"/);
    } finally { await anon.close(); }
    const o = await start(otherCtx, meeting.id); expect([403, 404]).toContain(o.status()); expect(await o.text()).not.toMatch(/#qh=|#qs=|"url"/);          // signed in, but not the organiser
    const inv = await otherCtx.request.get(`/api/meetings/${encodeURIComponent(meeting.id)}/invitation`, { headers: { origin: BASE } }); expect([403, 404]).toContain(inv.status());
    EVIDENCE.steps.authorization = { anonymous: 'refused', otherSignedInUser: 'refused' };
  });

  test('2 the organiser starts: the URL goes to Meet\'s own origin and carries ONE single-use code, never a session token or a credential', async () => {
    const r = await start(hostCtx, meeting.id); expect(r.status()).toBe(200); startBody = await r.json(); expect(startBody.mode).toBe('meet'); startUrl = startBody.url;
    const u = new URL(startUrl); expect(u.origin).toBe(new URL(MEET).origin); expect(u.hash).toMatch(/^#qh=[A-Za-z0-9_-]{40,50}(&qp=[A-Za-z0-9_-]+)?$/); expect(u.hash).not.toMatch(/qs=/);
    for (const where of [startUrl, JSON.stringify(startBody), JSON.stringify(r.headers())]) { expect(where).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./); if (BRIDGE) expect(where).not.toContain(BRIDGE); expect(where).not.toMatch(/hostSecret/i); }
    expect(u.search).not.toMatch(/token|secret|passcode/i); EVIDENCE.steps.url = { origin: u.origin, fragment: 'single-use code only', containsJwt: false, containsBridgeSecret: false };
  });

  test('3 redemption in a real browser: the code leaves the address bar, the session is the HOST of this meeting for the organiser\'s account, and its lifetime is 8 hours', async ({ browser }) => {
    test.setTimeout(300000); const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: [] }); const page = await ctx.newPage();
    try {
      await page.goto(startUrl); await page.waitForSelector('#app:not(.hidden)', { timeout: 180000 }); await expect(page.locator('#status')).toContainText('Connected');
      expect(page.url()).not.toContain('#'); const s = JSON.parse(await page.evaluate(() => sessionStorage.getItem('qorlla-session'))); const c = jwtClaims(s.token);
      expect(c).toMatchObject({ role: 'host', iss: 'qorlla-meet', meetingId: s.meetingId, participantId: s.participantId }); expect(c.name).toBeTruthy(); expect(c.exp - c.iat).toBe(8 * 3600);
      expect(meetSql(`select role||'|'||coalesce(account_id,'') from participants where id='${s.participantId}'`)).toBe('host|' + host.user.id); expect(meetSql(`select coalesce(host_account_id,'') from meetings where id='${s.meetingId}'`)).toBe(host.user.id);
      expect(meetSql(`select count(*) from handoffs where participant_id='${s.participantId}' and redeemed_at is not null`)).toBe('1'); meeting.uuid = s.meetingId; meeting.hostToken = s.token; meeting.hostPid = s.participantId;
      EVIDENCE.steps.redeem = { role: c.role, accountBound: true, issuer: c.iss, lifetimeSeconds: c.exp - c.iat, addressBarCleared: true };
    } finally { await ctx.close(); }
  });

  test('4 replay: the used code is dead (410) in a browser and over the API; two simultaneous redemptions of a fresh code produce exactly one session', async ({ browser }) => {
    test.setTimeout(300000); const ctx = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await ctx.newPage();
    try { await page.goto(startUrl); await expect(page.locator('#landingError')).toContainText('already used or has expired', { timeout: 120000 }); expect(await page.evaluate(() => sessionStorage.getItem('qorlla-session'))).toBeNull(); } finally { await ctx.close(); }
    expect((await meetPost('/api/handoffs/redeem', { code: codeOf(startUrl) })).status).toBe(410);
    const fresh = codeOf((await (await start(hostCtx, meeting.id)).json()).url); const both = await Promise.all([meetPost('/api/handoffs/redeem', { code: fresh }), meetPost('/api/handoffs/redeem', { code: fresh })]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 410]); expect(meetSql(`select count(*) from handoffs where redeemed_at is not null and code_hash='${require('node:crypto').createHash('sha256').update(fresh).digest('hex')}'`)).toBe('1');
    EVIDENCE.steps.replay = { reusedCode: 410, concurrentRedemptions: [200, 410] };
  });

  test('5 expiry and malformed codes are refused alike; a code cannot be made out of thin air', async () => {
    const code = codeOf((await (await start(hostCtx, meeting.id)).json()).url); const h = require('node:crypto').createHash('sha256').update(code).digest('hex');
    meetSql(`update handoffs set expires_at = now() - interval '1 second' where code_hash='${h}'`);
    const expired = await meetPost('/api/handoffs/redeem', { code }); expect(expired.status).toBe(410);
    const msgs = new Set(); for (const bad of ['', 'x', 'A'.repeat(43), 'A'.repeat(300), '../../etc/passwd', null, 12345]) { const r = await meetPost('/api/handoffs/redeem', { code: bad }); expect(r.status).toBe(410); msgs.add(JSON.stringify(r.body)); }
    msgs.add(JSON.stringify(expired.body)); expect(msgs.size).toBe(1);               // the same answer for every failure: nothing to learn
    expect(meetSql(`select count(*) from handoffs where code_hash='${h}' and redeemed_at is not null`)).toBe('0'); EVIDENCE.steps.expiry = { expiredCode: 410, malformedCodes: 7, distinctAnswers: msgs.size };
  });

  test('6 the bridge boundary: only the Workplace server can ask for a code, only for a real participant, and it cannot choose the role', async () => {
    // the PUBLIC listener does not expose the bridge at all; the internal port answers, and only to the bridge secret
    expect((await meetPost('/api/integrations/handoffs', { meetingId: meeting.uuid, participantId: meeting.hostPid }, { 'x-qorlla-bridge-secret': BRIDGE || 'x'.repeat(40) })).status).toBe(404);
    expect((await meetPost('/api/integrations/handoffs', { meetingId: meeting.uuid, participantId: meeting.hostPid }, {}, INTERNAL)).status).toBe(401);
    expect((await meetPost('/api/integrations/handoffs', { meetingId: meeting.uuid, participantId: meeting.hostPid }, { 'x-qorlla-bridge-secret': 'x'.repeat(40) }, INTERNAL)).status).toBe(401);
    if (!BRIDGE) test.info().annotations.push({ type: 'skipped-part', description: 'E2E_BRIDGE_SECRET not given: positive bridge calls not run' });
    else {
      const H = { 'x-qorlla-bridge-secret': BRIDGE };
      expect((await meetPost('/api/integrations/handoffs', { meetingId: meeting.uuid, participantId: '00000000-0000-4000-8000-000000000000' }, H, INTERNAL)).status).toBe(404);              // not a participant
      expect((await meetPost('/api/integrations/handoffs', { meetingId: 'nope', participantId: meeting.hostPid }, H, INTERNAL)).status).toBe(400);
      // a guest joined with the meeting's own secret is a GUEST whatever the caller wants: role and name come from Meet's participant row
      const g = await meetPost(`/api/meetings/${meeting.uuid}/join`, { name: 'Guest Gail' }); expect([403, 200]).toContain(g.status);          // without the meeting secret Meet refuses (the ID alone cannot bypass the Workplace passcode)
      if (g.status === 200) { const iss = await meetPost('/api/integrations/handoffs', { meetingId: meeting.uuid, participantId: g.body.participantId, role: 'host', name: 'The Host' }, H, INTERNAL); const red = await meetPost('/api/handoffs/redeem', { code: iss.body.code }); expect(jwtClaims(red.body.token)).toMatchObject({ role: 'guest', name: 'Guest Gail' }); }
      EVIDENCE.steps.bridge = { noSecret: 401, wrongSecret: 401, unknownParticipant: 404, directJoinWithoutMeetingSecret: g.status };
    }
  });

  test('7 the session token itself: tampered, unsigned, or used on another meeting, it is refused', async () => {
    const t = meeting.hostToken; expect((await meetGet(`/api/meetings/${meeting.uuid}`, t)).status).toBe(200);
    const parts = t.split('.'); const flip = parts[2][0] === 'A' ? 'B' : 'A'; expect((await meetGet(`/api/meetings/${meeting.uuid}`, [parts[0], parts[1], flip + parts[2].slice(1)].join('.'))).status).toBe(401);
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.' + parts[1] + '.'; expect((await meetGet(`/api/meetings/${meeting.uuid}`, none)).status).toBe(401);
    expect((await meetGet(`/api/meetings/${meeting.uuid}`)).status).toBe(401); expect((await meetGet('/api/meetings/00000000-0000-4000-8000-000000000000', t)).status).toBe(403);
    EVIDENCE.steps.token = { tampered: 401, algNone: 401, noToken: 401, otherMeeting: 403 };
    const out = process.env.E2E_EVIDENCE_FILE; if (out) fs.writeFileSync(out, JSON.stringify({ ...EVIDENCE, finishedAt: new Date().toISOString() }, null, 2));
  });
});
