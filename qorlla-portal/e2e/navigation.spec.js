const { test, expect } = require('@playwright/test');
const { BASE, fakeJson, signUp, signUpWithWorkspace } = require('./helpers');

const internalLinks = async (page) => page.$$eval('a[href]', (as) => [...new Set(as.map((a) => a.getAttribute('href')).filter((h) => h && !h.startsWith('#') && !h.startsWith('mailto:') && !h.startsWith('javascript:') && !/^https?:\/\//.test(h)))]);

test.describe('navigation - links, keyboard, mobile', () => {
  test('every internal link on the pricing page, the portal and the apps menu resolves (no dead product/sidebar links)', async ({ page, request }) => {
    const seen = new Set(); const dead = [];
    const check = async (from, href) => {
      const url = new URL(href, BASE + from); if (url.origin !== BASE || seen.has(url.pathname + url.search)) return; seen.add(url.pathname + url.search);
      const r = await request.get(url.pathname + url.search, { maxRedirects: 5 }); if (r.status() >= 400) dead.push(`${href} (from ${from}) -> ${r.status()}`);
    };
    for (const path of ['/pricing/', '/app/products', '/app/billing', '/app/team', '/app/support', '/app/notes']) {
      await page.goto(path); if (path === '/pricing/') await page.locator('#appsBtn').click();
      for (const h of await internalLinks(page)) await check(path, h);
    }
    for (const must of ['/index.html', '/chat.html', '/qorlla.html', '/login.html', '/meet/', '/pricing/', '/app/', '/.well-known/jwks.json']) await check('/', must);
    expect(dead).toEqual([]); expect(seen.size).toBeGreaterThan(12);
  });

  test('[I07] header and product links on the pricing page are same-origin routes to the portal', async ({ page }) => {
    await page.goto('/pricing/');
    const hrefs = await page.$$eval('a[data-route]', (as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs.length).toBeGreaterThanOrEqual(4); for (const h of hrefs) if (h && h !== '#contact-sales') expect(h).toMatch(/^\/app\//);
  });

  test('[I08][I09] sidebar items work from the keyboard and open real portal pages', async ({ page, context }) => {
    await signUpWithWorkspace(context, 'sidebar');
    await page.goto('/pricing/');
    const phone = page.locator('.nav-item[data-route="/app/phone"]'); await phone.focus(); await page.keyboard.press('Enter');
    await page.waitForURL(/\/app\/phone$/); await expect(page.getByRole('heading', { name: 'Qorlla Phone' })).toBeVisible();
    await expect(page).toHaveTitle(/Phone \| Qorlla/);
    for (const [route, heading] of [['mate', 'QorllaMate'], ['suite', 'AI Productivity Suite'], ['notes', 'My Notes'], ['receptionist', 'AI Receptionist']]) {
      await page.goto('/pricing/'); await page.locator(`.nav-item[data-route="/app/${route}"]`).click(); await page.waitForURL(new RegExp(`/app/${route}$`));
      await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
    }
  });

  test('apps menu opens, items are reachable by Tab, and Escape closes it and restores focus', async ({ page }) => {
    await page.goto('/pricing/'); const btn = page.locator('#appsBtn');
    await btn.focus(); await page.keyboard.press('Enter'); await expect(btn).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab'); expect(await page.evaluate(() => document.activeElement.closest('#appsMenu') !== null)).toBe(true);
    await page.keyboard.press('Escape'); await expect(btn).toHaveAttribute('aria-expanded', 'false'); await expect(btn).toBeFocused();
  });

  test('highlights expand/collapse by mouse and keyboard', async ({ page }) => {
    await page.goto('/pricing/'); const more = page.locator('[data-toggle="pro-more"]');
    await expect(page.locator('#pro-more')).toBeHidden(); await more.focus(); await page.keyboard.press('Enter'); await expect(page.locator('#pro-more')).toBeVisible();
    await more.click(); await expect(page.locator('#pro-more')).toBeHidden();
  });

  for (const [name, size] of [['phone', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }]]) {
    test(`${name} layout: pricing and portal pages do not overflow horizontally and purchase controls stay reachable`, async ({ page, context }) => {
      await page.setViewportSize(size); await signUp(context, name);
      for (const path of ['/pricing/', '/app/products', '/app/billing']) {
        await page.goto(path);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        // the pricing grid may scroll inside its own container, never the page itself
        expect(overflow, `${path} overflows by ${overflow}px`).toBeLessThanOrEqual(1);
      }
      await page.goto('/pricing/'); await page.locator('#btn-pro').scrollIntoViewIfNeeded(); await expect(page.locator('#btn-pro')).toBeVisible();
    });
  }

  test('legacy pages keep working: /index.html (built-in meetings), /chat.html, /qorlla.html, /login.html', async ({ page }) => {
    for (const [path, marker] of [['/index.html', /Meetings, without the noise|Live Video/], ['/chat.html', /Chat|Sign in/], ['/qorlla.html', /Calendar|Whiteboards/]]) {
      const r = await page.goto(path); expect(r.status(), path).toBe(200); await expect(page.locator('body')).toContainText(marker);
    }
    // /login.html is a supported compatibility route: it hands off to the canonical sign-in (the main page, whose form is embedded in an iframe)
    // and the standalone page stays reachable with ?standalone=1.
    await page.goto('/login.html'); await expect(page).toHaveURL(//qorlla.html/);
    await expect(page.frameLocator('iframe.login-embed').getByRole('button', { name: /Sign in/ }).first()).toBeVisible();
    const standalone = await page.goto('/login.html?standalone=1'); expect(standalone.status()).toBe(200); await expect(page).toHaveURL(/login.html?standalone=1/);
    await expect(page.locator('body')).toContainText(/Sign in|Welcome/);
  });

  test('[I01][I02][I03] the catalogue is same-origin only: no CORS grants, GET-only, private endpoints closed', async ({ request }) => {
    const plans = await fetch(BASE + '/api/v1/plans', { headers: { origin: 'https://evil.example' } });
    expect(plans.status).toBe(200); expect(plans.headers.get('access-control-allow-origin')).toBeNull();
    expect((await request.post('/api/v1/plans', { data: {}, headers: { origin: BASE } })).status()).toBeGreaterThanOrEqual(400);
    const notes = await fetch(BASE + '/api/v1/notes', { headers: { origin: 'https://evil.example' } });
    expect(notes.status).toBe(401); expect(notes.headers.get('access-control-allow-origin')).toBeNull();
  });
});
