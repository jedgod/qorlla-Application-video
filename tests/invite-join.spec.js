const { test, expect } = require('@playwright/test');

// An invited guest: no navigation until signed in, and never the old built-in room (/index.html): the Qorlla Meet video page, or a plain "unavailable" message.
const PREJOIN = '/guest/meeting/858%209833%203712/prejoin';
const resolveOk = (page) => page.route('**/api/guest/meetings/resolve', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ eligible: true, meeting: { topic: 'Invite test' }, passcodeRequired: false }) }));
const session = (page, body) => page.route('**/api/guest/sessions', (r) => r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(body) }));

test('the invitation page has no navigation for a guest, on a desktop window and on a phone', async ({ page }) => {
  for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(vp); await resolveOk(page); await page.goto(PREJOIN);
    await expect(page.locator('#pjGo')).toBeEnabled(); await expect(page.locator('body.invite')).toHaveCount(1);
    await expect(page.locator('.sidebar')).toBeHidden(); await expect(page.locator('#navHome')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
test('the other guest pages keep their navigation', async ({ page }) => {
  await page.goto('/guest/welcome'); await expect(page.locator('.sidebar')).toBeVisible(); await expect(page.locator('body.invite')).toHaveCount(0);
});
test('a signed-in (registered) person opening the invitation sees the navigation again', async ({ page, context }) => {
  const u = 'inv' + Math.random().toString(36).slice(2, 8);
  expect((await context.request.post('/api/auth/register', { data: { username: u, displayName: 'Reg', password: 'Side-bar-9917!x' } })).status()).toBe(201);
  await resolveOk(page); await page.goto(PREJOIN); await expect(page.locator('#pjGo')).toBeEnabled();
  await expect(page.locator('body.invite')).toHaveCount(0, { timeout: 8000 }); await expect(page.locator('.sidebar')).toBeVisible();
});
test('Join goes to the Qorlla Meet video page when there is one', async ({ page }) => {
  await resolveOk(page); await session(page, { kind: 'guest', session: {}, meet: { url: 'http://localhost:9/meet/room-1?t=abc' } });
  await page.route('http://localhost:9/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Meet video page</title>' }));
  await page.goto(PREJOIN); await expect(page.locator('#pjGo')).toBeEnabled(); await page.fill('#pjName', 'Guest One'); await page.click('#pjGo');
  await page.waitForURL('http://localhost:9/meet/room-1?t=abc'); await expect(page).toHaveTitle('Meet video page');
});
test('with no Qorlla Meet the guest is told so and is never sent to the old built-in room', async ({ page }) => {
  const seen = []; page.on('request', (r) => { if (/\/index\.html/.test(r.url())) seen.push(r.url()); });
  await resolveOk(page); await session(page, { kind: 'guest', session: {} });                           // the server issued a session but has no Meet video page
  await page.goto(PREJOIN); await expect(page.locator('#pjGo')).toBeEnabled(); await page.fill('#pjName', 'Guest Two'); await page.click('#pjGo');
  await expect(page.locator('#pjMsg')).toContainText('Video meetings are not available right now'); await expect(page.locator('#pjGo')).toBeEnabled();
  await page.waitForTimeout(800); expect(page.url()).toMatch(/\/prejoin$/); expect(seen).toEqual([]);
});
test('inside the Qorlla mobile app a signed-in person is told video is unavailable instead of being sent to the old room', async ({ browser }) => {
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-A037U) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 QorllaMobile/1', viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage(); const seen = []; page.on('request', (r) => { if (/\/index\.html/.test(r.url())) seen.push(r.url()); });
  expect((await ctx.request.post('/api/auth/register', { data: { username: 'mob' + Math.random().toString(36).slice(2, 8), displayName: 'Mob', password: 'Side-bar-9917!x' } })).status()).toBe(201);
  await page.goto('/qorlla.html#home'); await page.locator('[data-act="meet"]').first().click();
  await page.waitForFunction(() => document.querySelector('#sdPassNote') && document.querySelector('#sdPassNote').textContent !== 'Checking…'); await page.click('#sdGo');
  await expect(page.locator('#toast')).toContainText('Video meetings are not available right now'); await page.waitForTimeout(800);
  expect(page.url()).toContain('/qorlla.html'); expect(seen).toEqual([]); await ctx.close();
});
