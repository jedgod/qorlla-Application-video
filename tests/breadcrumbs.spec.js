const { test, expect } = require('@playwright/test');
const { startMain, PASSWORD } = require('./support/meet-stack');
const Crumbs = require('../assets/breadcrumbs.js');

// Breadcrumbs: one trail in the app shell (under the top bar, above the page), driven by the app's own hash routes. Real main app, real browser.
const MAIN = 5431;
const rand = () => Math.random().toString(36).slice(2, 7);

test.describe('breadcrumb trail: route -> labels (pure, no browser)', () => {
  const labels = (items) => items.map((i) => i.label).join(' / ');
  test('the in-app routes give exactly the trails of the specification', () => {
    const rows = [
      [{ view: 'home' }, 'Home'], [{ view: 'phone' }, 'Workspace / Phone'], [{ view: 'phone', sub: 'dial-pad' }, 'Workspace / Phone / Dial Pad'], [{ view: 'phone', sub: 'join-meeting' }, 'Workspace / Phone / Join Meeting'],
      [{ view: 'phone', sub: 'recent-calls' }, 'Workspace / Phone / Recent Calls'], [{ view: 'phone', sub: 'contacts' }, 'Workspace / Phone / Contacts'], [{ view: 'phone', sub: 'numbers-plans' }, 'Workspace / Phone / Numbers & Plans'],
      [{ view: 'phone', sub: 'call-settings' }, 'Workspace / Phone / Call Settings'], [{ view: 'phone', sub: 'call-settings', section: 'calling' }, 'Workspace / Phone / Call Settings'],
      [{ view: 'phone', sub: 'call-settings', section: 'privacy-security' }, 'Workspace / Phone / Call Settings / Privacy & Security'], [{ view: 'phone', sub: 'call-settings', section: 'admin-controls' }, 'Workspace / Phone / Call Settings / Admin Controls'],
      [{ view: 'mail' }, 'Workspace / Mail'], [{ view: 'calendar' }, 'Workspace / Calendar'], [{ view: 'schedule' }, 'Workspace / Schedule'], [{ view: 'whiteboard' }, 'Workspace / Whiteboards'], [{ view: 'notes' }, 'Workspace / Notes'], [{ view: 'history' }, 'Workspace / History'], [{ view: 'settings' }, 'Workspace / Settings'],
      [{ view: 'docs' }, 'Workspace / Docs'], [{ view: 'docs', sub: '3f2b8c1e-5d4a-4b6e-8f01-2a3b4c5d6e7f' }, 'Workspace / Docs / Document'], [{ view: 'docs', sub: 'not-a-document-id' }, 'Workspace / Docs'],
      [{ view: 'phone', sub: 'bogus' }, 'Workspace / Phone'], [{ view: 'phone', sub: 'call-settings', section: 'nope' }, 'Workspace / Phone / Call Settings'], [{ view: 'mail', sub: 'dial-pad' }, 'Workspace / Mail'], [{ view: 'nonsense' }, 'Home'], [undefined, 'Home']];
    for (const [route, want] of rows) expect(labels(Crumbs.forRoute(route)), JSON.stringify(route)).toBe(want);
  });
  test('only parents link, only to real routes, and the last item (the current page) never does', () => {
    const t = Crumbs.forRoute({ view: 'phone', sub: 'call-settings', section: 'audio' });
    expect(t.map((i) => i.href)).toEqual(['#home', '#phone', '#phone/call-settings', undefined]); expect(Crumbs.forRoute({ view: 'home' })[0].href).toBeUndefined();
    for (const view of Object.keys(Crumbs.VIEW_LABELS)) { const last = Crumbs.forRoute({ view }).at(-1); expect(last.href, view).toBeUndefined(); }
  });
  test('path-style routes: the specification table, and private identifiers are never shown or linked', () => {
    const p = (s) => labels(Crumbs.forPath(s));
    expect(p('/')).toBe('Home'); expect(p('/phone')).toBe('Workspace / Phone'); expect(p('/phone/numbers-plans')).toBe('Workspace / Phone / Numbers & Plans'); expect(p('/documents')).toBe('Workspace / Documents'); expect(p('/app/suite')).toBe('Workspace / Documents');
    expect(p('/admin/security')).toBe('Workspace / Admin / Security Center'); expect(p('/phone/numbers-plans/')).toBe('Workspace / Phone / Numbers & Plans'); expect(p('/phone/call-settings?tab=1#x')).toBe('Workspace / Phone / Call Settings');
    const uuid = '3f2b8c1e-5d4a-4e7b-9c10-1a2b3c4d5e6f', ids = [uuid, '12345678901', 'a1b2c3d4e5f60718293a4b5c6d7e8f90', 'm_8f3k2j1h9d7s6a5', 'usr-48213'];
    for (const id of ids) {
      const trail = Crumbs.forPath('/meetings/' + id + '/chat'), text = JSON.stringify(trail); expect(text, id).not.toContain(id); expect(labels(trail), id).toBe('Workspace / Meetings / Meeting / Chat');
      expect(Crumbs.forPath('/accounts/' + id).map((i) => i.label).join('/'), id).toContain('Account'); expect(trail.every((i) => !i.href || !i.href.includes(id)), 'no link carries the id').toBe(true);
    }
    expect(Crumbs.looksLikeId('numbers-plans')).toBe(false); expect(Crumbs.looksLikeId('call-settings')).toBe(false); expect(Crumbs.looksLikeId('security')).toBe(false);
  });
});

test.describe('breadcrumbs in the real shell', () => {
  test.describe.configure({ mode: 'serial' });
  let stack; test.beforeAll(async () => { stack = await startMain(MAIN); }); test.afterAll(async () => { if (stack) stack.stop(); });
  const crumbs = (page) => page.locator('#crumbs li:not(.breadcrumb-separator)').allTextContents();
  async function signedIn(browser, viewport = { width: 1280, height: 800 }) {
    const ctx = await browser.newContext({ viewport }), username = 'bc' + rand();
    expect((await ctx.request.post(stack.base + '/api/auth/register', { data: { username, displayName: 'Crumb Tester', password: PASSWORD } })).status()).toBe(201); return { ctx, page: await ctx.newPage() };
  }
  const open = async (page, hash) => { await page.goto('about:blank'); await page.goto(stack.base + '/qorlla.html' + hash); await expect(page.locator('#view')).toBeAttached(); };      // always a real load: a deep link, not an in-page hash change
  const phoneReady = (page) => expect(page.locator('#phTab-dial')).toBeVisible({ timeout: 20000 });

  test('Home shows "Home"; the trail sits under the top bar and above the page, once; the sidebar is untouched', async ({ browser }) => {
    const { ctx, page } = await signedIn(browser); await open(page, '#home');
    await expect(page.locator('nav[aria-label="Breadcrumb"]')).toHaveCount(1); expect(await crumbs(page)).toEqual(['Home']); await expect(page.locator('#crumbs a')).toHaveCount(0);
    const y = async (sel) => (await page.locator(sel).boundingBox()).y; expect(await y('header.topbar')).toBeLessThan(await y('#crumbs')); expect(await y('#crumbs')).toBeLessThan(await y('#content'));
    await expect(page.locator('.sidebar .nav-item[data-view=phone]')).toBeVisible(); await ctx.close();
  });
  test('navigating from the sidebar updates the trail; the current page is not a link and is announced as the current page', async ({ browser }) => {
    const { ctx, page } = await signedIn(browser); await open(page, '#home');
    await page.locator('.nav-item[data-view=phone]').click(); await phoneReady(page); expect(await crumbs(page)).toEqual(['Workspace', 'Phone']);
    const current = page.locator('#crumbs [aria-current="page"]'); await expect(current).toHaveText('Phone'); expect(await current.evaluate((e) => e.tagName)).toBe('SPAN');
    await expect(page.locator('#crumbs a')).toHaveCount(1); await expect(page.locator('#crumbs a')).toHaveAttribute('href', '#home');
    await page.locator('.nav-item[data-view=mail]').click(); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Mail']); expect(await page.evaluate(() => location.hash)).toBe('#mail');
    await page.locator('.nav-item[data-view=calendar]').click(); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Calendar']);
    await page.locator('.nav-item[data-view=home]').click(); await expect.poll(() => crumbs(page)).toEqual(['Home']); await ctx.close();
  });
  test('every Phone tab, Call Settings and its sections give the specified trail, and the address bar follows', async ({ browser }) => {
    const { ctx, page } = await signedIn(browser); await open(page, '#phone'); await phoneReady(page); expect(await crumbs(page)).toEqual(['Workspace', 'Phone']);
    await expect(page.locator('nav[aria-label="Breadcrumb"]'), 'the Phone page does not add a second breadcrumb').toHaveCount(1);
    for (const [tab, label, slug] of [['dial', 'Dial Pad', 'dial-pad'], ['join', 'Join Meeting', 'join-meeting'], ['recent', 'Recent Calls', 'recent-calls'], ['contacts', 'Contacts', 'contacts'], ['settings', 'Numbers & Plans', 'numbers-plans']]) {
      await page.locator('#phTab-' + tab).click(); await expect.poll(() => crumbs(page), tab).toEqual(['Workspace', 'Phone', label]); expect(await page.evaluate(() => location.hash)).toBe('#phone/' + slug);
    }
    await page.locator('#phSettingsBtn').click(); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Phone', 'Call Settings']); expect(await page.evaluate(() => location.hash)).toBe('#phone/call-settings');
    await expect(page.locator('#psNav-audio')).toBeVisible({ timeout: 15000 }); await page.locator('#psNav-audio').click();
    await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Phone', 'Call Settings', 'Audio & Devices']); expect(await page.evaluate(() => location.hash)).toBe('#phone/call-settings/audio'.replace('audio', 'audio'));
    await page.locator('#psNav-calling').click(); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Phone', 'Call Settings']);
    await page.locator('#psNav-privacy').click(); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Phone', 'Call Settings', 'Privacy & Security']); await ctx.close();
  });
  test('parent crumbs navigate: Call Settings section -> Call Settings -> Phone -> Workspace', async ({ browser }) => {
    const { ctx, page } = await signedIn(browser); await open(page, '#phone/call-settings/audio'); await expect(page.locator('#psNav-audio')).toHaveAttribute('aria-selected', 'true', { timeout: 20000 });
    expect(await crumbs(page)).toEqual(['Workspace', 'Phone', 'Call Settings', 'Audio & Devices']);
    await page.locator('#crumbs a', { hasText: 'Call Settings' }).click(); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Phone', 'Call Settings']); await expect(page.locator('#psNav-calling')).toHaveAttribute('aria-selected', 'true');
    await page.locator('#crumbs a', { hasText: 'Phone' }).click(); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Phone']); await expect(page.locator('#phTab-dial')).toBeVisible();
    await page.locator('#crumbs a', { hasText: 'Workspace' }).click(); await expect.poll(() => crumbs(page)).toEqual(['Home']); await expect(page.locator('body')).toHaveClass(/on-home/); await ctx.close();
  });
  test('browser Back and Forward walk through the sections and the trail (and the visible tab) follow', async ({ browser }) => {
    const { ctx, page } = await signedIn(browser); await open(page, '#phone'); await phoneReady(page);
    await page.locator('#phTab-recent').click(); await page.locator('#phTab-contacts').click(); await page.locator('#phTab-settings').click();
    expect(await crumbs(page)).toEqual(['Workspace', 'Phone', 'Numbers & Plans']);
    await page.goBack(); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Phone', 'Contacts']); await expect(page.locator('#phTab-contacts')).toHaveAttribute('aria-selected', 'true');
    await page.goBack(); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Phone', 'Recent Calls']); await expect(page.locator('#phTab-recent')).toHaveAttribute('aria-selected', 'true');
    await page.goForward(); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Phone', 'Contacts']);
    await page.goForward(); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Phone', 'Numbers & Plans']); await expect(page.locator('#phTab-settings')).toHaveAttribute('aria-selected', 'true'); await ctx.close();
  });
  test('Back from Call Settings returns to the tab it came from', async ({ browser }) => {
    const { ctx, page } = await signedIn(browser); await open(page, '#phone'); await phoneReady(page); await page.locator('#phTab-join').click(); await page.locator('#phSettingsBtn').click(); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Phone', 'Call Settings']);
    await page.goBack(); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Phone', 'Join Meeting']); await expect(page.locator('#phTab-join')).toHaveAttribute('aria-selected', 'true'); await expect(page.locator('#phSettingsBtn')).toBeVisible(); await ctx.close();
  });
  test('deep links and refreshes land on the right page with the right trail', async ({ browser }) => {
    const { ctx, page } = await signedIn(browser);
    for (const [hash, trail, check] of [['#phone/numbers-plans', ['Workspace', 'Phone', 'Numbers & Plans'], () => expect(page.locator('#phTab-settings')).toHaveAttribute('aria-selected', 'true', { timeout: 20000 })],
      ['#phone/recent-calls', ['Workspace', 'Phone', 'Recent Calls'], () => expect(page.locator('#phTab-recent')).toHaveAttribute('aria-selected', 'true', { timeout: 20000 })],
      ['#phone/call-settings/privacy-security', ['Workspace', 'Phone', 'Call Settings', 'Privacy & Security'], () => expect(page.locator('#psNav-privacy')).toHaveAttribute('aria-selected', 'true', { timeout: 20000 })],
      ['#phone/help', ['Workspace', 'Phone', 'Help'], () => expect(page.locator('#phHelp, .qp-wide').first()).toBeAttached({ timeout: 20000 })],
      ['#mail', ['Workspace', 'Mail'], () => expect(page.locator('.nav-item[data-view=mail]')).toHaveClass(/active/)]]) {
      await open(page, hash); await check(); expect(await crumbs(page), hash).toEqual(trail);
      await page.reload(); await check(); expect(await crumbs(page), 'after a refresh: ' + hash).toEqual(trail); expect(await page.evaluate(() => location.hash)).toBe(hash);
    }
    await ctx.close();
  });
  test('unknown or malformed routes fall back to the nearest real page and the address bar is corrected', async ({ browser }) => {
    const { ctx, page } = await signedIn(browser);
    await open(page, '#phone/bogus'); await phoneReady(page); expect(await crumbs(page)).toEqual(['Workspace', 'Phone']); await expect.poll(() => page.evaluate(() => location.hash)).toBe('#phone');
    await open(page, '#phone/call-settings/not-a-section'); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Phone', 'Call Settings']); await expect.poll(() => page.evaluate(() => location.hash)).toBe('#phone/call-settings');
    await open(page, '#mail/dial-pad'); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Mail']); await open(page, '#nonsense/x/y'); await expect.poll(() => crumbs(page)).toEqual(['Home']);
    await open(page, '#phone/%3Cimg%20src=x%20onerror=alert(1)%3E'); await phoneReady(page); expect(await crumbs(page)).toEqual(['Workspace', 'Phone']); await ctx.close();
  });
  test('access control: signed-out visitors get no trail (and no labels for pages they cannot see); a non-administrator opening Admin Controls sees the refusal under an honest trail', async ({ browser, page: anon }) => {
    await open(anon, '#phone/numbers-plans'); await expect(anon.locator('iframe.login-embed')).toBeAttached({ timeout: 15000 }); await expect(anon.locator('#crumbs')).toBeHidden(); expect(await anon.locator('#crumbs').textContent()).not.toContain('Numbers');
    const { ctx, page } = await signedIn(browser); await open(page, '#phone/call-settings/admin-controls'); await expect(page.locator('#psAdminNote')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#psAdminNote')).toHaveClass(/qp-bad/); expect(await crumbs(page)).toEqual(['Workspace', 'Phone', 'Call Settings', 'Admin Controls']); await ctx.close();
  });
  test('the trail renders text only: a hostile label cannot inject markup', async ({ browser }) => {
    const { ctx, page } = await signedIn(browser); await open(page, '#home');
    await page.evaluate(() => window.QorllaCrumbs.render(document.getElementById('crumbs'), [{ label: 'Workspace', href: '#home' }, { label: '<img src=x onerror="window.__xss=1">' }]));
    expect(await page.evaluate(() => window.__xss)).toBeUndefined(); await expect(page.locator('#crumbs img')).toHaveCount(0); await expect(page.locator('#crumbs .current')).toHaveText('<img src=x onerror="window.__xss=1">'); await ctx.close();
  });
  test('accessibility: one labelled navigation landmark with an ordered list; separators are hidden from assistive technology; links are keyboard reachable with a visible focus style', async ({ browser }) => {
    const { ctx, page } = await signedIn(browser); await open(page, '#phone/call-settings/audio'); await expect(page.locator('#psNav-audio')).toBeVisible({ timeout: 20000 });
    const nav = page.getByRole('navigation', { name: 'Breadcrumb' }); await expect(nav).toHaveCount(1); await expect(nav.getByRole('list')).toHaveCount(1); await expect(nav.getByRole('listitem').filter({ hasNot: page.locator('.breadcrumb-separator') })).toHaveCount(4);
    for (const sep of await page.locator('#crumbs .breadcrumb-separator').all()) await expect(sep).toHaveAttribute('aria-hidden', 'true');
    await expect(nav.getByRole('link')).toHaveCount(3); await expect(nav.locator('[aria-current="page"]')).toHaveText('Audio & Devices');
    await nav.getByRole('link').first().focus(); const outline = await nav.getByRole('link').first().evaluate((e) => getComputedStyle(e).outlineStyle); expect(outline).not.toBe('none');
    await page.keyboard.press('Enter'); await expect.poll(() => crumbs(page)).toEqual(['Home']); await ctx.close();
  });
  test('mobile: a long trail wraps and never causes horizontal scrolling', async ({ browser }) => {
    const { ctx, page } = await signedIn(browser, { width: 360, height: 740 }); await open(page, '#phone/call-settings/privacy-security'); await expect(page.locator('#psNav-privacy')).toBeVisible({ timeout: 20000 });
    expect(await crumbs(page)).toEqual(['Workspace', 'Phone', 'Call Settings', 'Privacy & Security']); await expect(page.locator('#crumbs')).toBeVisible();
    const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth, crumb: document.getElementById('crumbs').scrollWidth, crumbBox: document.getElementById('crumbs').clientWidth }));
    expect(m.doc).toBeLessThanOrEqual(m.win); expect(m.crumb).toBeLessThanOrEqual(m.crumbBox + 1); await ctx.close();
  });
  test('existing behaviour is unchanged: the close button, the phone tabs and the sidebar still work and the page stack is intact', async ({ browser }) => {
    const { ctx, page } = await signedIn(browser, { width: 400, height: 800 }); await open(page, '#home'); await page.locator('.nav-item[data-view=phone]').click(); await phoneReady(page); await page.locator('#phTab-contacts').click();      // the close button is the phone layout's way back
    await expect(page.locator('.nav-item[data-view=phone]')).toHaveAttribute('aria-current', 'page'); await page.locator('#viewClose').click(); await expect.poll(() => crumbs(page)).toEqual(['Home']);
    await page.locator('.nav-item[data-view=phone]').click(); await phoneReady(page); expect(await crumbs(page)).toEqual(['Workspace', 'Phone']); await expect(page.locator('#phTab-dial')).toHaveAttribute('aria-selected', 'true'); await ctx.close();
  });
});
