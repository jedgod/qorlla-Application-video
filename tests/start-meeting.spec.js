const { test, expect } = require('@playwright/test');
const { MEET, startMain, organiser, login } = require('./support/meet-stack');

// v4.0.2b secure pre-meeting experience: server-provided facts, opt-in device checks, admission policy that the SERVER (Meet) enforces, safe Start (no duplicates,
// retry keeps the form), accessible dialog. Real Workplace server (5291) + real Meet (3310: node scripts/start-recording-test-meet.cjs) + real fake-device Chromium.
let main, MAIN;
test.describe.configure({ mode: 'serial' });
test.use({ permissions: ['camera', 'microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });
test.beforeAll(async () => { main = await startMain(5291); MAIN = main.base; });
test.afterAll(() => main && main.stop());

const openStart = async (page, title = 'Sprint planning') => {
  await page.goto(MAIN + '/qorlla.html#home'); await page.locator('.meeting', { hasText: title }).locator('.join-pill').click();
  await expect(page.locator('#startDialog')).toBeVisible(); await expect(page.locator('#sdPassNote')).not.toHaveText('Checking…');
};
const api = (ctx, method, path, data) => ctx.request[method](MAIN + path, data === undefined ? {} : { data });
// organiser starts through the API and opens Meet as host in a page
async function hostIn(browser, ctx, item, settings = {}) {
  const r = await api(ctx, 'post', '/api/meetings/' + encodeURIComponent(item.meetingId) + '/start', { name: 'Stryker', ...settings }); expect(r.status()).toBe(200);
  const p = await ctx.newPage(); await p.goto((await r.json()).url); await expect(p.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 }); return p;
}
const prejoin = async (browser, item, name) => {
  const gc = await browser.newContext({ permissions: ['camera', 'microphone'] }); const gp = await gc.newPage();
  await gp.goto(MAIN + '/guest/meeting/' + encodeURIComponent(item.meetingId) + '/prejoin'); await gp.fill('#pjName', name); await expect(gp.locator('#pjGo')).toBeEnabled(); await gp.click('#pjGo'); return { gc, gp };
};

test('server API contracts: preflight, invitation, settings, start - host only, validated, v1 mirrors, never a password back', async ({ browser }) => {
  const oc = await browser.newContext(); const { item } = await organiser(oc, MAIN); const id = encodeURIComponent(item.meetingId);
  for (const base of ['/api/meetings/', '/api/v1/meetings/']) {
    const pf = await api(oc, 'get', base + id + '/preflight'); expect(pf.status()).toBe(200); const p = await pf.json();
    expect(p).toMatchObject({ meetingId: item.meetingId, title: 'Sprint planning', kind: 'scheduled', passcodeRequired: false, explicit: false }); expect(p.settings).toEqual({ waitingRoom: true, joinBeforeHost: false, lockAfterJoin: false });
    expect(p.meet.reachable).toBe(true); expect(p.meet.ms).toBeGreaterThanOrEqual(0); expect(JSON.stringify(p)).not.toMatch(/hostSecret|passcodeHash/);
    const inv = await (await api(oc, 'get', base + id + '/invitation')).json(); expect(inv.url).toBe(MAIN + '/guest/meeting/' + id + '/prejoin'); expect(inv.id).toBe(item.meetingId);
  }
  const bad = [{ waitingRoom: 'yes' }, { title: '   ' }, { password: 'abc' }, { password: 'x'.repeat(40) }];
  for (const b of bad) expect((await api(oc, 'patch', '/api/meetings/' + id + '/settings', b)).status(), JSON.stringify(b)).toBe(400);
  const ok = await (await api(oc, 'patch', '/api/meetings/' + id + '/settings', { title: 'Renamed', waitingRoom: false, joinBeforeHost: true, lockAfterJoin: true, password: 'correct-horse' })).json();
  expect(ok).toMatchObject({ title: 'Renamed', passcodeRequired: true, settings: { waitingRoom: false, joinBeforeHost: true, lockAfterJoin: true } }); expect(JSON.stringify(ok)).not.toContain('correct-horse');
  expect((await (await api(oc, 'get', '/api/meetings/' + id + '/preflight')).json()).explicit).toBe(true);
  // everyone else is refused, signed out or not
  const other = await browser.newContext(); await other.request.post(MAIN + '/api/auth/register', { data: { username: 'oth' + Math.random().toString(36).slice(2, 7), displayName: 'Other', password: 'Handoff-pass-9917!x' } });
  const anon = await browser.newContext();
  for (const [m, p] of [['get', '/preflight'], ['get', '/invitation'], ['patch', '/settings'], ['post', '/start']]) { expect((await api(other, m, '/api/meetings/' + id + p, {})).status()).toBe(403); expect((await api(anon, m, '/api/meetings/' + id + p, {})).status()).toBe(401); }
  for (const c of [oc, other, anon]) await c.close();
});

test('nothing is captured until asked; the preview, device lists, meter, speaker test and readiness checks work; closing releases the devices', async ({ page, context }) => {
  test.setTimeout(90000);
  await organiser(context, MAIN);
  await page.addInitScript(() => { window.__gum = 0; const o = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = (c) => { window.__gum++; return o(c).then((s) => { (window.__streams = window.__streams || []).push(s); return s; }); }; });
  await openStart(page);
  expect(await page.evaluate(() => window.__gum)).toBe(0); await expect(page.locator('#sdVideo')).toBeHidden(); await expect(page.locator('#sdNet [data-k=cam] b')).toHaveText('Not tested'); await expect(page.locator('#sdNet [data-k=meet] b')).toContainText('Ready');   // opening the screen opened no device
  await page.check('#sdPreview'); await expect(page.locator('#sdVideo')).toBeVisible(); expect(await page.evaluate(() => window.__gum)).toBe(1);
  await expect(page.locator('#sdNet [data-k=cam] b')).toHaveText('Working'); await expect(page.locator('#sdNet [data-k=mic] b')).toHaveText('Working');
  expect(await page.locator('#sdVideo').evaluate((v) => new Promise((ok) => { const t = () => (v.videoWidth > 0 ? ok(true) : setTimeout(t, 100)); t(); }))).toBe(true);
  await expect(page.locator('#sdCamSel')).toBeEnabled(); await expect(page.locator('#sdMicSel')).toBeEnabled(); expect(await page.locator('#sdCamSel option').count()).toBeGreaterThan(0);
  await expect.poll(async () => parseFloat(await page.locator('#sdMeter').evaluate((e) => e.style.width) || '0'), { timeout: 10000 }).toBeGreaterThan(0);                             // the fake microphone produces a signal
  await page.selectOption('#sdMicSel', { index: 0 }); await page.waitForTimeout(400); expect(await page.evaluate(() => window.__gum)).toBeGreaterThanOrEqual(2);              // choosing a device re-opens with it
  const played = await page.evaluate(() => new Promise((ok) => { const P = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { ok(true); return P.call(this); }; document.getElementById('sdSpkTest').click(); setTimeout(() => ok(false), 3000); })); expect(played).toBe(true);
  // closing (Escape) stops every track
  await page.keyboard.press('Escape'); await expect(page.locator('#startDialog')).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window.__streams || []).every((s) => s.getTracks().every((t) => t.readyState === 'ended'))), { timeout: 5000 }).toBe(true);   // the dialog's close event runs a moment after it disappears
});

test('the form: required fields, password show/generate, copy, security options collapse on phones, labelled and keyboard operable', async ({ page, context }) => {
  await organiser(context, MAIN); await openStart(page);
  const dlg = page.locator('#startDialog'); await expect(dlg).toHaveAttribute('aria-labelledby', 'sdTitle');
  for (const sel of ['#sdTitleIn', '#sdPass', '#sdName', '#sdLink', '#sdCamSel', '#sdMicSel']) expect(await page.locator(sel).evaluate((e) => !!(e.labels && e.labels.length) || !!e.getAttribute('aria-label')), sel).toBe(true);
  expect(await page.evaluate(() => document.activeElement.id)).toBe('sdTitleIn');                                                                                  // focus moves into the dialog
  await page.fill('#sdTitleIn', ''); await page.click('#sdGo'); await expect(page.locator('#sdErr')).toHaveText('Give the meeting a title.'); await page.fill('#sdTitleIn', 'Roadmap');
  await page.fill('#sdName', ''); await page.click('#sdGo'); await expect(page.locator('#sdErr')).toHaveText('Enter your display name.'); await page.fill('#sdName', 'stryker');
  await page.fill('#sdPass', 'abc'); await page.click('#sdGo'); await expect(page.locator('#sdErr')).toContainText('6 to 32');
  await expect(page.locator('#sdPass')).toHaveAttribute('type', 'password'); await page.click('#sdPassToggle'); await expect(page.locator('#sdPass')).toHaveAttribute('type', 'text'); await expect(page.locator('#sdPassToggle')).toHaveAttribute('aria-pressed', 'true');
  await page.click('#sdPassGen'); expect((await page.inputValue('#sdPass')).length).toBe(10);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']); await page.click('#sdCopyInvite'); const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('Roadmap'); expect(text).toContain('Meeting ID:'); expect(text).toContain('/guest/meeting/'); expect(text).toContain('Password: ' + (await page.inputValue('#sdPass')));
  expect(await page.locator('#sdLink').inputValue()).not.toContain('?'); expect(await page.locator('#sdLink').inputValue()).not.toContain(await page.inputValue('#sdPass'));          // never in the link
  await expect(page.locator('#sdSec')).toHaveAttribute('open', ''); await page.keyboard.press('Escape'); await expect(dlg).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.meeting', { hasText: 'Sprint planning' }).locator('.join-pill').click(); await expect(dlg).toBeVisible();
  expect(await page.locator('#sdSec').evaluate((e) => e.open)).toBe(false);                                                                                         // advanced options start collapsed
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.getElementById('startDialog').scrollWidth <= document.getElementById('startDialog').clientWidth + 1)).toBe(true);
});

test('Start is safe: one click = one start; a failure keeps every entry and offers Retry; the title, password and policy are applied by the server', async ({ page, context }) => {
  test.setTimeout(90000);
  const { item } = await organiser(context, MAIN); await openStart(page);
  let calls = 0, fail = true;
  await page.route('**/api/meetings/*/start', async (route) => { calls++; if (fail) { await new Promise((r) => setTimeout(r, 600)); return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary failure' }) }); } return route.continue(); });
  await page.fill('#sdTitleIn', 'Quarterly review'); await page.fill('#sdName', 'stryker'); await page.fill('#sdPass', 'secret-pass-1'); await page.uncheck('#sdWait'); await page.check('#sdLock');
  await page.dblclick('#sdGo'); await expect(page.locator('#sdErr')).toHaveText('Temporary failure'); expect(calls).toBe(1);                                           // a double click sent ONE request
  await expect(page.locator('#sdGo')).toHaveText('Retry start'); await expect(page.locator('#sdTitleIn')).toHaveValue('Quarterly review'); await expect(page.locator('#sdPass')).toHaveValue('secret-pass-1'); await expect(page.locator('#sdLock')).toBeChecked();   // nothing was lost
  fail = false; await page.click('#sdGo'); await page.waitForURL(/localhost:3310/); await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 });
  await expect(page.locator('#roomTitle')).toHaveText('Quarterly review');                                                                                          // the new title reached Meet
  const pf = await (await api(context, 'get', '/api/meetings/' + encodeURIComponent(item.meetingId) + '/preflight')).json(); expect(pf).toMatchObject({ title: 'Quarterly review', passcodeRequired: true, explicit: true, settings: { waitingRoom: false, lockAfterJoin: true } });
  // idempotency: the same request id returns the same answer (no second start)
  const a = await api(context, 'post', '/api/meetings/' + encodeURIComponent(item.meetingId) + '/start', { requestId: 'same-1', name: 'S' }), b = await api(context, 'post', '/api/meetings/' + encodeURIComponent(item.meetingId) + '/start', { requestId: 'same-1', name: 'S' });
  expect((await a.json()).url).toBe((await b.json()).url);
});

test('the waiting room is enforced by Meet: guests wait, see nothing, are admitted or denied one by one; the host is told', async ({ browser }) => {
  test.setTimeout(150000);
  const oc = await browser.newContext({ permissions: ['camera', 'microphone'] }); const { item } = await organiser(oc, MAIN);
  const hp = await hostIn(browser, oc, item, { waitingRoom: true, joinBeforeHost: false });                                                                           // waiting room ON
  await hp.click('[data-tab=people]');
  const { gc, gp } = await prejoin(browser, item, 'Gail'); await gp.waitForURL(/localhost:3310/); await expect(gp.locator('#waiting')).toBeVisible({ timeout: 20000 }); await expect(gp.locator('#waitingMsg')).toContainText('let you in');
  await expect(gp.locator('#app')).toHaveClass(/hidden/); await expect(gp.locator('#liveBadge')).toBeHidden();                                                      // sees nothing of the meeting
  // the server refuses a waiting guest on every meeting route
  const sess = await gp.evaluate(() => JSON.parse(sessionStorage.getItem('qorlla-session'))); const meetId = sess.meetingId;
  const code = async (path, init = {}) => (await fetch(MEET + path, { ...init, headers: { Authorization: 'Bearer ' + sess.token, 'Content-Type': 'application/json' } })).status;
  expect(await code('/api/meetings/' + meetId)).toBe(403); expect(await code('/api/v1/meetings/' + meetId + '/notes')).toBe(403); expect(await code('/api/meetings/' + meetId + '/waiting')).toBe(403); expect(await code('/api/meetings/' + meetId + '/admit', { method: 'POST', body: JSON.stringify({ all: true }) })).toBe(403);
  expect(await code('/api/meetings/' + meetId + '/admission')).toBe(200);
  // the host sees and announces the waiting guest; a guest cannot admit themselves
  await expect(hp.locator('#waitingBox')).toContainText('Gail'); await expect(hp.locator('[data-tab=people]')).toContainText('1 waiting'); await expect(hp.locator('#announcer')).toContainText('Gail is waiting');
  await expect(hp.locator('.tile')).toHaveCount(1);
  await hp.getByRole('button', { name: 'Admit Gail' }).click(); await expect(gp.locator('#app')).not.toHaveClass(/hidden/, { timeout: 20000 }); await expect(hp.locator('.tile')).toHaveCount(2, { timeout: 30000 });
  await expect(hp.locator('#waitingBox')).toBeHidden();
  // a second guest is denied
  const g2 = await prejoin(browser, item, 'Dan'); await g2.gp.waitForURL(/localhost:3310/); await expect(g2.gp.locator('#waiting')).toBeVisible({ timeout: 20000 });
  await hp.getByRole('button', { name: 'Deny Dan' }).click(); await expect(g2.gp.locator('#landingError')).toContainText('did not let you in', { timeout: 20000 }); await expect(hp.locator('.tile')).toHaveCount(2);
  // the host can switch it off in the meeting: the next guest walks straight in
  await hp.click('[data-tab=more]'); await hp.locator('.mg-h', { hasText: 'Meeting management' }).click(); await hp.getByLabel(/Waiting room/).uncheck();
  const g3 = await prejoin(browser, item, 'Eve'); await g3.gp.waitForURL(/localhost:3310/); await expect(g3.gp.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 });
  for (const c of [oc, gc, g2.gc, g3.gc]) await c.close();
});

test('join-before-host off: guests wait for the host and are let in when the host arrives; lock-on-join refuses later arrivals', async ({ browser }) => {
  test.setTimeout(150000);
  const oc = await browser.newContext({ permissions: ['camera', 'microphone'] }); const { item } = await organiser(oc, MAIN);
  // set the policy first (no waiting room, no join-before-host, lock when I join) without opening the meeting yet
  expect((await api(oc, 'patch', '/api/meetings/' + encodeURIComponent(item.meetingId) + '/settings', { waitingRoom: false, joinBeforeHost: false, lockAfterJoin: true })).status()).toBe(200);
  // register with Meet (an invitee arriving first is what triggers it) - the guest arrives BEFORE the host
  const { gc, gp } = await prejoin(browser, item, 'Early Ed'); await gp.waitForURL(/localhost:3310/); await expect(gp.locator('#waiting')).toBeVisible({ timeout: 20000 }); await expect(gp.locator('#waitingMsg')).toContainText('host to start');
  const hp = await hostIn(browser, oc, item, { waitingRoom: false, joinBeforeHost: false, lockAfterJoin: true });
  await expect(gp.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 });                                                                                      // admitted automatically when the host arrived
  await expect(hp.locator('.tile')).toHaveCount(2, { timeout: 30000 });
  // the meeting locked itself when the host joined: a latecomer is refused with a clear message and does NOT fall into the old built-in room
  await expect.poll(async () => (await (await fetch(MEET + '/api/meetings/' + (await gp.evaluate(() => JSON.parse(sessionStorage.getItem('qorlla-session')).meetingId)) + '/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }) })).status), { timeout: 15000 }).toBe(403);
  const late = await browser.newContext(); const lp = await late.newPage(); await lp.goto(MAIN + '/guest/meeting/' + encodeURIComponent(item.meetingId) + '/prejoin'); await lp.fill('#pjName', 'Latecomer'); await expect(lp.locator('#pjGo')).toBeEnabled(); await lp.click('#pjGo');
  await expect(lp.locator('#pjMsg')).toContainText('locked'); expect(lp.url()).toContain('/prejoin'); expect(lp.url()).not.toContain('index.html');
  for (const c of [oc, gc, late]) await c.close();
});

test('if Meet is not available the waiting room is never silently dropped', async ({ browser }) => {
  test.setTimeout(60000);
  const oc = await browser.newContext(); const { item } = await organiser(oc, MAIN); const id = encodeURIComponent(item.meetingId);
  expect((await api(oc, 'patch', '/api/meetings/' + id + '/settings', { waitingRoom: true })).status()).toBe(200);
  // a separate Workplace server that cannot reach Meet
  const { spawn } = require('node:child_process'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qnomeet-')); const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore', env: { ...process.env, PORT: '5292', DATA_DIR: dir, MEET_DETECT: 'off', QORLLA_BRIDGE_SECRET: '' } });
  try {
    const base = 'http://localhost:5292'; for (let i = 0; i < 40; i++) { try { if ((await fetch(base + '/')).ok) break; } catch (e) { /* wait */ } await new Promise((r) => setTimeout(r, 400)); }
    const c = await browser.newContext(); const org = await organiser(c, base); const mid = encodeURIComponent(org.item.meetingId);
    const start = await c.request.post(base + '/api/meetings/' + mid + '/start', { data: { name: 'S', waitingRoom: true } }); expect(start.status()).toBe(409); const sb = await start.json(); expect(sb.mode).toBe('blocked'); expect(sb.error).toContain('waiting room');   // refuses instead of starting without it
    const off = await c.request.post(base + '/api/meetings/' + mid + '/start', { data: { name: 'S', waitingRoom: false } }); expect((await off.json()).mode).toBe('builtin');                                  // explicitly off: the basic room
    await c.request.patch(base + '/api/meetings/' + mid + '/settings', { data: { waitingRoom: true } });
    const guest = await browser.newContext(); const g = await guest.request.post(base + '/api/guest/sessions', { data: { meetingId: org.item.meetingId, displayName: 'Guest' } }); expect(g.status()).toBe(503);   // a guest is not let into the room that has no waiting room
    for (const x of [c, guest]) await x.close();
  } finally { try { child.kill(); } catch (e) { /* gone */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* busy */ } }
  await oc.close(); void login;
});

test('the start screen is compact and centred: it fits the window without scrolling on laptop and phone sizes', async ({ browser }) => {
  test.setTimeout(60000);
  for (const vp of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    const ctx = await browser.newContext({ viewport: vp }); await organiser(ctx, MAIN); const page = await ctx.newPage(); await openStart(page);
    const m = await page.evaluate(() => { const d = document.getElementById('startDialog'), r = d.getBoundingClientRect(); return { scrolls: d.scrollWidth > d.clientWidth + 1, inside: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1, offX: Math.abs(r.left + r.width / 2 - innerWidth / 2), offY: Math.abs(r.top + r.height / 2 - innerHeight / 2) }; });
    expect(m.scrolls, vp.width + 'x' + vp.height).toBe(false); expect(m.inside).toBe(true); expect(m.offX).toBeLessThan(3); expect(m.offY).toBeLessThan(3);
    await ctx.close();
  }
});

test('failed initialisation: the ID stays unconfirmed, Start is disabled, Retry recovers; footer buttons are always visible (desktop and phone)', async ({ browser }) => {
  test.setTimeout(90000);
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 700 } }); const { item } = await organiser(ctx, MAIN); const page = await ctx.newPage();
  let fails = 2; await page.route('**/api/meetings/*/preflight', (r) => (fails-- > 0 ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Database unavailable' }) }) : r.continue()));
  await page.goto(MAIN + '/qorlla.html#home'); await page.locator('.meeting', { hasText: 'Sprint planning' }).locator('.join-pill').click();
  await expect(page.locator('#sdErr')).toContainText('Database unavailable'); await expect(page.locator('#sdBadge')).toBeVisible(); await expect(page.locator('#sdGo')).toBeDisabled(); await expect(page.locator('#sdCopyInvite')).toBeDisabled(); await expect(page.locator('#sdLink')).toHaveValue('');
  await page.click('#sdRetry'); await expect(page.locator('#sdErr')).toContainText('Database unavailable'); await expect(page.locator('#sdGo')).toBeDisabled();
  await page.click('#sdRetry'); await expect(page.locator('#sdGo')).toBeEnabled(); await expect(page.locator('#sdId')).toHaveText(item.meetingId); await expect(page.locator('#sdBadge')).toBeHidden(); await expect(page.locator('#sdLink')).toHaveValue(/\/guest\/meeting\/.*\/prejoin/);
  for (const vp of [{ width: 1366, height: 600 }, { width: 390, height: 700 }]) {
    await page.setViewportSize(vp); const b = await page.locator('#sdGo').boundingBox(); expect(b.y + b.height).toBeLessThanOrEqual(vp.height); expect(b.y).toBeGreaterThan(0);
    await expect(page.locator('#sdCancel')).toBeInViewport(); await expect(page.locator('#sdGo')).toBeInViewport();
  }
  await ctx.close();
});

test('404 is explained: an old server (route missing) and an unknown meeting are told apart; neither enables Start', async ({ browser }) => {
  const ctx = await browser.newContext(); await organiser(ctx, MAIN); const page = await ctx.newPage();
  await page.route('**/api/meetings/*/preflight', (r) => r.fulfill({ status: 404, contentType: 'text/html', body: '<pre>Cannot GET</pre>' }));
  await page.goto(MAIN + '/qorlla.html#home'); await page.locator('.meeting', { hasText: 'Sprint planning' }).locator('.join-pill').click();
  await expect(page.locator('#sdErr')).toContainText('Route not found'); await expect(page.locator('#sdErr')).toContainText('older version'); await expect(page.locator('#sdGo')).toBeDisabled(); await expect(page.locator('#sdNet [data-k=net] b')).toHaveClass(/bad/);
  await page.unroute('**/api/meetings/*/preflight'); await page.route('**/api/meetings/*/preflight', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'This meeting is not available.' }) }));
  await page.click('#sdRetry'); await expect(page.locator('#sdErr')).toContainText('Meeting not found'); await expect(page.locator('#sdGo')).toBeDisabled();
  await page.unroute('**/api/meetings/*/preflight'); await page.click('#sdRetry'); await expect(page.locator('#sdGo')).toBeEnabled(); await expect(page.locator('#sdBadge')).toBeHidden();
  await ctx.close();
});

test('layout: wide camera preview (like the reference), device icons beside each selector, centred, no scroll bar on laptop sizes', async ({ browser }) => {
  test.setTimeout(60000);
  for (const vp of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }, { width: 1024, height: 700 }]) {
    const ctx = await browser.newContext({ viewport: vp }); await organiser(ctx, MAIN); const page = await ctx.newPage(); await openStart(page);
    const m = await page.evaluate(() => { const d = document.getElementById('startDialog').getBoundingClientRect(), b = document.querySelector('.sd-body'), p = document.querySelector('.sd-prev').getBoundingClientRect();
      const rows = [...document.querySelectorAll('.sd-dev')].map((r) => { const i = r.querySelector('.sd-di').getBoundingClientRect(), s = r.querySelector('select').getBoundingClientRect(); return i.right <= s.left + 1 && Math.abs(i.top + i.height / 2 - (s.top + s.height / 2)) < 4 && !!r.querySelector('.sd-di svg'); });
      return { scroll: b.scrollHeight - b.clientHeight, w: p.width, h: p.height, offX: Math.abs(d.left + d.width / 2 - innerWidth / 2), offY: Math.abs(d.top + d.height / 2 - innerHeight / 2), rows }; });
    expect(m.scroll, vp.width + 'x' + vp.height).toBeLessThanOrEqual(0); expect(m.w / m.h).toBeGreaterThan(1.5); expect(m.w).toBeGreaterThan(300); expect(m.offX).toBeLessThan(3); expect(m.offY).toBeLessThan(3); expect(m.rows).toEqual([true, true, true]);
    await ctx.close();
  }
});

test('devices are listed and selectable from the start; choosing one activates it, and the speaker choice plays the tone', async ({ page, context }) => {
  test.setTimeout(60000);
  await organiser(context, MAIN);
  await page.addInitScript(() => { window.__gum = []; const o = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = (c) => { window.__gum.push(JSON.stringify(c)); return o(c); }; });
  await openStart(page);
  await expect(page.locator('#sdCamSel')).toBeEnabled(); await expect(page.locator('#sdMicSel')).toBeEnabled(); expect(await page.locator('#sdCamSel option').count()).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__gum.length)).toBe(0);                                  // listing devices opens nothing
  await page.selectOption('#sdMicSel', { index: 0 }); await expect(page.locator('#sdVideo')).toBeVisible(); expect(await page.evaluate(() => window.__gum.length)).toBeGreaterThan(0);   // choosing activates it
  await expect(page.locator('#sdNet [data-k=mic] b')).toHaveText('Working'); await expect(page.locator('#sdSnap')).toBeEnabled();
  const before = await page.evaluate(() => window.__gum.length); await page.selectOption('#sdCamSel', { index: 0 }); await expect.poll(() => page.evaluate(() => window.__gum.length)).toBeGreaterThan(before);
  await page.keyboard.press('Escape');
});

test.describe('Join meeting screen', () => {
  const openJoin = async (page) => { await page.goto(MAIN + '/qorlla.html#home'); await page.locator('.action-btn[data-act="join"]').click(); await expect(page.locator('#startDialog')).toBeVisible(); };
  test('same screen as the design: ID, password with eye, name, Mic/Camera pills, preview tick, host-rules note, preview and device rows; no host-only parts', async ({ page, context }) => {
    await organiser(context, MAIN); await openJoin(page);
    await expect(page.locator('#sdTitle')).toHaveText('Join meeting'); await expect(page.locator('#sdMid')).toBeFocused(); await expect(page.locator('#sdMid')).toHaveAttribute('placeholder', '000 0000 0000');
    await expect(page.locator('#sdName')).toHaveValue('Stryker'); await expect(page.locator('#sdGo')).toHaveText('Join meeting'); await expect(page.locator('.sd-info')).toContainText('not consent to be recorded');
    for (const hidden of ['#sdTitleIn', '#sdId', '#sdLink', '#sdSec', '#sdReady', '#sdPassGen', '#sdCopyInvite']) await expect(page.locator(hidden)).toBeHidden();
    await expect(page.locator('#sdPassToggle')).toBeVisible(); await expect(page.locator('#sdPassNote')).toHaveText('Leave empty if no password is required.'); await expect(page.locator('#sdPreviewLab')).toHaveText('Preview my camera before joining');
    await expect(page.locator('#sdMidClear')).toBeHidden(); await page.fill('#sdMid', '123'); await expect(page.locator('#sdMidClear')).toBeVisible(); await page.click('#sdMidClear'); await expect(page.locator('#sdMid')).toHaveValue('');
    await expect(page.locator('.sd-prev')).toBeVisible(); expect(await page.locator('.sd-dev').count()).toBe(3);
    const m = await page.evaluate(() => { const d = document.getElementById('startDialog').getBoundingClientRect(), b = document.querySelector('.sd-body'); return { scroll: b.scrollHeight - b.clientHeight, inside: d.top >= 0 && d.bottom <= innerHeight }; }); expect(m.inside).toBe(true); expect(m.scroll).toBeLessThanOrEqual(0);
    await page.click('#sdCancel'); await expect(page.locator('#startDialog')).toBeHidden();
  });
  test('signed-in user: wrong password stays on the screen with an inline message; the right one joins', async ({ page, context, browser }) => {
    test.setTimeout(60000);
    const oc = await browser.newContext(); const { item } = await organiser(oc, MAIN); await oc.request.put(MAIN + '/api/meetings/' + encodeURIComponent(item.meetingId) + '/passcode', { data: { passcode: 'secret-door' } });
    await organiser(context, MAIN); await openJoin(page);
    await page.click('#sdGo'); await expect(page.locator('#sdErr')).toContainText('Enter the meeting ID');
    await page.fill('#sdMid', '000 0000 0000'); await page.click('#sdGo'); await expect(page.locator('#sdErr')).toContainText('Check the meeting ID and password'); await page.fill('#sdMid', '12345'); await page.click('#sdGo'); await expect(page.locator('#sdErr')).toContainText('11-digit');
    await page.fill('#sdMid', item.meetingId.replace(/ /g, '')); await page.click('#sdGo'); await expect(page.locator('#sdErr')).toContainText('needs a password'); await expect(page.locator('#sdPass')).toBeFocused();
    await page.fill('#sdPass', 'wrong-guess'); await page.click('#sdGo'); await expect(page.locator('#sdErr')).toContainText('Check the meeting ID and password'); await expect(page.locator('#startDialog')).toBeVisible();
    await page.fill('#sdPass', 'secret-door'); await page.click('#sdGo'); await expect(page).toHaveURL(/localhost:3310|\/index\.html\?start=join/);   // into the meeting: Meet when it is running, else the basic room
    await oc.close();
  });
});

test('join preview: the camera name sits over the preview, mirrors the Camera selector and updates when the device changes; no tracks leak', async ({ page, context }) => {
  test.setTimeout(60000);
  await organiser(context, MAIN); await page.addInitScript(() => { window.__streams = []; const o = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = (c) => o(c).then((s) => { window.__streams.push(s); return s; }); });
  await page.goto(MAIN + '/qorlla.html#home'); await page.locator('.action-btn[data-act="join"]').click(); await expect(page.locator('#sdPrevCam')).toBeVisible();
  await page.check('#sdPreview'); await expect(page.locator('#sdVideo')).toBeVisible(); await expect(page.locator('#sdPrevCam')).toBeEnabled();
  const same = await page.evaluate(() => { const a = document.getElementById('sdCamSel'), b = document.getElementById('sdPrevCam'); return JSON.stringify([...a.options].map((o) => o.textContent)) === JSON.stringify([...b.options].map((o) => o.textContent)) && a.selectedIndex === b.selectedIndex; }); expect(same).toBe(true);
  const box = await page.locator('#sdPrevCam').boundingBox(), prev = await page.locator('.sd-prev').boundingBox(); expect(box.x - prev.x).toBeLessThan(30); expect(prev.y + prev.height - (box.y + box.height)).toBeLessThan(30);   // bottom-left of the preview
  const n = await page.locator('#sdPrevCam option').count(); if (n > 1) { await page.selectOption('#sdPrevCam', { index: 1 }); await expect(page.locator('#sdCamSel')).toHaveValue(await page.locator('#sdPrevCam').inputValue()); }
  await page.selectOption('#sdCamSel', { index: 0 }); await expect.poll(() => page.evaluate(() => document.getElementById('sdPrevCam').selectedIndex)).toBe(0);
  await page.click('#sdCancel'); await expect.poll(() => page.evaluate(() => window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'))), { timeout: 5000 }).toBe(true);
});
