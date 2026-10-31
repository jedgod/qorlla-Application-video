const { test, expect } = require('@playwright/test');
const MEET_URL = new RegExp('localhost:' + (process.env.MEET_TEST_PORT || 3310));   // MEET_TEST_PORT: the isolated test Meet's port
const { MEET, startMain, organiser } = require('./support/meet-stack');

// Scheduled meetings: the organiser sees START (not Join) and goes straight into the current Meet video page as host, with the meeting ID and password shown first;
// invited guests JOIN through the pre-join page and land in the same current Meet page (never the old built-in room).
// Runs its own Workplace server (port 5290) against a REAL Qorlla Meet on 3310 (node scripts/start-recording-test-meet.cjs).
let main, MAIN;
test.describe.configure({ mode: 'serial' });
const FF = !!process.env.E2E_FIREFOX, PERM = FF ? [] : ['camera', 'microphone'];   // Firefox: fake devices come from the project's preferences
test.use(FF ? {} : { permissions: PERM, launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });
test.beforeAll(async () => { main = await startMain(5290); MAIN = main.base; });
test.afterAll(() => main && main.stop());

test('the organiser sees Start (never Join) on Home, Schedule and the menu', async ({ page, context }) => {
  await organiser(context, MAIN);
  await page.goto(MAIN + '/qorlla.html#home'); const card = page.locator('.meeting', { hasText: 'Sprint planning' }); await expect(card).toBeVisible();
  await expect(card.locator('.join-pill')).toHaveText('Start');
  await page.goto(MAIN + '/qorlla.html#schedule'); await page.reload();
  await expect(page.getByRole('button', { name: 'Start', exact: true }).first()).toBeVisible(); await expect(page.getByRole('button', { name: 'Join', exact: true })).toHaveCount(0);
});

test('Start shows the meeting ID and password, then goes straight into the Meet video page as host (no landing page, no secrets left in the address bar)', async ({ page, context }) => {
  test.setTimeout(90000);
  const { item } = await organiser(context, MAIN);
  await page.goto(MAIN + '/qorlla.html#home'); await page.locator('.meeting', { hasText: 'Sprint planning' }).locator('.join-pill').click();
  await expect(page.locator('#startDialog')).toBeVisible(); await expect(page.locator('#sdPassNote')).not.toHaveText('Checking…'); await expect(page.locator('#sdTitle')).toContainText('Start meeting'); await expect(page.locator('#sdId')).toHaveText(item.meetingId);
  await expect(page.locator('#sdPassNote')).toContainText('No password');
  await page.click('#sdPassGen'); await expect(page.locator('#sdPass')).toHaveValue(/^[A-Za-z0-9]{10}$/);
  await page.click('#sdWait'); await page.click('#sdGo');                                                                                         // waiting room off: this test is about the hand-off itself
  await page.waitForURL(MEET_URL); await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 });                       // the meeting itself, not the landing page
  await expect(page.locator('#landing')).toBeHidden(); await expect(page.locator('#endBtn')).toBeVisible();                                        // host controls: the organiser is the host
  await expect(page.locator('#roomTitle')).toHaveText('Sprint planning'); await expect(page.locator('#roomId')).toHaveText(item.meetingId);       // the same ID the pre-join page shows
  expect(page.url()).not.toContain('qs='); expect(page.url()).not.toContain('token'); await expect(page.locator('#panelToggle')).toBeVisible();    // current video page
  const stored = await page.evaluate(() => JSON.stringify(sessionStorage) + JSON.stringify(localStorage)); expect(stored).not.toMatch(/hostSecret/i);
});

test('an invited guest joins through the pre-join page, needs the password, and lands in the SAME current Meet page', async ({ browser, context }) => {
  test.setTimeout(120000);
  const oc = await browser.newContext({ permissions: PERM }); const op = await oc.newPage(); const { item } = await organiser(oc, MAIN);
  await op.goto(MAIN + '/qorlla.html#home'); await op.locator('.meeting', { hasText: 'Sprint planning' }).locator('.join-pill').click(); await expect(op.locator('#sdPassNote')).not.toHaveText('Checking…');
  await op.click('#sdPassGen'); const password = await op.inputValue('#sdPass'); await op.click('#sdWait'); await op.click('#sdGo'); await op.waitForURL(MEET_URL); await expect(op.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 });
  const g = await browser.newContext({ permissions: PERM }); const gp = await g.newPage();
  await gp.goto(MAIN + '/guest/meeting/' + encodeURIComponent(item.meetingId) + '/prejoin'); await expect(gp.locator('#pjTopic')).toContainText('Sprint planning'); await expect(gp.locator('#pjPassWrap')).toBeVisible();
  await gp.fill('#pjName', 'Guest Gail'); await gp.fill('#pjPass', 'definitely-wrong'); await gp.click('#pjGo'); await expect(gp.locator('#pjMsg')).toContainText('Incorrect passcode'); expect(gp.url()).toContain('/prejoin');
  await gp.fill('#pjPass', password); await gp.click('#pjGo');
  await gp.waitForURL(MEET_URL); await expect(gp.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 }); await expect(gp.locator('#endBtn')).toBeHidden();   // a guest, not a host
  await expect(gp.locator('#panelToggle')).toBeVisible(); await expect(gp.locator('#liveBadge')).toBeVisible(); await expect(gp.locator('#roomId')).toHaveText(item.meetingId);   // the new video page
  expect(gp.url()).not.toContain('qs=');
  for (const c of [oc, g]) await c.close();
});

test('host and guest meet in the same room; the ID cannot be used to bypass the password directly in Meet; only the organiser can launch', async ({ browser }) => {
  test.setTimeout(150000);
  const oc = await browser.newContext({ permissions: PERM }); const op = await oc.newPage(); const { item } = await organiser(oc, MAIN);
  await op.goto(MAIN + '/qorlla.html#home'); await op.locator('.meeting', { hasText: 'Sprint planning' }).locator('.join-pill').click(); await expect(op.locator('#sdPassNote')).not.toHaveText('Checking…'); await op.click('#sdWait'); await op.click('#sdGo');
  await op.waitForURL(MEET_URL); await expect(op.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 });
  const gc = await browser.newContext({ permissions: PERM }); const gp = await gc.newPage();
  await gp.goto(MAIN + '/guest/meeting/' + encodeURIComponent(item.meetingId) + '/prejoin'); await gp.fill('#pjName', 'Guest Gus'); await expect(gp.locator('#pjGo')).toBeEnabled(); await gp.click('#pjGo');
  await gp.waitForURL(MEET_URL); await expect(gp.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 });
  await expect(op.locator('.tile')).toHaveCount(2, { timeout: 30000 }); await expect(gp.locator('.tile')).toHaveCount(2, { timeout: 30000 });
  const direct = await fetch(MEET + '/api/meetings/' + encodeURIComponent(item.meetingId.replace(/\D/g, '')) + '/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sneaky' }) }); expect(direct.status).toBe(403);
  const other = await browser.newContext(); await other.request.post(MAIN + '/api/auth/register', { data: { username: 'oth' + Math.random().toString(36).slice(2, 7), displayName: 'Other', password: 'Handoff-pass-9917!x' } });
  const id = encodeURIComponent(item.meetingId);
  expect((await other.request.post(MAIN + '/api/meetings/' + id + '/start', { data: {} })).status()).toBe(403);
  expect((await (await browser.newContext()).request.post(MAIN + '/api/meetings/' + id + '/start', { data: {} })).status()).toBe(401);
  expect((await other.request.put(MAIN + '/api/meetings/' + id + '/passcode', { data: { passcode: 'abcdefgh' } })).status()).toBe(403);
  for (const c of [oc, gc, other]) await c.close();
});

test('New meeting on the homepage: reserves a room, shows the start screen, and enters the current Meet page as host; a guest can then join it', async ({ browser }) => {
  test.setTimeout(120000);
  const oc = await browser.newContext({ permissions: PERM }); const op = await oc.newPage(); await organiser(oc, MAIN);
  await op.goto(MAIN + '/qorlla.html#home'); await op.locator('.action-btn[data-act="meet"]').click();
  await expect(op.locator('#sdNet [data-k=meet] b')).toContainText('Ready'); const id = (await op.locator('#sdId').textContent()).trim(); expect(id).toMatch(/^\d{3} \d{4} \d{4}$/); await expect(op.locator('#sdGo')).toBeEnabled();
  await op.click('#sdWait'); await op.click('#sdGo'); await op.waitForURL(MEET_URL); await expect(op.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 }); await expect(op.locator('#endBtn')).toBeVisible(); await expect(op.locator('#roomId')).toHaveText(id);
  const gc = await browser.newContext({ permissions: PERM }); const gp = await gc.newPage();
  await gp.goto(MAIN + '/guest/meeting/' + encodeURIComponent(id) + '/prejoin'); await gp.fill('#pjName', 'Guest Ned'); await expect(gp.locator('#pjGo')).toBeEnabled(); await gp.click('#pjGo');
  await gp.waitForURL(MEET_URL); await expect(gp.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 }); await expect(op.locator('.tile')).toHaveCount(2, { timeout: 30000 });
  for (const c of [oc, gc]) await c.close();
});
