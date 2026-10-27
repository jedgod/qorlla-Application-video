const { test, expect } = require('@playwright/test');

// The home sidebar keeps its column (width, order) and every item fits without scrolling; labels stay inside the column.
const ORDER = ['Home', 'Phone', 'Docs', 'Mail', 'Clips', 'Whiteboards', 'Chat', 'Calendar', 'Schedule', 'Notes', 'More', 'Settings'];
for (const [w, h] of [[1920, 1080], [1366, 768], [1280, 720], [1024, 700], [1280, 640]]) {
  test(`sidebar fits without scrolling at ${w}x${h} and keeps its column and order`, async ({ page, context }) => {
    await page.setViewportSize({ width: w, height: h });
    const username = 'sb' + Math.random().toString(36).slice(2, 8);
    expect((await context.request.post('/api/auth/register', { data: { username, displayName: 'Side', password: 'Side-bar-9917!x' } })).status()).toBe(201);
    await page.goto('/qorlla.html#home'); await expect(page.locator('.nav-item').first()).toBeVisible();
    const m = await page.evaluate(() => {
      const sb = document.querySelector('.sidebar'); const r = sb.getBoundingClientRect();
      return { width: Math.round(r.width), fits: sb.scrollHeight <= sb.clientHeight + 1, labels: [...document.querySelectorAll('.nav-item')].map((e) => e.textContent.trim().replace(/\s+\d+$/, '')),
        clipped: [...document.querySelectorAll('.nav-item')].filter((e) => e.scrollWidth > e.clientWidth + 1).length,
        last: (() => { const b = document.querySelector('.nav-item[data-view="settings"]').getBoundingClientRect(); return b.bottom <= innerHeight; })() };
    });
    expect(m.width).toBe(104); expect(m.labels).toEqual(ORDER); expect(m.clipped).toBe(0);
    if (h >= 700) { expect(m.fits).toBe(true); expect(m.last).toBe(true); }       // below that height the column may scroll, as before
  });
}
test('the sidebar still navigates: Schedule, Notes and Home work from it', async ({ page, context }) => {
  const username = 'sn' + Math.random().toString(36).slice(2, 8);
  await context.request.post('/api/auth/register', { data: { username, displayName: 'Side', password: 'Side-bar-9917!x' } });
  await page.goto('/qorlla.html#home'); await page.click('.nav-item[data-view="notes"]'); await expect(page).toHaveURL(/#notes$/);
  await page.click('.nav-item[data-view="home"]'); await expect(page).toHaveURL(/#home$/);
});

test('the home workspace has no "Billing / 30-minute session" card or charge buttons, and the old local billing state is cleared', async ({ page, context }) => {
  const username = 'nb' + Math.random().toString(36).slice(2, 8);
  await context.request.post('/api/auth/register', { data: { username, displayName: 'Side', password: 'Side-bar-9917!x' } });
  await page.addInitScript(() => { try { localStorage.setItem('qorllaBillingState', '{"startedAt":1}'); } catch (e) { /* ignore */ } });
  await page.goto('/qorlla.html#home'); await expect(page.getByText('Good', { exact: false }).first()).toBeVisible();
  await expect(page.locator('#billingCard')).toHaveCount(0);
  for (const t of ['30-minute session', 'Charge now', 'Skip charge', 'Session active']) await expect(page.getByText(t)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('qorllaBillingState'))).toBeNull();
  await expect(page.locator('.calendar-card')).toBeVisible();                                   // the calendar card below it is unchanged
});
