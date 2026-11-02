const { test, expect, request: pwRequest } = require('@playwright/test');
const { io } = require('socket.io-client');

// End-to-end wiring checks for meeting creation, passcodes, invitations, account passwords and the sections that live outside MAIN.
test.use({ permissions: ['camera', 'microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });
const ctx = (baseURL, extra = {}) => pwRequest.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL, ...extra } });
const create = async (api, body = {}) => { const r = await api.post('/api/meetings/create', { data: { topic: 'Wiring', hostId: 'usr_wire', ...body } }); return { status: r.status(), body: await r.json() }; };
const session = (api, data) => api.post('/api/guest/sessions', { data });
const cookie = (r) => (r.headers()['set-cookie'] || '').split(';')[0];
const reg = async (baseURL, label) => {
  const api = await ctx(baseURL); const username = (label + Math.random().toString(36).slice(2, 8)).toLowerCase().slice(0, 20);
  const r = await api.post('/api/auth/register', { data: { username, displayName: 'W ' + label, password: 'Wiring-pass-9917!x' } }); expect(r.status()).toBe(201);
  return { api, user: (await r.json()).user, username };
};

test.describe('meeting ID and passcode', () => {
  test('creation yields an 11-digit ID; a passcode is optional, 4-32 characters, hashed and never returned', async ({ baseURL }) => {
    const api = await ctx(baseURL);
    const plain = await create(api); expect(plain.status).toBe(201); expect(plain.body.meeting.meetingId).toMatch(/^\d{3} \d{4} \d{4}$/); expect(plain.body.meeting.passcodeRequired).toBe(false);
    expect((await create(api, { passcode: 'abc' })).status).toBe(400);
    const locked = await create(api, { passcode: 'open-sesame' }); expect(locked.status).toBe(201);
    expect(JSON.stringify(locked.body)).not.toContain('open-sesame'); expect(JSON.stringify(locked.body)).not.toMatch(/passcodeHash|hostKeyHash/); expect(locked.body.meeting.passcodeRequired).toBe(true);
    const v = await (await api.get('/api/meetings/validate/' + encodeURIComponent(locked.body.meeting.meetingId))).json(); expect(v.passcodeRequired).toBe(true);
    const ids = new Set(); for (let i = 0; i < 20; i++) ids.add((await create(api)).body.meeting.meetingId); expect(ids.size).toBe(20);
  });

  test('guests need the passcode; the host key bypasses it; five wrong tries lock it even for the right passcode', async ({ baseURL }) => {
    const api = await ctx(baseURL); const m = await create(api, { passcode: 'open-sesame' }); const id = m.body.meeting.meetingId;
    expect((await (await ctx(baseURL)).post('/api/guest/meetings/resolve', { data: { meetingId: id } })).status()).toBe(200);
    const g = await ctx(baseURL);
    expect((await session(g, { meetingId: id, displayName: 'G' })).status()).toBe(403);
    expect((await session(g, { meetingId: id, displayName: 'G', passcode: 'nope' })).status()).toBe(403);
    const ok = await session(g, { meetingId: id, displayName: 'G', passcode: 'open-sesame' }); expect(ok.status()).toBe(201);
    const host = await session(await ctx(baseURL), { meetingId: id, displayName: 'H', hostKey: m.body.hostKey }); expect(host.status()).toBe(201); expect((await host.json()).session.role).toBe('host');
    const m2 = await create(api, { passcode: 'second-code' }); const id2 = m2.body.meeting.meetingId; const attacker = await ctx(baseURL);
    for (let i = 0; i < 5; i++) await session(attacker, { meetingId: id2, displayName: 'A', passcode: 'guess' + i });
    const locked = await session(attacker, { meetingId: id2, displayName: 'A', passcode: 'second-code' }); expect(locked.status()).toBe(429);
  });

  test('signed-in people also need the passcode, on the REST step and on the socket', async ({ baseURL }) => {
    const api = await ctx(baseURL); const m = await create(api, { passcode: 'acct-code' }); const id = m.body.meeting.meetingId;
    const { api: a } = await reg(baseURL, 'pcacct');
    expect((await session(a, { meetingId: id, displayName: 'x' })).status()).toBe(403);
    const cookies = (await a.storageState()).cookies.map((c) => c.name + '=' + c.value).join('; ');
    const s1 = io(baseURL, { transports: ['websocket'], forceNew: true, extraHeaders: { cookie: cookies } });
    await new Promise((r) => s1.once('connect', r));
    const denied = new Promise((r) => s1.once('error_response', r)); s1.emit('join_room', { meetingId: id, userName: 'x' }); expect((await denied).code).toBe('passcode_required');
    expect((await session(a, { meetingId: id, displayName: 'x', passcode: 'acct-code' })).status()).toBe(200);
    const joined = new Promise((r) => s1.once('room_state_updated', r)); s1.emit('join_room', { meetingId: id, userName: 'x' }); expect((await joined).participants.length).toBe(1);
    s1.close();
  });
});

test.describe('invitations', () => {
  test('only the host can send email invitations; input is validated; without SMTP the server says so', async ({ baseURL }) => {
    const api = await ctx(baseURL); const m = await create(api); const id = m.body.meeting.meetingId; const url = '/api/meetings/' + encodeURIComponent(id) + '/invite';
    expect((await (await ctx(baseURL)).post(url, { data: { emails: ['a@example.com'] } })).status()).toBe(401);
    const guest = await ctx(baseURL); await session(guest, { meetingId: id, displayName: 'G' });
    expect((await guest.post(url, { data: { emails: ['a@example.com'] } })).status()).toBe(403);
    const host = await ctx(baseURL); await session(host, { meetingId: id, displayName: 'H', hostKey: m.body.hostKey });
    expect((await host.post(url, { data: { emails: [] } })).status()).toBe(400);
    expect((await host.post(url, { data: { emails: ['not-an-address'] } })).status()).toBe(400);
    expect((await host.post(url, { data: { emails: Array.from({ length: 21 }, (_, i) => `u${i}@example.com`) } })).status()).toBe(400);
    const r = await host.post(url, { data: { emails: ['a@example.com'] } }); expect(r.status()).toBe(503); expect((await r.json()).error).toMatch(/Email is not set up/);
  });

  test('in the meeting, the host sees Email / Text / Copy options with the ID and link; a wrong passcode is refused at pre-join and the right one gets in', async ({ browser, baseURL }) => {
    test.setTimeout(120000);
    const hctx = await browser.newContext({ baseURL }); const gctx = await browser.newContext({ baseURL });
    const host = await hctx.newPage(); const guest = await gctx.newPage();
    await host.goto('/index.html'); await host.fill('#displayName', 'Host Pat'); await host.fill('#passcodeInput', 'door-code'); await host.click('#startMeetingBtn');
    await expect(host.locator('#meetingBar')).toBeVisible(); const id = (await host.locator('#meetingIdLabel').textContent()).trim();
    await host.click('#inviteBtn'); await expect(host.locator('#invitePanel')).toBeVisible();
    expect(await host.locator('#inviteMail').getAttribute('href')).toContain(encodeURIComponent(id)); expect(decodeURIComponent(await host.locator('#inviteSms').getAttribute('href'))).toContain('/guest/meeting/');
    await host.fill('#inviteEmails', 'friend@example.com'); await host.click('#inviteSend'); await expect(host.locator('#inviteStatus')).toContainText('Email is not set up');
    await guest.goto('/guest/meeting/' + encodeURIComponent(id) + '/prejoin'); await expect(guest.locator('#pjPassWrap')).toBeVisible();
    await guest.fill('#pjName', 'Guest Gus'); await guest.fill('#pjPass', 'wrong'); await guest.click('#pjGo'); await expect(guest.locator('#pjMsg')).toContainText('Incorrect passcode');
    await guest.fill('#pjPass', 'door-code'); await guest.click('#pjGo'); await expect(guest).toHaveURL(/index\.html/);
    await guest.fill('#passcodeInput', 'door-code'); await guest.click('#joinMeetingBtn'); await expect(guest.locator('#meetingBar')).toBeVisible();
    await expect(host.locator('#videoGrid .tile')).toHaveCount(2);
    await hctx.close(); await gctx.close();
  });
});

test.describe('accounts and sections outside MAIN', () => {
  test('signed-in password change, wrong current password, and recovery paths respond honestly', async ({ baseURL }) => {
    const { api, username } = await reg(baseURL, 'pw');
    expect((await api.post('/api/auth/password', { data: { currentPassword: 'wrong', password: 'New-pass-9917!zz' } })).status()).toBe(401);
    expect((await api.post('/api/auth/password', { data: { currentPassword: 'Wiring-pass-9917!x', password: 'short' } })).status()).toBe(400);
    expect((await api.post('/api/auth/password', { data: { currentPassword: 'Wiring-pass-9917!x', password: 'New-pass-9917!zz' } })).status()).toBe(200);
    const anon = await ctx(baseURL); expect((await anon.post('/api/auth/login', { data: { username, password: 'New-pass-9917!zz' } })).status()).toBe(200);
    expect((await anon.post('/api/auth/login', { data: { username, password: 'Wiring-pass-9917!x' } })).status()).toBe(401);
    expect((await (await ctx(baseURL)).post('/api/auth/forgot', { data: { username } })).status()).toBe(503);   // no SMTP here: it says so instead of pretending
  });

  test('Portal sections and Meet answer with an explanation (not a bare "Cannot GET") on a standalone MAIN', async ({ page }) => {
    for (const p of ['/app/phone', '/app/suite', '/app/meet', '/pricing', '/app/billing']) {
      const r = await page.goto(p); expect(r.status(), p).toBe(503); await expect(page.locator('body')).toContainText('not running here'); await expect(page.getByRole('link', { name: 'Back to Qorlla' })).toBeVisible();
    }
  });

  test('every MAIN-hosted sidebar item opens a working view backed by its API', async ({ page, context }) => {
    const username = ('nav' + Math.random().toString(36).slice(2, 8)); const r = await context.request.post('/api/auth/register', { data: { username, displayName: 'Nav', password: 'Wiring-pass-9917!x' } }); expect(r.status()).toBe(201);
    const failed = []; page.on('response', (x) => { const u = new URL(x.url()); if (u.pathname.startsWith('/api/') && x.status() >= 400) failed.push(x.status() + ' ' + u.pathname); });
    for (const view of ['home', 'mail', 'whiteboard', 'calendar', 'schedule', 'notes', 'more', 'settings']) {
      await page.goto('/qorlla.html'); await page.click(`.nav-item[data-view="${view}"]`); await expect(page).toHaveURL(new RegExp('#' + view + '$'));
    }
    await page.goto('/qorlla.html'); await page.click('.nav-item[data-act="chat"]'); await expect(page).toHaveURL(/\/chat\.html/);
    expect(failed).toEqual([]);
    for (const p of ['/api/workplace/chat', '/api/workplace/notes', '/api/workplace/whiteboard', '/api/workplace/mail', '/api/workplace/calendar', '/api/workplace/schedule']) expect((await context.request.get(p)).status(), p).toBe(200);
  });
});

test('the host is told about a passcode lockout and can lift it from the meeting screen; the passcode itself is untouched', async ({ browser, baseURL }) => {
  test.setTimeout(120000);
  const hctx = await browser.newContext({ baseURL }); const host = await hctx.newPage();
  await host.goto('/index.html'); await host.fill('#displayName', 'Host Lou'); await host.fill('#passcodeInput', 'lift-code'); await host.click('#startMeetingBtn');
  await expect(host.locator('#meetingBar')).toBeVisible(); const id = (await host.locator('#meetingIdLabel').textContent()).trim();
  const attacker = await ctx(baseURL); for (let i = 0; i < 5; i++) await session(attacker, { meetingId: id, displayName: 'A', passcode: 'wrong' + i });
  await expect(host.locator('#lockRow')).toBeVisible(); await expect(host.locator('#lockMsg')).toContainText('locked');
  expect((await session(attacker, { meetingId: id, displayName: 'A', passcode: 'lift-code' })).status()).toBe(429);
  await host.click('#clearLockBtn'); await expect(host.locator('#lockRow')).toBeHidden();
  expect((await session(attacker, { meetingId: id, displayName: 'A', passcode: 'lift-code' })).status()).toBe(201);
  await hctx.close();
});
