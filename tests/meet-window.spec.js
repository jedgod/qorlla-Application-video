const { test, expect } = require('@playwright/test');
const { MEET, startMain, organiser, followToMeet } = require('./support/meet-stack');

// Starting a meeting from Qorlla Home opens it in a WINDOW OF ITS OWN; Home stays exactly where it was; Leave and End for all close that window.
// Runs its own Workplace server (port 5291) against a REAL Qorlla Meet on 3310 (see tests/support/meet-stack.js).
let main, MAIN;
test.describe.configure({ mode: 'serial' });
test.use({ permissions: ['camera', 'microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });
test.beforeAll(async () => { main = await startMain(5291); MAIN = main.base; });
test.afterAll(() => main && main.stop());

// The meeting is only really "in" once Meet's socket is connected and the first seconds of start-up (chat history, consent, roster) have settled: clicking a confirmation dialog in the
// first second can lose it to start-up work (seen on the qlaunch line after the chat was added). Real people take longer than that; the tests wait for it.
async function settled(meet) { await meet.waitForFunction(() => window.__qorlla?.state?.socket?.connected === true, null, { timeout: 30000 }); await meet.waitForTimeout(2500); }

async function startFromHome(page, context) {
  await page.goto(MAIN + '/qorlla.html#home'); await page.locator('.meeting', { hasText: 'Sprint planning' }).locator('.join-pill').click();
  await expect(page.locator('#startDialog')).toBeVisible(); await expect(page.locator('#sdPassNote')).not.toHaveText('Checking…'); await page.click('#sdWait');
  const [meet] = await Promise.all([context.waitForEvent('page'), page.click('#sdGo')]);
  return meet;
}

test('Start opens the meeting in a window of its own and Home stays where it was (no navigation, no reload)', async ({ page, context }) => {
  test.setTimeout(120000);
  await organiser(context, MAIN);
  await page.goto(MAIN + '/qorlla.html#home');
  await page.evaluate(() => { window.__marker = 'home-still-here'; });                         // lost if the page navigates or reloads
  await page.locator('.meeting', { hasText: 'Sprint planning' }).locator('.join-pill').click();
  await expect(page.locator('#startDialog')).toBeVisible(); await expect(page.locator('#sdPassNote')).not.toHaveText('Checking…'); await page.click('#sdWait');
  const homeUrl = page.url();
  const [meet] = await Promise.all([context.waitForEvent('page'), page.click('#sdGo')]);
  await meet.waitForURL(new RegExp(MEET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); await expect(meet.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 });
  expect(meet.url()).not.toContain('qs='); expect(meet.url()).not.toContain('qh='); expect(meet.url()).not.toContain('win=');       // Meet reads its launch parameters (the single-use code, win=popup) and leaves none of them in the address bar
  expect(page.url()).toBe(homeUrl);                                                            // Home did not navigate
  expect(await page.evaluate(() => window.__marker)).toBe('home-still-here');                  // ...and was not reloaded
  await expect(page.locator('#startDialog')).toBeHidden();                                     // the Start dialog is closed: the meeting is elsewhere now
  expect(context.pages().length).toBe(2);
  await meet.close();                                                                          // leave nothing running for the next test
});

test('End for all closes the meeting window and leaves Home exactly where it was', async ({ page, context }) => {
  test.setTimeout(120000);
  await organiser(context, MAIN);
  await page.goto(MAIN + '/qorlla.html#home'); await page.evaluate(() => { window.__marker = 'home-still-here'; });
  const homeUrl = page.url();
  const meet = await startFromHome(page, context);
  await expect(meet.locator('#endBtn')).toBeVisible({ timeout: 30000 }); await settled(meet);
  const closed = meet.waitForEvent('close');
  await meet.click('#endBtn'); await meet.locator('.rc-danger', { hasText: 'End for all' }).click();       // the confirmation, not the toolbar button
  await closed;                                                                                // the meeting window closed itself
  expect(meet.isClosed()).toBe(true);
  expect(page.url()).toBe(homeUrl); expect(await page.evaluate(() => window.__marker)).toBe('home-still-here');   // Home is the same page, not reloaded, not navigated
  expect(context.pages().length).toBe(1);
});

test('Leave also closes the meeting window; Home is untouched', async ({ page, context }) => {
  test.setTimeout(120000);
  await organiser(context, MAIN);
  await page.goto(MAIN + '/qorlla.html#home'); await page.evaluate(() => { window.__marker = 'home-still-here'; });
  const meet = await startFromHome(page, context);
  await expect(meet.locator('#leaveBtn')).toBeVisible({ timeout: 30000 }); await settled(meet);
  const closed = meet.waitForEvent('close'); await meet.click('#leaveBtn'); await closed;
  expect(await page.evaluate(() => window.__marker)).toBe('home-still-here');
});

test('if the browser refuses to open a window, Home is NOT replaced: it offers an "Open the meeting" button', async ({ page, context }) => {
  test.setTimeout(120000);
  await organiser(context, MAIN);
  await page.goto(MAIN + '/qorlla.html#home');
  await page.addInitScript(() => { window.open = () => null; });                               // a blocked pop-up
  await page.reload(); await page.evaluate(() => { window.__marker = 'home-still-here'; });
  await page.locator('.meeting', { hasText: 'Sprint planning' }).locator('.join-pill').click();
  await expect(page.locator('#startDialog')).toBeVisible(); await expect(page.locator('#sdPassNote')).not.toHaveText('Checking…'); await page.click('#sdWait'); await page.click('#sdGo');
  await expect(page.getByRole('button', { name: 'Open the meeting' })).toBeVisible({ timeout: 20000 });
  expect(page.url()).toContain('/qorlla.html'); expect(await page.evaluate(() => window.__marker)).toBe('home-still-here');   // still Home
});

test('arriving at Home with #join opens the Join meeting dialog (this is where Meet\'s own address sends people)', async ({ page, context }) => {
  test.setTimeout(60000);
  await organiser(context, MAIN);
  await page.goto(MAIN + '/qorlla.html#join');
  await expect(page.locator('#startDialog')).toBeVisible(); await expect(page.locator('#sdMid')).toBeVisible(); await expect(page.locator('#sdGo')).toHaveText('Join meeting');
  expect(page.url()).not.toContain('#join');                                                       // the link is consumed: reloading Home does not reopen the dialog
});

test('joining by Meeting ID from the Join meeting dialog also opens a window of its own and leaves Home where it was', async ({ browser, context }) => {
  test.setTimeout(150000);
  const { item } = await organiser(context, MAIN); const host = await context.newPage();
  const hostMeet = await (async () => { await host.goto(MAIN + '/qorlla.html#home'); await host.locator('.meeting', { hasText: 'Sprint planning' }).locator('.join-pill').click(); await expect(host.locator('#sdPassNote')).not.toHaveText('Checking…'); await host.click('#sdWait'); return followToMeet(host, () => host.click('#sdGo')); })();
  await expect(hostMeet.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 });
  const gc = await browser.newContext({ permissions: ['camera', 'microphone'] }); const home = await gc.newPage(); await organiser(gc, MAIN, { name: 'Justin', title: 'Another meeting' });
  await home.goto(MAIN + '/qorlla.html#home'); await home.evaluate(() => { window.__marker = 'home-still-here'; });
  await home.locator('.action-btn[data-act="join"]').click(); await expect(home.locator('#sdMid')).toBeVisible();
  await home.fill('#sdMid', item.meetingId); await home.fill('#sdName', 'Justin');
  const meet = await followToMeet(home, () => home.click('#sdGo'));
  await expect(meet.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 }); await expect(meet.locator('#roomTitle')).toHaveText('Sprint planning');
  expect(meet).not.toBe(home); expect(home.url()).toContain('/qorlla.html'); expect(await home.evaluate(() => window.__marker)).toBe('home-still-here');
  await meet.close(); await hostMeet.close(); await gc.close();
});
