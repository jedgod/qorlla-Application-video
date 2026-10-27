const { test, expect, request: pwRequest } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const { io } = require('socket.io-client');
const { BASE, dbq } = require('./helpers');

// Guest sessions, meeting passcodes and the durable lockout THROUGH the nginx HTTPS origin, against the containerised MAIN and its PostgreSQL
// lockout store. (At the previous certified SHA these flows were only exercised against standalone MAIN over HTTP.)
const MAIN = (process.env.E2E_DB_CONTAINER || '').replace('main-db', 'workspace-signaling-engine');
const api = () => pwRequest.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, extraHTTPHeaders: { origin: BASE } });
const create = async (a, body = {}) => { const j = await (await a.post('/api/meetings/create', { data: { topic: 'HTTPS flow', hostId: 'usr_e2e', ...body } })).json(); return { id: j.meeting.meetingId, hostKey: j.hostKey, body: j }; };
const session = (a, id, extra = {}) => a.post('/api/guest/sessions', { data: { meetingId: id, displayName: 'E2E Guest', ...extra } });
const sockCookie = async (a) => (await a.storageState()).cookies.map((c) => c.name + '=' + c.value).join('; ');
const sock = (cookie) => io(BASE, { transports: ['websocket'], forceNew: true, rejectUnauthorized: false, extraHeaders: cookie ? { cookie } : {} });
const waitHealthy = async () => { for (let i = 0; i < 60; i++) { try { const r = await (await pwRequest.newContext({ ignoreHTTPSErrors: true })).get(BASE + '/api/health'); if (r.ok()) return; } catch (e) { /* restarting */ } await new Promise((r) => setTimeout(r, 1000)); } throw new Error('MAIN did not come back'); };

test.describe('guest access through the HTTPS origin', () => {
  test('Welcome -> Join -> Pre-Join -> meeting over HTTPS; the guest cookie is Secure, HttpOnly and SameSite=Strict', async ({ browser }) => {
    test.setTimeout(120000);
    const a = await api(); const m = await create(a);
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE, permissions: ['camera', 'microphone'] }); const page = await ctx.newPage();
    await page.goto('/guest/welcome'); await expect(page.getByRole('heading', { name: 'Welcome to Qorlla' })).toBeVisible();
    await page.getByRole('link', { name: /Join Meeting/ }).first().click(); await page.fill('#mid', m.id); await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).toHaveURL(/\/prejoin$/); await page.fill('#pjName', 'HTTPS Guest'); await expect(page.locator('#pjGo')).toBeEnabled(); await page.click('#pjGo');
    await expect(page).toHaveURL(/\/index\.html\?meeting=/);
    const cookie = (await ctx.cookies()).find((c) => c.name === 'qorlla_guest'); expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict' }); expect(cookie.secure).toBe(true);
    await ctx.close();
  });

  test('direct URL and WebSocket bypass attempts fail: no session, wrong-meeting session, and a passcode field on the socket', async () => {
    const a = await api(); const m = await create(a, { passcode: 'https-code' }); const other = await create(a);
    const none = sock(); await new Promise((r) => none.once('connect', r)); let d = new Promise((r) => none.once('error_response', r)); none.emit('join_room', { meetingId: m.id, userName: 'x' }); expect((await d).code).toBe('guest_session_required');
    const g = await api(); expect((await session(g, other.id)).status()).toBe(201);                                     // a valid session for a DIFFERENT meeting
    const s = sock(await sockCookie(g)); await new Promise((r) => s.once('connect', r)); d = new Promise((r) => s.once('error_response', r)); s.emit('join_room', { meetingId: m.id, userName: 'x', passcode: 'https-code' }); expect((await d).code).toBe('guest_session_required');
    expect((await session(await api(), m.id)).status()).toBe(403);                                                       // REST needs the passcode too
    none.close(); s.close();
  });
});

test.describe('durable passcode lockout in PostgreSQL', () => {
  test('five failures lock the meeting; the lock is stored in PostgreSQL and survives a MAIN container restart; the host can lift it', async () => {
    test.setTimeout(240000);
    const a = await api(); const m = await create(a, { passcode: 'pg-code-1234' }); const g = await api();
    for (let i = 0; i < 4; i++) expect((await session(g, m.id, { passcode: 'wrong' + i })).status()).toBe(403);
    expect(dbq(`SELECT failed_attempts FROM public.meeting_passcode_attempts WHERE meeting_id='${m.id}'`)).toBe('4');
    expect((await session(g, m.id, { passcode: 'wrong5' })).status()).toBe(429);
    expect(dbq(`SELECT (locked_until > now())::text FROM public.meeting_passcode_attempts WHERE meeting_id='${m.id}'`)).toBe('true');
    expect(dbq(`SELECT kind FROM public.meeting_passcode_events WHERE meeting_id='${m.id}'`)).toBe('locked');
    await new Promise((r) => setTimeout(r, 1200));                                                                        // let MAIN persist the meeting snapshot
    execFileSync('docker', ['restart', MAIN], { stdio: 'ignore' }); await waitHealthy();
    const after = await api(); const refused = await session(after, m.id, { passcode: 'pg-code-1234' });
    expect(refused.status()).toBe(429);                                                                                   // a correct passcode is still refused after the restart
    const host = await api(); expect((await session(host, m.id, { hostKey: m.hostKey })).status()).toBe(201);
    expect((await (await host.get(`/api/meetings/${encodeURIComponent(m.id)}/passcode-security`)).json()).locked).toBe(true);
    const lifted = await host.post(`/api/meetings/${encodeURIComponent(m.id)}/passcode-lockout/clear`, { data: {} }); expect(lifted.status()).toBe(200); expect(await lifted.text()).not.toContain('pg-code-1234');
    expect(dbq(`SELECT kind FROM public.meeting_passcode_events WHERE meeting_id='${m.id}' ORDER BY id`).split('\n')).toEqual(['locked', 'cleared_by_host']);
    expect((await session(after, m.id, { passcode: 'pg-code-1234' })).status()).toBe(201);
  });

  test('the application role can only do what the lockout needs (no DELETE, no DDL) and the passcode never reaches the database', async () => {
    const a = await api(); const m = await create(a, { passcode: 'never-in-db-77' }); await session(await api(), m.id, { passcode: 'never-in-db-77' });
    expect(dbq(`SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) FROM information_schema.role_table_grants WHERE grantee='qorlla_app' AND table_name='meeting_passcode_attempts'`)).toBe('INSERT,SELECT,UPDATE');
    expect(dbq(`SELECT count(*) FROM public.meeting_passcode_events WHERE actor LIKE '%never-in-db-77%'`)).toBe('0');
  });
});
