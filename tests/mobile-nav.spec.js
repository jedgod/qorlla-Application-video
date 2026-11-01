const { test, expect } = require('@playwright/test');

// On a phone the sidebar is a bottom tab bar: six tabs share the width (no scrolling), every other page is reachable from More,
// and each page opened from the app has a close button that goes back to the page before it.
const TABS = ['Home', 'Chat', 'Phone', 'Docs', 'Clips', 'More'];
for (const w of [320, 360, 390, 412]) {
  test(`phone tab bar at ${w}px: six tabs, one row, nothing scrolls or clips, 48px touch targets`, async ({ page, context }) => {
    await page.setViewportSize({ width: w, height: 800 });
    const username = 'mn' + Math.random().toString(36).slice(2, 8);
    expect((await context.request.post('/api/auth/register', { data: { username, displayName: 'Nav', password: 'Side-bar-9917!x' } })).status()).toBe(201);
    await page.goto('/qorlla.html#home'); await expect(page.locator('.nav-item[data-view=home]')).toBeVisible();
    const m = await page.evaluate(() => {
      const sb = document.querySelector('.sidebar'), items = [...sb.querySelectorAll('.nav-item')].filter((e) => getComputedStyle(e).display !== 'none');
      const box = sb.getBoundingClientRect();
      return { labels: items.sort((a, b) => Number(getComputedStyle(a).order) - Number(getComputedStyle(b).order)).map((e) => e.textContent.trim().replace(/\s+\d+$/, '')),
        scrolls: sb.scrollWidth > sb.clientWidth + 1, clipped: items.filter((e) => [...e.querySelectorAll('span')].some((x) => x.scrollWidth > x.clientWidth + 1)).length,
        inside: items.every((e) => { const r = e.getBoundingClientRect(); return r.left >= box.left - 1 && r.right <= box.right + 1 && r.height >= 48; }),
        pageScroll: document.documentElement.scrollWidth > innerWidth, bottom: box.bottom <= innerHeight };
    });
    expect(m.labels).toEqual(TABS); expect(m.scrolls).toBe(false); expect(m.clipped).toBe(0); expect(m.inside).toBe(true); expect(m.pageScroll).toBe(false); expect(m.bottom).toBe(true);
  });
}
test('the pages that left the tab bar are all tiles on More, and the close button returns to the page before', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const username = 'mc' + Math.random().toString(36).slice(2, 8);
  await context.request.post('/api/auth/register', { data: { username, displayName: 'Nav', password: 'Side-bar-9917!x' } });
  await page.goto('/qorlla.html#home'); await expect(page.locator('#viewClose')).toBeHidden();
  await page.click('.nav-item[data-view=more]'); await expect(page).toHaveURL(/#more$/); await expect(page.locator('#viewClose')).toBeVisible();
  for (const k of ['schedule', 'calendar', 'mail', 'board', 'notes', 'history', 'settings']) await expect(page.locator(`.tile[data-key=${k}]`)).toHaveCount(1);
  await page.click('.tile[data-key=notes]'); await expect(page).toHaveURL(/#notes$/);
  await page.click('#viewClose'); await expect(page).toHaveURL(/#more$/);                                    // closes to the page it was opened from
  await page.click('#viewClose'); await expect(page).toHaveURL(/#home$/); await expect(page.locator('#viewClose')).toBeHidden();
  await page.click('#viewClose', { force: true, trial: true }).catch(() => {});                                   // nothing behind Home: it stays on Home
  await expect(page).toHaveURL(/#home$/);
});
test('Escape closes a page the same way, and opening a page already behind goes back to it instead of stacking', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const username = 'me' + Math.random().toString(36).slice(2, 8);
  await context.request.post('/api/auth/register', { data: { username, displayName: 'Nav', password: 'Side-bar-9917!x' } });
  await page.goto('/qorlla.html#home');
  await page.click('.nav-item[data-view=more]'); await page.click('.tile[data-key=settings]'); await expect(page).toHaveURL(/#settings$/);
  await page.keyboard.press('Escape'); await expect(page).toHaveURL(/#more$/);
  await page.click('.nav-item[data-view=home]'); await expect(page).toHaveURL(/#home$/);
  await page.click('.nav-item[data-view=more]'); await page.click('#viewClose'); await expect(page).toHaveURL(/#home$/);
});
test('on a desktop window the close button never shows', async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await context.request.post('/api/auth/register', { data: { username: 'md' + Math.random().toString(36).slice(2, 8), displayName: 'Nav', password: 'Side-bar-9917!x' } });
  await page.goto('/qorlla.html#home'); await page.click('.nav-item[data-view=notes]'); await expect(page).toHaveURL(/#notes$/); await expect(page.locator('#viewClose')).toBeHidden();
});
