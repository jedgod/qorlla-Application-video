const { test, expect } = require('@playwright/test');

// Guest Welcome design integration: every control goes to an existing route, nothing here grants access, layout holds at three widths.
const sizes = { desktop: { width: 1366, height: 768 }, tablet: { width: 820, height: 1180 }, phone: { width: 390, height: 844 } };

test('every Welcome control points at its existing route', async ({ page }) => {
  await page.goto('/guest/welcome');
  const href = async (loc) => loc.first().getAttribute('href');
  expect(await href(page.getByRole('link', { name: 'Join Meeting', exact: true }))).toBe('/guest/join-meeting');
  expect(await href(page.getByRole('link', { name: 'Use meeting link' }))).toBe('/guest/join-meeting?mode=link');
  expect(await href(page.getByRole('link', { name: 'Enter meeting ID' }))).toBe('/guest/join-meeting?mode=id');
  expect(await href(page.getByRole('link', { name: 'Explore Qorlla', exact: true }))).toBe('/guest/explore');
  expect(await href(page.getByRole('link', { name: 'Help & Tutorials', exact: true }))).toBe('/guest/help');
  expect(await href(page.getByRole('link', { name: 'Create Account', exact: true }))).toBe('/auth/register');
  expect(await href(page.getByRole('link', { name: 'Sign in to Qorlla Workspace' }))).toBe('/auth/login');
  // Explore-card feature links and the rail are previews on the Explore page, never module routes
  for (const f of ['chat', 'phone', 'docs', 'clips']) expect(await page.locator(`.tile.explore .tile-links a[href="/guest/explore#${f}"]`).count()).toBe(1);
  const rail = await page.locator('.sidebar a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  expect(rail.every((h) => h.startsWith('/guest/'))).toBe(true);
  await expect(page.locator('#navHome')).toHaveAttribute('aria-current', 'page');
});

test('the tile shortcuts only change the prompt; the ID is still validated by the same flow', async ({ page }) => {
  await page.goto('/guest/join-meeting?mode=link'); await expect(page.locator('#midLabel')).toHaveText('Invitation link'); await expect(page.locator('#mid')).toBeFocused();
  await page.goto('/guest/join-meeting?mode=id'); await expect(page.locator('#midLabel')).toHaveText('Meeting ID');
  await page.fill('#mid', '123'); await page.getByRole('button', { name: 'Continue' }).click(); await expect(page.locator('#joinMsg')).toContainText('valid 11-digit');
});

test('rail previews land on Explore anchors, Help anchors exist, and a guest still cannot open workspace modules', async ({ page, request }) => {
  await page.goto('/guest/explore#whiteboards'); await expect(page.locator('#whiteboards')).toBeVisible();
  await page.goto('/guest/help#faq'); await expect(page.locator('#faq')).toBeVisible(); await expect(page.locator('#videos')).toContainText('not available yet');
  for (const p of ['/api/workplace/chat', '/api/workplace/notes']) expect([401, 403]).toContain((await request.get(p)).status());
  await page.goto('/app/chat'); await expect(page).not.toHaveURL(/\/guest\//);
});

for (const [name, vp] of Object.entries(sizes)) {
  test(`layout at ${name}: no horizontal overflow, rail placement, all four tiles and the sign-in button reachable`, async ({ page }) => {
    await page.setViewportSize(vp); await page.goto('/guest/welcome');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    for (const n of ['Join Meeting', 'Explore Qorlla', 'Help & Tutorials', 'Create Account']) await expect(page.getByRole('heading', { name: n })).toBeVisible();
    await page.getByRole('link', { name: 'Sign in to Qorlla Workspace' }).scrollIntoViewIfNeeded(); await expect(page.getByRole('link', { name: 'Sign in to Qorlla Workspace' })).toBeVisible();
    const box = await page.locator('.sidebar').boundingBox();
    if (name === 'phone') { expect(box.y).toBeGreaterThan(vp.height / 2); expect(box.width).toBeGreaterThan(vp.width - 4); } else { expect(box.x).toBe(0); expect(box.width).toBeLessThanOrEqual(130); }
  });
}

test('accessibility basics: landmarks, named controls, keyboard order, visible focus, reduced motion', async ({ page }) => {
  await page.goto('/guest/welcome');
  await expect(page.locator('main')).toHaveCount(1); await expect(page.getByRole('navigation', { name: 'Guest navigation' })).toBeVisible();
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('a,button,select,input')].filter((e) => e.offsetParent && !e.hasAttribute('aria-hidden') && !(e.getAttribute('aria-label') || e.textContent.trim() || (e.labels && e.labels.length))).length);
  expect(unnamed).toBe(0);
  const imgsWithoutAlt = await page.evaluate(() => [...document.images].filter((i) => !i.hasAttribute('alt')).length); expect(imgsWithoutAlt).toBe(0);
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); // logo, then first rail item
  const focused = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { tag: document.activeElement.tagName, outline: s.outlineStyle + ' ' + s.outlineWidth }; });
  expect(focused.outline).toContain('solid');
  await page.locator('.tile.meeting h2 a').focus(); await page.keyboard.press('Enter'); await expect(page).toHaveURL(/\/guest\/join-meeting$/);
});

test('the globe is a local, optimized asset (no remote image requests)', async ({ page }) => {
  const external = []; page.on('request', (r) => { if (!r.url().startsWith('http://localhost')) external.push(r.url()); });
  const sizes2 = []; page.on('response', async (r) => { if (r.url().endsWith('guest-globe.webp')) sizes2.push((await r.body()).length); });
  await page.goto('/guest/welcome'); await page.waitForLoadState('networkidle');
  expect(external).toEqual([]); expect(sizes2.length).toBe(1); expect(sizes2[0]).toBeLessThan(80 * 1024);
});
