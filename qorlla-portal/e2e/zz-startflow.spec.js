const { test, expect } = require('@playwright/test');
test('host start flow lands in Meet', async ({ browser }) => {
  test.setTimeout(120000);
  const ctx = await browser.newContext({ baseURL: process.env.E2E_BASE, ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } });
  expect((await ctx.request.post('/api/auth/login', { data: { username: 'stryker', password: process.env.STRYKER_PW }, headers: { origin: process.env.E2E_BASE } })).status()).toBe(200);
  const page = await ctx.newPage(); const urls = []; page.on('framenavigated', (f) => { if (f === page.mainFrame()) urls.push(f.url().replace(/#qh=[^&]*/, '#qh=<code>').slice(0, 150)); });
  await page.goto('/qorlla.html#home'); await page.waitForTimeout(2500);
  await page.getByRole('button', { name: /New meeting/ }).first().click();
  await expect(page.locator('#startDialog')).toBeVisible({ timeout: 20000 }); console.log('DIALOG ' + (await page.locator('#sdTitle').textContent()));
  await page.waitForTimeout(1500); await page.locator('#sdGo').click();
  await page.waitForTimeout(12000);
  console.log('URLS ' + JSON.stringify(urls)); console.log('FINAL ' + page.url().replace(/#qh=[^&]*/, '#qh=<code>').slice(0, 160));
  console.log('IN_MEET_ROOM ' + (await page.locator('#app').count() ? await page.locator('#app').evaluate((e) => !e.classList.contains('hidden')) : 'no #app (not the Meet page)'));
  console.log('TITLE ' + (await page.title())); await page.screenshot({ path: process.env.SHOT });
});
