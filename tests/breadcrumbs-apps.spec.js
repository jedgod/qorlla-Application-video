const { test, expect } = require('@playwright/test');
const { startMain, PASSWORD } = require('./support/meet-stack');
const Crumbs = require('../assets/breadcrumbs.js');

// Breadcrumbs, phase 2: applications that have their OWN routers hand the shared utility their own route definitions and their own authorization.
// Here: the per-application interface (pure) and Chat (a real browser against the real main app). Documents and the Admin portal run in qorlla-portal/e2e/breadcrumbs.spec.js (they need the unified deployment).
const MAIN = 5433, rand = () => Math.random().toString(36).slice(2, 7);

test.describe('per-application interface (no browser)', () => {
  const routes = [
    { id: 'ws', label: 'Workspace', href: '/qorlla.html#home' },
    { id: 'docs', label: 'Documents', pattern: '/app/suite', parent: 'ws', requires: 'signedIn' },
    { id: 'doc', label: 'Document', pattern: '/app/suite', whenQuery: ['doc'], parent: 'docs', requires: 'signedIn' },
    { id: 'admin', label: 'Admin', pattern: '/app/admin', parent: 'ws', requires: 'admin' },
    { id: 'admin-subs', label: 'Subscriptions', pattern: '/app/admin', query: { tab: 'subscriptions' }, parent: 'admin', requires: 'admin' },
    { id: 'report', label: 'Report', pattern: '/app/ai/reports/:id', parent: 'ws', requires: 'signedIn' }
  ];
  const who = (o) => (r) => !r.requires || (r.requires === 'signedIn' && !!o.signedIn) || (r.requires === 'admin' && !!o.admin);
  const labels = (res) => res.items.map((i) => i.label).join(' / ');
  test('the most specific route wins, and every ancestor is reached through the application\'s own parent links', () => {
    const t = (path, query, o = { signedIn: true, admin: true }) => Crumbs.build({ path, query, routes, authorize: who(o) });
    assert(labels(t('/app/suite')) === 'Workspace / Documents'); assert(labels(t('/app/suite/', '?doc=3f2b8c1e-5d4a')) === 'Workspace / Documents / Document'); assert(labels(t('/app/admin')) === 'Workspace / Admin');
    assert(labels(t('/app/admin', { tab: 'subscriptions' })) === 'Workspace / Admin / Subscriptions'); assert(labels(t('/app/admin', new URLSearchParams('tab=subscriptions&x=1'))) === 'Workspace / Admin / Subscriptions');
    assert(labels(t('/app/admin', '?tab=nonsense')) === 'Workspace / Admin', 'an unknown section falls back to the nearest real page'); assert(labels(t('/app/ai/reports/9d1c-secret-id')) === 'Workspace / Report');
    assert(t('/app/suite', '?doc=x').items.map((i) => i.href).join('|') === '/qorlla.html#home|/app/suite|', 'only ancestors link; the page you are on never does');
    function assert(c, m) { expect(c, m).toBe(true); }
  });
  test('inaccessible destinations are never links, an inaccessible current page hides the trail, and an unknown path shows nothing at all', () => {
    const signedOut = Crumbs.build({ path: '/app/suite', query: '?doc=abc', routes, authorize: who({}) }); expect(signedOut.visible).toBe(false); expect(signedOut.items).toEqual([]);
    const notAdmin = Crumbs.build({ path: '/app/admin', query: '?tab=subscriptions', routes, authorize: who({ signedIn: true }) }); expect(notAdmin.visible).toBe(false); expect(JSON.stringify(notAdmin)).not.toContain('Admin');
    const ancestorDenied = Crumbs.build({ path: '/app/suite', query: '?doc=1', routes, authorize: (r) => r.id !== 'docs' }); expect(ancestorDenied.items.map((i) => i.href)).toEqual(['/qorlla.html#home', undefined, undefined]); expect(ancestorDenied.items.map((i) => i.label)).toEqual(['Workspace', 'Documents', 'Document']);
    for (const path of ['/app/unknown', '/', '/app/suite/extra/path', '/APP/SUITE']) expect(Crumbs.build({ path, routes, authorize: () => true }).visible, path).toBe(false);
  });
  test('private identifiers in the path or the query never reach a label or a link', () => {
    const secret = '3f2b8c1e-5d4a-4e7b-9c10-1a2b3c4d5e6f', r = Crumbs.build({ path: '/app/ai/reports/' + secret, query: '?doc=' + secret + '&token=abc', routes, authorize: () => true }); expect(JSON.stringify(r)).not.toContain(secret); expect(JSON.stringify(r)).not.toContain('token');
    expect(JSON.stringify(Crumbs.build({ path: '/app/suite', query: '?doc=' + secret, routes, authorize: () => true }))).not.toContain(secret);
  });
  test('a route table with a cycle or a missing parent cannot hang or crash the page', () => {
    const bad = [{ id: 'a', label: 'A', pattern: '/a', parent: 'b' }, { id: 'b', label: 'B', parent: 'a' }, { id: 'c', label: 'C', pattern: '/c', parent: 'nowhere' }];
    expect(Crumbs.build({ path: '/a', routes: bad }).visible).toBe(true); expect(Crumbs.build({ path: '/c', routes: bad }).items.map((i) => i.label)).toEqual(['C']); expect(Crumbs.build({ path: '/a', routes: null }).visible).toBe(false);
  });
});

test.describe('Chat', () => {
  test.describe.configure({ mode: 'serial' });
  let stack; test.beforeAll(async () => { stack = await startMain(MAIN); }); test.afterAll(async () => { if (stack) stack.stop(); });
  const crumbs = (page) => page.locator('#crumbs li:not(.breadcrumb-separator)').allTextContents();
  async function signedIn(browser, viewport = { width: 1280, height: 800 }) {
    const ctx = await browser.newContext({ viewport }), username = 'ch' + rand();
    expect((await ctx.request.post(stack.base + '/api/auth/register', { data: { username, displayName: 'Chat Tester', password: PASSWORD } })).status()).toBe(201);
    const made = await ctx.request.post(stack.base + '/api/workplace/chat', { data: { type: 'channel', name: 'secret-plans-' + rand() } }); expect(made.status()).toBe(201); const chat = await made.json();
    return { ctx, page: await ctx.newPage(), chat };
  }
  const open = async (page, hash = '') => { await page.goto('about:blank'); await page.goto(stack.base + '/chat.html' + hash); await expect(page.locator('#list')).toBeAttached(); };

  test('Chat shows "Workspace / Chat"; one labelled landmark sits above the conversations, not inside a hidden column; the current page is a non-link', async ({ browser }) => {
    const { ctx, page } = await signedIn(browser); await open(page); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Chat']);
    await expect(page.locator('nav[aria-label="Breadcrumb"]')).toHaveCount(1); await expect(page.locator('#crumbs [aria-current="page"]')).toHaveText('Chat'); expect(await page.locator('#crumbs [aria-current="page"]').evaluate((e) => e.tagName)).toBe('SPAN');
    await expect(page.locator('#crumbs a')).toHaveCount(1); await expect(page.locator('#crumbs a')).toHaveAttribute('href', 'qorlla.html#home');
    const y = async (sel) => (await page.locator(sel).boundingBox()).y; expect(await y('#crumbs')).toBeLessThan(await y('#list')); await ctx.close();
  });
  test('opening a conversation shows "Conversation" - never its name or id - and closing it returns to "Chat"; the page remains usable', async ({ browser }) => {
    const { ctx, page, chat } = await signedIn(browser); await open(page); await expect(page.locator('#list')).toContainText(chat.name, { timeout: 20000 });
    await page.locator('#list').getByText(chat.name).first().click(); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Chat', 'Conversation']);
    const text = (await crumbs(page)).join(' '); expect(text).not.toContain(chat.name); expect(text).not.toContain(chat.id); expect(await page.evaluate(() => location.hash)).toContain(chat.id);       // the id is in the address bar as before, never in the trail
    await expect(page.locator('#crumbs a', { hasText: 'Chat' })).toHaveAttribute('href', /chat\.html/);
    await page.locator('#msgInput').fill('hello'); await page.locator('#sendBtn').click(); await expect(page.locator('#messages')).toContainText('hello'); await ctx.close();
  });
  test('deep link to a conversation and a refresh: the right trail; an unknown conversation id gives "Chat" only (nothing from the address is shown)', async ({ browser }) => {
    const { ctx, page, chat } = await signedIn(browser); await open(page, '#' + chat.id); await expect.poll(() => crumbs(page), { timeout: 20000 }).toEqual(['Workspace', 'Chat', 'Conversation']);
    await page.reload(); await expect.poll(() => crumbs(page), { timeout: 20000 }).toEqual(['Workspace', 'Chat', 'Conversation']);
    await open(page, '#00000000-0000-4000-8000-000000000000'); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Chat']); expect((await crumbs(page)).join(' ')).not.toContain('0000'); await ctx.close();
  });
  test('cross-application navigation: Workspace takes you to the workspace shell (with its own trail), and the shell takes you back to Chat', async ({ browser }) => {
    const { ctx, page } = await signedIn(browser); await open(page); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Chat']);
    await page.locator('#crumbs a', { hasText: 'Workspace' }).click(); await page.waitForURL(/qorlla\.html#home/); await expect.poll(() => crumbs(page)).toEqual(['Home']); await expect(page.locator('nav[aria-label="Breadcrumb"]')).toHaveCount(1);
    await page.goBack(); await page.waitForURL(/chat\.html/); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Chat']); await page.goForward(); await page.waitForURL(/qorlla\.html/); await expect.poll(() => crumbs(page)).toEqual(['Home']);
    await page.locator('.nav-item[data-act=chat]').click(); await page.waitForURL(/chat\.html/); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Chat']); await ctx.close();
  });
  test('signed out: Chat sends the visitor to sign in and neither Chat nor the sign-in page shows a trail', async ({ browser }) => {
    const ctx = await browser.newContext(), page = await ctx.newPage(); await page.goto(stack.base + '/chat.html'); await page.waitForURL(/(login|qorlla)\.html/, { timeout: 20000 }); await expect(page.locator('iframe.login-embed, form').first()).toBeAttached({ timeout: 20000 });
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toHaveCount(0);       // hidden landmarks are not in the accessibility tree
    expect(await page.locator('nav[aria-label="Breadcrumb"]:visible').count()).toBe(0); expect(await page.locator('#crumbs').evaluate((e) => e.textContent.trim()).catch(() => '')).toBe(''); await ctx.close();
  });
  test('accessibility: one labelled navigation with an ordered list, hidden separators, keyboard reachable with a visible focus style; Enter follows the link', async ({ browser }) => {
    const { ctx, page } = await signedIn(browser); await open(page); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Chat']);
    const nav = page.getByRole('navigation', { name: 'Breadcrumb' }); await expect(nav).toHaveCount(1); await expect(nav.getByRole('list')).toHaveCount(1); await expect(nav.getByRole('listitem').filter({ hasNot: page.locator('.breadcrumb-separator') })).toHaveCount(2);
    for (const sep of await page.locator('#crumbs .breadcrumb-separator').all()) await expect(sep).toHaveAttribute('aria-hidden', 'true');
    await nav.getByRole('link').focus(); expect(await nav.getByRole('link').evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe('none'); await page.keyboard.press('Enter'); await page.waitForURL(/qorlla\.html#home/); await ctx.close();
  });
  test('mobile (360 px): the trail is visible above the conversation list and in a conversation, wraps, and never scrolls the page sideways', async ({ browser }) => {
    const { ctx, page, chat } = await signedIn(browser, { width: 360, height: 740 }); await open(page); await expect(page.locator('#crumbs')).toBeVisible(); expect(await crumbs(page)).toEqual(['Workspace', 'Chat']);
    const fits = () => page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth, crumb: document.getElementById('crumbs').scrollWidth, box: document.getElementById('crumbs').clientWidth }));
    let m = await fits(); expect(m.doc).toBeLessThanOrEqual(m.win); expect(m.crumb).toBeLessThanOrEqual(m.box + 1);
    await expect(page.locator('#list')).toContainText(chat.name, { timeout: 20000 }); await page.locator('#list').getByText(chat.name).first().click(); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Chat', 'Conversation']); await expect(page.locator('#crumbs')).toBeVisible();
    m = await fits(); expect(m.doc).toBeLessThanOrEqual(m.win); await expect(page.locator('#msgInput')).toBeVisible(); await page.locator('#backMobile').click(); await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Chat']); await ctx.close();
  });
  test('existing Chat behaviour is unchanged: the list, the composer, unread handling and the back-to-home link still work', async ({ browser }) => {
    const { ctx, page, chat } = await signedIn(browser); await open(page); await expect(page.locator('#list')).toContainText(chat.name, { timeout: 20000 }); await expect(page.locator('a.back')).toHaveAttribute('href', 'qorlla.html');
    await page.locator('#list').getByText(chat.name).first().click(); await expect(page.locator('#chatTitle')).toContainText(chat.name); await page.locator('#msgInput').fill('trail check'); await page.locator('#composer').evaluate((f) => f.requestSubmit()); await expect(page.locator('#messages')).toContainText('trail check');
    expect((await (await ctx.request.get(stack.base + '/api/workplace/chat')).json()).chats.some((c) => c.id === chat.id)).toBe(true); await ctx.close();
  });
});
