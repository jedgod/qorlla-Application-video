const { test, expect } = require('@playwright/test');

// One tab per signed-in account in a browser: the second tab is blocked, "Use Qorlla here" moves the account to it and pauses the first.
const holding = (page) => expect(page.locator('html')).toHaveAttribute('data-single-tab', 'holder', { timeout: 8000 });
async function account(context) {
  const username = 'st' + Math.random().toString(36).slice(2, 8);
  expect((await context.request.post('/api/auth/register', { data: { username, displayName: 'Tab', password: 'Side-bar-9917!x' } })).status()).toBe(201);
}
test('a second tab of the same signed-in account is blocked, and Use Qorlla here swaps the tabs', async ({ context }) => {
  await account(context);
  const one = await context.newPage(); await one.goto('/qorlla.html#home'); await expect(one.locator('#avatarBtn')).toHaveText('T'); await holding(one);
  await expect(one.locator('#singleTabNotice')).toHaveCount(0);
  const two = await context.newPage(); await two.goto('/qorlla.html#home');
  await expect(two.locator('#singleTabNotice')).toBeVisible({ timeout: 8000 });
  await expect(two.locator('#singleTabNotice')).toContainText('already open in another tab');
  await expect(two.locator('.app')).toHaveAttribute('inert', '');
  await expect(one.locator('#singleTabNotice')).toHaveCount(0);
  await two.getByRole('button', { name: 'Use Qorlla here' }).click();
  await expect(two.locator('#singleTabNotice')).toHaveCount(0, { timeout: 8000 });
  await expect(one.locator('#singleTabNotice')).toContainText('now open in another tab');
  await expect(one.locator('.app')).toHaveAttribute('inert', '');
  await one.getByRole('button', { name: 'Use Qorlla here' }).click();                               // and back again
  await expect(one.locator('#singleTabNotice')).toHaveCount(0, { timeout: 8000 });
  await expect(two.locator('#singleTabNotice')).toContainText('now open in another tab');
});
test('closing the first tab frees the account for a new tab; reloading a tab is not blocked by itself', async ({ context }) => {
  await account(context);
  const one = await context.newPage(); await one.goto('/qorlla.html#home'); await expect(one.locator('#avatarBtn')).toHaveText('T'); await holding(one);
  await one.reload(); await expect(one.locator('#avatarBtn')).toHaveText('T'); await one.waitForTimeout(1800); await expect(one.locator('#singleTabNotice')).toHaveCount(0);
  await one.close();
  const two = await context.newPage(); await two.goto('/qorlla.html#home'); await expect(two.locator('#avatarBtn')).toHaveText('T'); await two.waitForTimeout(1800); await expect(two.locator('#singleTabNotice')).toHaveCount(0);
});
test('two different browsers (separate contexts) are not affected by each other', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  for (const c of [a, b]) { const u = 'sx' + Math.random().toString(36).slice(2, 8); await c.request.post('/api/auth/register', { data: { username: u, displayName: 'Tab', password: 'Side-bar-9917!x' } }); }
  const p1 = await a.newPage(), p2 = await b.newPage(); await p1.goto('/qorlla.html#home'); await p2.goto('/qorlla.html#home');
  await expect(p1.locator('#avatarBtn')).toHaveText('T'); await expect(p2.locator('#avatarBtn')).toHaveText('T'); await p2.waitForTimeout(1800);
  await expect(p1.locator('#singleTabNotice')).toHaveCount(0); await expect(p2.locator('#singleTabNotice')).toHaveCount(0);
  await a.close(); await b.close();
});

// ---- coverage: chat shares the lock, a crashed holder frees it, account switching, browsers without Web Locks
test('chat and the workspace share one lock per account', async ({ context }) => {
  await account(context);
  const work = await context.newPage(); await work.goto('/qorlla.html#home'); await expect(work.locator('#avatarBtn')).toHaveText('T'); await holding(work);
  const chat = await context.newPage(); await chat.goto('/chat.html');
  await expect(chat.locator('#singleTabNotice')).toBeVisible({ timeout: 8000 }); await expect(chat.locator('#app')).toHaveAttribute('inert', '');
  await work.close();                                                                                   // the holder goes away: the waiting chat tab takes over by itself
  await expect(chat.locator('#singleTabNotice')).toHaveCount(0, { timeout: 8000 }); await expect(chat.locator('#app')).not.toHaveAttribute('inert', '');
});
// Chromium puts tabs of one site in one renderer process, so a real renderer crash cannot be aimed at a single tab here. Closing the holder without any unload handler is the same event
// for the lock: the browser frees a Web Lock when the page's agent ends, so nothing stale is left behind.
test('an abruptly closed holder leaves no stale lock: the waiting tab takes over without any click', async ({ context }) => {
  await account(context);
  const one = await context.newPage(); await one.goto('/qorlla.html#home'); await expect(one.locator('#avatarBtn')).toHaveText('T'); await holding(one);
  const two = await context.newPage(); await two.goto('/qorlla.html#home'); await expect(two.locator('#singleTabNotice')).toBeVisible({ timeout: 8000 });
  await one.close({ runBeforeUnload: false });
  await expect(two.locator('#singleTabNotice')).toHaveCount(0, { timeout: 10000 });
  const three = await context.newPage(); await three.goto('/qorlla.html#home'); await expect(three.locator('#singleTabNotice')).toBeVisible({ timeout: 8000 });   // the lock is held again, by tab two
});
test('another account starting on a page lets go of the old account (account switching)', async ({ context }) => {
  await account(context);
  const one = await context.newPage(); await one.goto('/qorlla.html#home'); await expect(one.locator('#avatarBtn')).toHaveText('T'); await holding(one);
  const two = await context.newPage(); await two.goto('/qorlla.html#home'); await expect(two.locator('#singleTabNotice')).toBeVisible({ timeout: 8000 });
  await one.evaluate(() => window.QorllaSingleTab.start('some-other-account', { root: '.app' }));       // this page now belongs to another account
  await expect(two.locator('#singleTabNotice')).toHaveCount(0, { timeout: 8000 });                      // the old account's lock was released
  expect(await one.evaluate(() => window.QorllaSingleTab.status())).toBe('active');
  await one.evaluate(() => window.QorllaSingleTab.start('some-other-account', { root: '.app' }));       // same account again: nothing changes
  await expect(one.locator('#singleTabNotice')).toHaveCount(0);
});
test('without Web Locks nothing is blocked and nothing claims it is: status is "unsupported"', async ({ context }) => {
  await account(context);
  await context.addInitScript(() => { try { Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }); } catch (e) { /* ignore */ } });
  const one = await context.newPage(); await one.goto('/qorlla.html#home'); await expect(one.locator('#avatarBtn')).toHaveText('T');
  const two = await context.newPage(); await two.goto('/qorlla.html#home'); await expect(two.locator('#avatarBtn')).toHaveText('T'); await two.waitForTimeout(1500);
  for (const p of [one, two]) { await expect(p.locator('#singleTabNotice')).toHaveCount(0); await expect(p.locator('html')).toHaveAttribute('data-single-tab', 'unsupported'); expect(await p.evaluate(() => window.QorllaSingleTab.status())).toBe('unsupported'); }
});
test('the guard is a convenience only: a second tab is still signed in on the server (no session is ended)', async ({ context }) => {
  await account(context);
  const one = await context.newPage(); await one.goto('/qorlla.html#home'); await expect(one.locator('#avatarBtn')).toHaveText('T'); await holding(one);
  const two = await context.newPage(); await two.goto('/qorlla.html#home'); await expect(two.locator('#singleTabNotice')).toBeVisible({ timeout: 8000 });
  expect((await context.request.get('/api/auth/me')).status()).toBe(200);
});
