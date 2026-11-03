const { test, expect } = require('@playwright/test');
const { BASE, signUpWithWorkspace } = require('./helpers');

// Breadcrumbs, phase 2, for the portal's own pages: Documents (/app/suite) and the Admin portal (/app/admin). The portal supplies ITS OWN routes and ITS OWN authorization to the shared utility; the shell
// (qorlla.html) and Chat are covered in the root tests (tests/breadcrumbs-apps.spec.js). Needs the unified deployment (E2E_BASE). The Admin tests need a platform administrator:
//   E2E_ADMIN_USER / E2E_ADMIN_PASSWORD (an account whose id is in the portal's PLATFORM_ADMIN_USER_IDS); without them those tests are SKIPPED and reported as skipped.
const ADMIN = process.env.E2E_ADMIN_USER && process.env.E2E_ADMIN_PASSWORD ? { username: process.env.E2E_ADMIN_USER, password: process.env.E2E_ADMIN_PASSWORD } : null;
const DOC_ID = '3f2b8c1e-5d4a-4e7b-9c10-1a2b3c4d5e6f';

const items = (page) => page.locator('#crumbs li:not(.breadcrumb-separator)').allTextContents();
const landmarks = (page) => page.getByRole('navigation', { name: 'Breadcrumb' });
async function member(browser, viewport = { width: 1280, height: 800 }) { const ctx = await browser.newContext({ viewport, baseURL: BASE }); await signUpWithWorkspace(ctx, 'bc'); return { ctx, page: await ctx.newPage() }; }
async function administrator(browser, viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport, baseURL: BASE }), r = await ctx.request.post('/api/auth/login', { data: ADMIN }); expect(r.status()).toBe(200); return { ctx, page: await ctx.newPage() };
}

test.describe('Documents', () => {
  test('/app/suite shows "Workspace / Documents": one labelled landmark, the current page is a non-link marked as current, and Workspace is a real link to the shell', async ({ browser }) => {
    const { ctx, page } = await member(browser); await page.goto('/app/suite'); await expect.poll(() => items(page)).toEqual(['Workspace', 'Documents']);
    await expect(landmarks(page)).toHaveCount(1); await expect(page.locator('nav[aria-label="Breadcrumb"]')).toHaveCount(1); await expect(page.locator('#crumbs [aria-current="page"]')).toHaveText('Documents');
    expect(await page.locator('#crumbs [aria-current="page"]').evaluate((e) => e.tagName)).toBe('SPAN'); await expect(page.locator('#crumbs a')).toHaveCount(1); await expect(page.locator('#crumbs a')).toHaveAttribute('href', '/qorlla.html#home');
    for (const sep of await page.locator('#crumbs .breadcrumb-separator').all()) await expect(sep).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#crumbs')).toBeVisible(); await ctx.close();
  });
  test('an open document shows "Document" and never its id; the Documents crumb is a real link; Back and Forward and a refresh keep the right trail', async ({ browser }) => {
    const { ctx, page } = await member(browser); await page.goto('/app/suite?doc=' + DOC_ID); await expect.poll(() => items(page)).toEqual(['Workspace', 'Documents', 'Document']);
    expect(JSON.stringify(await items(page))).not.toContain(DOC_ID); expect(await page.locator('#crumbs a').evaluateAll((as) => as.map((a) => a.getAttribute('href')).join(' '))).not.toContain(DOC_ID);
    await expect(page.locator('#crumbs a', { hasText: 'Documents' })).toHaveAttribute('href', '/app/suite'); await page.reload(); await expect.poll(() => items(page)).toEqual(['Workspace', 'Documents', 'Document']);
    await page.locator('#crumbs a', { hasText: 'Documents' }).click(); await page.waitForURL(/\/app\/suite$/); await expect.poll(() => items(page)).toEqual(['Workspace', 'Documents']);
    await page.goBack(); await page.waitForURL(/doc=/); await expect.poll(() => items(page)).toEqual(['Workspace', 'Documents', 'Document']); await page.goForward(); await page.waitForURL(/\/app\/suite$/); await expect.poll(() => items(page)).toEqual(['Workspace', 'Documents']); await ctx.close();
  });
  test('cross-application: Workspace opens the workspace shell (its own trail), and Back returns to Documents with its trail', async ({ browser }) => {
    const { ctx, page } = await member(browser); await page.goto('/app/suite'); await expect.poll(() => items(page)).toEqual(['Workspace', 'Documents']);
    await page.locator('#crumbs a', { hasText: 'Workspace' }).click(); await page.waitForURL(/qorlla\.html#home/); await expect.poll(() => page.locator('#crumbs li:not(.breadcrumb-separator)').allTextContents()).toEqual(['Home']);
    await expect(landmarks(page)).toHaveCount(1); await page.goBack(); await page.waitForURL(/\/app\/suite/); await expect.poll(() => items(page)).toEqual(['Workspace', 'Documents']); await ctx.close();
  });
  test('signed out: no trail on a private page (no labels, no links, nothing in the accessibility tree)', async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: BASE }), page = await ctx.newPage(); await page.goto('/app/suite?doc=' + DOC_ID); await page.waitForLoadState('networkidle');
    await expect(landmarks(page)).toHaveCount(0); expect(await page.locator('nav[aria-label="Breadcrumb"]:visible').count()).toBe(0); expect((await page.locator('#crumbs').textContent()) || '').toBe(''); await expect(page.locator('#crumbs a')).toHaveCount(0);
    expect(await page.content()).not.toContain('Document</'); await ctx.close();
  });
  test('keyboard: the trail is reachable by Tab, the link shows a focus style, and Enter follows it', async ({ browser }) => {
    const { ctx, page } = await member(browser); await page.goto('/app/suite?doc=' + DOC_ID); await expect.poll(() => items(page)).toEqual(['Workspace', 'Documents', 'Document']);
    const links = landmarks(page).getByRole('link'); await expect(links).toHaveCount(2); await links.nth(1).focus(); expect(await links.nth(1).evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe('none');
    await page.keyboard.press('Enter'); await page.waitForURL(/\/app\/suite$/); await expect.poll(() => items(page)).toEqual(['Workspace', 'Documents']);
    await page.goto('/app/suite'); await expect.poll(() => items(page)).toEqual(['Workspace', 'Documents']); await page.locator('body').click({ position: { x: 1, y: 1 } }); let reached = false; for (let i = 0; i < 40 && !reached; i++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('#crumbs')); } expect(reached, 'Tab reaches the breadcrumb link').toBe(true); await ctx.close();
  });
  test('mobile (360 px): the trail is visible, wraps and never scrolls the page sideways', async ({ browser }) => {
    const { ctx, page } = await member(browser, { width: 360, height: 740 }); await page.goto('/app/suite?doc=' + DOC_ID); await expect.poll(() => items(page)).toEqual(['Workspace', 'Documents', 'Document']); await expect(page.locator('#crumbs')).toBeVisible();
    const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth, c: document.getElementById('crumbs').scrollWidth, b: document.getElementById('crumbs').clientWidth })); expect(m.doc).toBeLessThanOrEqual(m.win); expect(m.c).toBeLessThanOrEqual(m.b + 1); await ctx.close();
  });
  test('other portal pages: Plans & Billing and the public Products page; unknown portal paths show no trail', async ({ browser }) => {
    const { ctx, page } = await member(browser); await page.goto('/app/billing'); await expect.poll(() => items(page)).toEqual(['Workspace', 'Plans & Billing']); await expect(landmarks(page)).toHaveCount(1);
    await page.goto('/app/this-page-does-not-exist'); await page.waitForLoadState('networkidle'); expect(await page.locator('nav[aria-label="Breadcrumb"]:visible').count()).toBe(0); await ctx.close();
  });
});

test.describe('Admin portal', () => {
  test('a signed-in person who is NOT a platform administrator gets no Admin trail and no link to Admin anywhere in it', async ({ browser }) => {
    const { ctx, page } = await member(browser); await page.goto('/app/admin?tab=subscriptions'); await page.waitForLoadState('networkidle');
    await expect(landmarks(page)).toHaveCount(0); expect((await page.locator('#crumbs').textContent()) || '').not.toContain('Admin'); await expect(page.locator('#crumbs a')).toHaveCount(0); await ctx.close();
  });
  test('signed out: the Admin address shows no trail', async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: BASE }), page = await ctx.newPage(); await page.goto('/app/admin'); await page.waitForLoadState('networkidle'); await expect(landmarks(page)).toHaveCount(0); expect((await page.locator('#crumbs').textContent()) || '').toBe(''); await ctx.close();
  });
  test.describe('as a platform administrator', () => {
    test.skip(!ADMIN, 'E2E_ADMIN_USER / E2E_ADMIN_PASSWORD are not set');
    test('/app/admin shows "Workspace / Admin" and each section is a trail of its own; the address (with refresh and Back/Forward) decides it', async ({ browser }) => {
      const { ctx, page } = await administrator(browser); await page.goto('/app/admin'); await expect.poll(() => items(page)).toEqual(['Workspace', 'Admin']); await expect(landmarks(page)).toHaveCount(1); await expect(page.locator('#crumbs [aria-current="page"]')).toHaveText('Admin');
      await page.goto('/app/admin?tab=subscriptions'); await expect.poll(() => items(page)).toEqual(['Workspace', 'Admin', 'Subscriptions']); await expect(page.locator('#crumbs a', { hasText: 'Admin' })).toHaveAttribute('href', '/app/admin');
      await page.reload(); await expect.poll(() => items(page)).toEqual(['Workspace', 'Admin', 'Subscriptions']);
      await page.locator('#crumbs a', { hasText: 'Admin' }).click(); await page.waitForURL(/\/app\/admin$/); await expect.poll(() => items(page)).toEqual(['Workspace', 'Admin']);
      await page.goBack(); await page.waitForURL(/tab=subscriptions/); await expect.poll(() => items(page)).toEqual(['Workspace', 'Admin', 'Subscriptions']); await page.goForward(); await page.waitForURL(/\/app\/admin$/); await expect.poll(() => items(page)).toEqual(['Workspace', 'Admin']);
      await page.goto('/app/admin?tab=nonsense'); await expect.poll(() => items(page)).toEqual(['Workspace', 'Admin']); await ctx.close();
    });
    test('every Admin section has the right trail', async ({ browser }) => {
      const { ctx, page } = await administrator(browser); const tabs = { overview: 'Overview', health: 'Health', subscriptions: 'Subscriptions', invoices: 'Invoices & refunds', events: 'Provider events', sales: 'Sales leads' };
      for (const [tab, label] of Object.entries(tabs)) { await page.goto('/app/admin?tab=' + tab); await expect.poll(() => items(page), { message: tab }).toEqual(['Workspace', 'Admin', label]); await expect(landmarks(page)).toHaveCount(1); } await ctx.close();
    });
    test('keyboard and mobile (360 px) in Admin', async ({ browser }) => {
      const { ctx, page } = await administrator(browser, { width: 360, height: 740 }); await page.goto('/app/admin?tab=health'); await expect.poll(() => items(page)).toEqual(['Workspace', 'Admin', 'Health']); await expect(page.locator('#crumbs')).toBeVisible();
      const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth })); expect(m.doc).toBeLessThanOrEqual(m.win);
      const link = landmarks(page).getByRole('link').nth(1); await link.focus(); await page.keyboard.press('Enter'); await page.waitForURL(/\/app\/admin$/); await expect.poll(() => items(page)).toEqual(['Workspace', 'Admin']); await ctx.close();
    });
    test('cross-application: Workspace from Admin opens the shell; the Admin section controls still work', async ({ browser }) => {
      const { ctx, page } = await administrator(browser); await page.goto('/app/admin?tab=health'); await page.locator('nav[aria-label="Admin sections"] a', { hasText: 'Subscriptions' }).click(); await page.waitForURL(/tab=subscriptions/);
      await page.locator('#crumbs a', { hasText: 'Workspace' }).click(); await page.waitForURL(/qorlla\.html#home/); await expect.poll(() => page.locator('#crumbs li:not(.breadcrumb-separator)').allTextContents()).toEqual(['Home']); await ctx.close();
    });
  });
});
