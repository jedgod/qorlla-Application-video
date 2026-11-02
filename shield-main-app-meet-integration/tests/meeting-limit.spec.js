const { test, expect } = require('@playwright/test');
const path = require('node:path');
const L = require('../meeting-limit');
const { startMain, organiser, ymd } = require('./support/meet-stack');

// Free-plan meeting limit: 30 minutes, reminders through a 10 minute grace period, then the meeting closes with
// "Upgrade to have full access to Qorlla packages". Paid (exempt) hosts are never interrupted.
// Browser tests run the real sequence on a 500 ms "minute" (15 s limit + 5 s grace) via MEETING_LIMIT_UNIT_MS. The Meet-hosted case needs a real Meet on :3310.
test.use({ permissions: ['camera', 'microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test.describe('rules', () => {
  test('defaults are 30 + 10 minutes with reminders at 30, 35 and 39 and the close at 40', () => {
    const c = L.config({}); expect(c.limitMs).toBe(30 * 60000); expect(c.graceMs).toBe(10 * 60000);
    expect(L.plan({ limitMs: c.limitMs, graceMs: c.graceMs }, c.unit).map((m) => [m.phase, m.at / 60000])).toEqual([['limit', 30], ['reminder', 35], ['final', 39], ['close', 40]]);
    expect(L.reminderText('close', 0)).toBe('Upgrade to have full access to Qorlla packages'); expect(L.reminderText('limit', 10 * 60000)).toContain('10 minutes'); expect(L.reminderText('final', 30000)).toContain('1 minute');
  });
  test('paid and listed hosts are exempt; the limit can be switched off; settings are validated', () => {
    const env = { MEETING_LIMIT_EXEMPT_USERS: 'boss, vip*' };
    expect(L.isExempt({ username: 'Boss' }, env)).toBe(true); expect(L.isExempt({ username: 'vip42' }, env)).toBe(true); expect(L.isExempt({ username: 'bossy' }, env)).toBe(false); expect(L.isExempt({ username: 'x', plan: 'Pro' }, env)).toBe(true); expect(L.isExempt({ username: 'x', plan: 'basic' }, env)).toBe(false); expect(L.isExempt(null, env)).toBe(false);
    expect(L.limitsFor(true, {})).toBeNull(); expect(L.limitsFor(false, { FREE_MEETING_LIMIT_MIN: '0' })).toBeNull(); expect(L.limitsFor(false, {})).toEqual({ limitMs: 1800000, graceMs: 600000 }); expect(L.config({ FREE_MEETING_LIMIT_MIN: 'abc' }).limitMs).toBe(1800000);
  });
  test('timers fire in order, close once, can be cancelled, and a late start only runs the newest missed step', async () => {
    const seen = []; const limits = { limitMs: 60, graceMs: 80 };
    const cancel = L.arm({ startedAt: Date.now(), limits, unit: 20, emit: (r) => seen.push(r.phase), close: () => seen.push('close') }); await new Promise((r) => setTimeout(r, 220)); expect(seen).toEqual(['limit', 'reminder', 'final', 'close']); cancel();
    const late = []; L.arm({ startedAt: Date.now() - 100, limits, unit: 20, emit: (r) => late.push(r.phase), close: () => late.push('close') }); await new Promise((r) => setTimeout(r, 120)); expect(late[0]).toBe('reminder'); expect(late).toContain('final');
    const over = []; L.arm({ startedAt: Date.now() - 500, limits, unit: 20, emit: (r) => over.push(r.phase), close: () => over.push('close') }); await new Promise((r) => setTimeout(r, 60)); expect(over).toEqual(['close']);
    const c2 = []; const stop = L.arm({ startedAt: Date.now(), limits, unit: 20, emit: (r) => c2.push(r.phase), close: () => c2.push('close') }); stop(); await new Promise((r) => setTimeout(r, 200)); expect(c2).toEqual([]);
  });
});

test.describe('free plan, built-in room and Meet-hosted meetings', () => {
  test.describe.configure({ mode: 'serial' });                  // one shared test server per describe: never split across workers
  let main; test.beforeAll(async () => { main = await startMain(5294, { MEETING_LIMIT_UNIT_MS: '500', MEETING_LIMIT_EXEMPT_USERS: 'vip*' }); }); test.afterAll(() => main && main.stop());
  const reg = async (ctx, username, name) => { const r = await ctx.request.post(main.base + '/api/auth/register', { data: { username, displayName: name, password: 'Limit-pass-9917!x' } }); expect(r.status()).toBe(201); };
  const sched = async (ctx, title) => (await (await ctx.request.post(main.base + '/api/workplace/schedule', { data: { title, date: ymd(new Date()), time: '23:00', duration: 30 } })).json());

  test('built-in room: reminders with Upgrade link, then the meeting closes with the upgrade message; it is history (time_limit) and cannot be rejoined', async ({ browser }) => {
    test.setTimeout(90000);
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] }); await reg(ctx, 'free' + Math.random().toString(36).slice(2, 7), 'Freeman'); const s = await sched(ctx, 'Free meeting');
    const page = await ctx.newPage(); page.on('dialog', (d) => d.accept()); await page.goto(main.base + '/index.html?start=join&meeting=' + encodeURIComponent(s.meetingId) + '&name=Freeman'); await expect(page.locator('#meetingBar')).toBeVisible();
    await page.waitForTimeout(4000); await expect(page.locator('#limitBanner')).toHaveCount(0);                                   // before the limit: nothing
    await expect(page.locator('#limitBanner')).toBeVisible({ timeout: 20000 }); await expect(page.locator('#limitText')).toContainText('free plan'); await expect(page.locator('#limitText')).toContainText('Upgrade'); await expect(page.locator('#limitUp')).toHaveAttribute('href', /\/pricing\?reason=meeting-limit/);
    await expect(page.locator('#meetingBar')).toBeVisible();                                                                       // still in the meeting during the grace period
    await expect(page.locator('#limitModal')).toBeVisible({ timeout: 20000 }); await expect(page.locator('#limitModal')).toContainText('Upgrade to have full access to Qorlla packages'); await expect(page.locator('#limitPlans')).toHaveAttribute('href', /\/pricing\?reason=meeting-limit/);
    await expect(page.locator('#meetingBar')).toBeHidden(); await expect(page.locator('#limitBanner')).toHaveCount(0);
    const b = (await (await ctx.request.get(main.base + '/api/history/meetings')).json()).meetings[0]; expect(b).toMatchObject({ title: 'Free meeting', status: 'completed', endReason: 'time_limit' }); expect(b.durationSeconds).toBeGreaterThanOrEqual(18); expect(b.durationSeconds).toBeLessThan(40);
    expect((await ctx.request.get(main.base + '/api/meetings/validate/' + encodeURIComponent(s.meetingId))).status()).toBe(404);   // cannot be joined again
    await page.click('#limitClose'); await expect(page.locator('#limitModal')).toHaveCount(0); await ctx.close();
  });

  test('a paid (exempt) host is never interrupted: no banner, no closing, well past the limit', async ({ browser }) => {
    test.setTimeout(60000);
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] }); await reg(ctx, 'vip' + Math.random().toString(36).slice(2, 7), 'Vip'); const s = await sched(ctx, 'Paid meeting');
    const page = await ctx.newPage(); await page.goto(main.base + '/index.html?start=join&meeting=' + encodeURIComponent(s.meetingId) + '&name=Vip'); await expect(page.locator('#meetingBar')).toBeVisible();
    await page.waitForTimeout(24000); await expect(page.locator('#meetingBar')).toBeVisible(); await expect(page.locator('#limitBanner')).toHaveCount(0); await expect(page.locator('#limitModal')).toHaveCount(0);
    expect((await ctx.request.get(main.base + '/api/meetings/validate/' + encodeURIComponent(s.meetingId))).status()).toBe(200); await ctx.close();
  });

  test('Meet-hosted: everyone in the room gets the reminder, then the meeting is closed for all with the upgrade message; history says time_limit', async ({ browser }) => {
    test.setTimeout(120000);
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] }); const { item } = await organiser(ctx, main.base, { name: 'Freeman', title: 'Free Meet room' });
    const st = await ctx.request.post(main.base + '/api/meetings/' + encodeURIComponent(item.meetingId) + '/start', { data: { waitingRoom: false, name: 'Freeman' } }); expect(st.status()).toBe(200);
    const hp = await ctx.newPage(); await hp.goto((await st.json()).url); await expect(hp.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 });
    const gc = await browser.newContext({ permissions: ['camera', 'microphone'] }); const gs = await gc.request.post(main.base + '/api/guest/sessions', { data: { meetingId: item.meetingId, displayName: 'Gail' } }); expect(gs.status()).toBe(201);
    const gp = await gc.newPage(); await gp.goto((await gs.json()).meet.url); await expect(gp.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 });
    for (const p of [hp, gp]) { await expect(p.locator('#limitBanner')).toBeVisible({ timeout: 40000 }); await expect(p.locator('#limitText')).toContainText('free plan'); await expect(p.locator('#limitUp')).toHaveAttribute('href', /pricing\?reason=meeting-limit/); }
    for (const p of [hp, gp]) { await expect(p.locator('#rcModal')).toContainText('Upgrade to have full access to Qorlla packages', { timeout: 30000 }); await expect(p.locator('#limitPlans')).toBeVisible(); await expect(p.locator('#limitBanner')).toHaveCount(0); }
    await expect.poll(async () => (await (await ctx.request.get(main.base + '/api/history/meetings')).json()).meetings[0]?.endReason, { timeout: 30000, intervals: [1000] }).toBe('time_limit');
    const b = (await (await ctx.request.get(main.base + '/api/history/meetings')).json()).meetings[0]; expect(b).toMatchObject({ title: 'Free Meet room', status: 'completed', uniqueAttendeeCount: 2 });
    expect((await ctx.request.post(main.base + '/api/meetings/' + encodeURIComponent(item.meetingId) + '/start', { data: {} })).status()).toBe(404);   // cannot be restarted
    expect((await gc.request.post(main.base + '/api/guest/sessions', { data: { meetingId: item.meetingId, displayName: 'Late' } })).status()).toBe(404);
    for (const c of [ctx, gc]) await c.close();
  });
});

test('pricing page: the limit warning is hidden normally and shown, with the upgrade wording, when you arrive from a closed meeting', async ({ page }) => {
  const file = 'file:///' + path.resolve(__dirname, '..', 'Web_qorlla-pricing', 'index.html').replace(/\\/g, '/');
  await page.goto(file); await expect(page.locator('#limitWarning')).toBeHidden();
  await page.goto(file + '?reason=meeting-limit'); await expect(page.locator('#limitWarning')).toBeVisible(); await expect(page.locator('#limitWarning')).toContainText('Upgrade to have full access to Qorlla packages'); await expect(page.locator('#limitWarning')).toHaveAttribute('role', 'alert');
});
