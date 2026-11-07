const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Qorlla Sources: the per-account switches that decide which of your own content the AI assistant may read.
// API tests use the request fixture; the last group drives the real panel in a browser.

const PASSWORD = 'Sources-test-9917!';
const SOURCES = ['meetings', 'canvas', 'chat', 'my_notes', 'mail'];
const API = '/api/workplace/ai';

const uname = () => 'qs' + Math.random().toString(36).slice(2, 12);

async function signUp(request) {
  const username = uname();
  const r = await request.post('/api/auth/register', { data: { username, password: PASSWORD } });
  expect(r.status()).toBe(201);
  return username;
}
async function token(request) { return (await (await request.get('/api/auth/csrf')).json()).token; }
async function patch(request, url, data, t) {
  return request.patch(API + url, { data, headers: t ? { 'X-CSRF-Token': t } : {} });
}
async function settings(request) { return (await request.get(API + '/sources')).json(); }
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

test.describe('API: authentication and CSRF', () => {
  test('every source endpoint rejects a signed-out caller', async ({ request }) => {
    for (const [method, url] of [['get', '/sources'], ['patch', '/sources'], ['patch', '/sources/chat'], ['get', '/context/meetings'], ['get', '/context/my_notes'], ['get', '/context/mail'], ['get', '/chats']]) {
      const r = await request[method](API + url, { data: method === 'patch' ? { enabled: false } : undefined });
      expect(r.status(), method + ' ' + url).toBe(401);
    }
  });

  test('writes without a valid CSRF token are rejected and change nothing', async ({ request }) => {
    await signUp(request);
    const t = await token(request);
    for (const bad of [undefined, '', 'nope', t.slice(0, -1) + (t.endsWith('0') ? '1' : '0')]) {
      const r = await patch(request, '/sources/chat', { enabled: false }, bad);
      expect(r.status()).toBe(403);
      expect((await r.json()).code).toBe('csrf');
    }
    expect((await request.put(API + '/chats/cabc123', { data: { messages: [] } })).status()).toBe(403);
    expect((await request.delete(API + '/chats/cabc123')).status()).toBe(403);
    expect((await settings(request)).sources.chat).toBe(true);
    expect((await patch(request, '/sources/chat', { enabled: false }, t)).status()).toBe(200);
  });

  test('a cross-site Origin is rejected even with a valid token', async ({ request }) => {
    await signUp(request);
    const t = await token(request);
    const r = await request.patch(API + '/sources/chat', { data: { enabled: false }, headers: { 'X-CSRF-Token': t, Origin: 'https://evil.example' } });
    expect(r.status()).toBe(403);
    expect((await settings(request)).sources.chat).toBe(true);
  });

  test("one session's token does not work for another session", async ({ request, playwright, baseURL }) => {
    await signUp(request);
    const stolen = await token(request);
    const other = await playwright.request.newContext({ baseURL });
    await signUp(other);
    const r = await patch(other, '/sources/chat', { enabled: false }, stolen);
    expect(r.status()).toBe(403);
    await other.dispose();
  });
});

test.describe('API: switches', () => {
  test('defaults are all on; invalid sources and values are rejected', async ({ request }) => {
    await signUp(request);
    const t = await token(request);
    const s = await settings(request);
    expect(s.masterEnabled).toBe(true);
    SOURCES.forEach((k) => { expect(s.sources[k]).toBe(true); expect(s.effective[k]).toBe(true); });
    for (const [url, body] of [['/sources/evil', { enabled: true }], ['/sources/__proto__', { enabled: true }], ['/sources/chat', { enabled: 'false' }], ['/sources/chat', {}], ['/sources/chat', { enabled: false, extra: 1 }], ['/sources', { enabled: 1 }], ['/sources', null]]) {
      const r = await patch(request, url, body, t);
      expect(r.status(), url + ' ' + JSON.stringify(body)).toBe(400);
    }
    expect((await settings(request)).version).toBe(1);
  });

  test('master off blocks all sources, one off blocks only that source, master on restores choices', async ({ request }) => {
    await signUp(request);
    const t = await token(request);
    const ctx = async (name) => (await request.get(API + '/context/' + name)).status();

    for (const k of ['meetings', 'my_notes', 'mail']) expect(await ctx(k)).toBe(200);

    await patch(request, '/sources/my_notes', { enabled: false }, t);
    expect(await ctx('my_notes')).toBe(403);
    expect(await ctx('meetings')).toBe(200);
    expect(await ctx('mail')).toBe(200);

    await patch(request, '/sources', { enabled: false }, t);
    for (const k of ['meetings', 'my_notes', 'mail']) expect(await ctx(k)).toBe(403);
    const off = await settings(request);
    SOURCES.forEach((k) => expect(off.effective[k]).toBe(false));
    expect(off.sources.meetings).toBe(true);       // the choice is kept, only the effect is off
    expect(off.sources.my_notes).toBe(false);

    await patch(request, '/sources', { enabled: true }, t);
    expect(await ctx('meetings')).toBe(200);
    expect(await ctx('mail')).toBe(200);
    expect(await ctx('my_notes')).toBe(403);       // My Notes was off before the master was toggled
  });

  test('two accounts cannot read or change each other\'s settings', async ({ request, playwright, baseURL }) => {
    await signUp(request);
    const other = await playwright.request.newContext({ baseURL });
    await signUp(other);
    await patch(request, '/sources/mail', { enabled: false }, await token(request));
    expect((await settings(request)).sources.mail).toBe(false);
    expect((await settings(other)).sources.mail).toBe(true);
    expect((await other.get(API + '/context/mail')).status()).toBe(200);
    // the API has no way to address another account: ids in the path are not accepted
    expect((await patch(other, '/sources/' + encodeURIComponent('../u_x'), { enabled: false }, await token(other))).status()).toBe(400);
    expect((await settings(request)).sources.mail).toBe(false);
    await other.dispose();
  });

  test('parallel updates are all applied and the stored file stays valid', async ({ request }) => {
    await signUp(request);
    const t = await token(request);
    for (let round = 0; round < 3; round++) {
      const want = round % 2 === 0 ? false : true;
      const before = (await settings(request)).version;
      const calls = SOURCES.map((k) => patch(request, '/sources/' + k, { enabled: want }, t)).concat([patch(request, '/sources', { enabled: want }, t)]);
      const results = await Promise.all(calls);
      results.forEach((r) => expect(r.status()).toBe(200));
      const after = await settings(request);
      SOURCES.forEach((k) => expect(after.sources[k]).toBe(want));
      expect(after.masterEnabled).toBe(want);
      expect(after.version).toBe(before + 6);      // every one of the six changes was counted once
    }
  });
});

test.describe('API: persistence across a server restart', () => {
  test('settings and chat history survive restarting the server', async ({ playwright }) => {
    test.setTimeout(90000);
    const port = '5' + String(190 + Math.floor(Math.random() * 9)) + '1';
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qorlla-sources-'));
    const env = { ...process.env, PORT: port, DATA_DIR: dataDir };
    delete env.ELECTRON_RUN_AS_NODE;
    const boot = async () => {
      const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
      for (let i = 0; i < 60; i++) {
        try { if ((await fetch('http://localhost:' + port + '/api/health')).ok) return child; } catch (e) { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 500));
      }
      child.kill(); throw new Error('server did not start');
    };
    const stop = (child) => new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    const baseURL = 'http://localhost:' + port;
    let child = await boot();
    try {
      const user = uname();
      let ctx = await playwright.request.newContext({ baseURL });
      expect((await ctx.post('/api/auth/register', { data: { username: user, password: PASSWORD } })).status()).toBe(201);
      const t = await token(ctx);
      await patch(ctx, '/sources/canvas', { enabled: false }, t);
      await patch(ctx, '/sources', { enabled: false }, t);
      await ctx.put(API + '/chats/cpersist1', { data: { title: 'Kept', messages: [{ role: 'me', text: 'hello' }] }, headers: { 'X-CSRF-Token': t } });
      await ctx.dispose();
      await stop(child);

      child = await boot();
      ctx = await playwright.request.newContext({ baseURL });
      expect((await ctx.post('/api/auth/login', { data: { username: user, password: PASSWORD } })).status()).toBe(200);
      const s = await settings(ctx);
      expect(s.masterEnabled).toBe(false);
      expect(s.sources.canvas).toBe(false);
      expect(s.sources.meetings).toBe(true);
      const chats = (await (await ctx.get(API + '/chats')).json()).chats;
      expect(chats.map((c) => c.title)).toEqual(['Kept']);
      await ctx.dispose();
    } finally {
      await stop(child);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

test.describe('API: chat history', () => {
  test('rename, soft delete, validation and isolation between accounts', async ({ request, playwright, baseURL }) => {
    await signUp(request);
    const t = await token(request);
    const h = { 'X-CSRF-Token': t };
    expect((await request.put(API + '/chats/cabc123', { data: { title: 'One', messages: [{ role: 'me', text: 'a' }] }, headers: h })).status()).toBe(200);
    expect((await request.put(API + '/chats/..%2Fx', { data: { messages: [] }, headers: h })).status()).toBe(400);
    expect((await request.put(API + '/chats/cabc124', { data: { messages: [{ role: 'bad', text: 'x' }] }, headers: h })).status()).toBe(400);
    expect((await request.patch(API + '/chats/cabc123', { data: { title: '   ' }, headers: h })).status()).toBe(400);
    expect((await request.patch(API + '/chats/cabc123', { data: { title: 'Two' }, headers: h })).status()).toBe(200);

    const other = await playwright.request.newContext({ baseURL });
    await signUp(other);
    expect((await (await other.get(API + '/chats')).json()).chats).toEqual([]);
    expect((await other.delete(API + '/chats/cabc123', { headers: { 'X-CSRF-Token': await token(other) } })).status()).toBe(404);
    await other.dispose();

    expect((await request.delete(API + '/chats/cabc123', { headers: h })).status()).toBe(200);
    expect((await (await request.get(API + '/chats')).json()).chats).toEqual([]);
    expect((await request.delete(API + '/chats/cabc123', { headers: h })).status()).toBe(404);
  });
});

test.describe('Browser: the panel and the real AI context', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  async function seed(page) {
    const username = await signUp(page.request);
    const marker = 'ZEBRA' + Math.floor(Math.random() * 1e5);
    const tomorrow = new Date(Date.now() + 86400000);
    expect((await page.request.post('/api/workplace/notes', { data: { title: 'Plan ' + marker, content: 'TODO: ship ' + marker } })).status()).toBe(201);
    expect((await page.request.post('/api/workplace/calendar', { data: { title: 'Sync ' + marker, date: ymd(tomorrow), start: '10:00', end: '11:00' } })).status()).toBe(201);
    return { username, marker };
  }
  const openSources = async (page) => {
    await page.locator('#aiSources').click();
    await expect(page.locator('#aiSrcPop')).toBeVisible();
    if ((await page.locator('#aiSrcPop .exp').getAttribute('aria-expanded')) !== 'true') await page.locator('#aiSrcPop .exp').click();
  };
  const sw = (page, name) => page.locator('#aiSrcPop').getByRole('switch', { name: new RegExp('^' + name) });
  const thread = (page) => page.locator('#aiThread');

  test('panel loads defaults, saves each switch, and keeps them after reload and sign-out/in', async ({ page }) => {
    const { username } = await seed(page);
    await page.goto('/qorlla.html');
    await openSources(page);
    for (const n of ['Qorlla Sources', 'Meetings', 'Canvas', 'Chat', 'My Notes', 'Mail']) await expect(sw(page, n)).toHaveAttribute('aria-checked', 'true');

    await sw(page, 'My Notes').click();
    await expect(sw(page, 'My Notes')).toHaveAttribute('aria-checked', 'false');
    await sw(page, 'Qorlla Sources').click();
    await expect(sw(page, 'Qorlla Sources')).toHaveAttribute('aria-checked', 'false');

    await page.reload();
    await openSources(page);
    await expect(sw(page, 'Qorlla Sources')).toHaveAttribute('aria-checked', 'false');
    await expect(sw(page, 'My Notes')).toHaveAttribute('aria-checked', 'false');
    await expect(sw(page, 'Meetings')).toHaveAttribute('aria-checked', 'true'); // choice kept while master is off

    await page.request.post('/api/auth/logout', { headers: { 'X-CSRF-Token': 'x' } });
    expect((await page.request.post('/api/auth/login', { data: { username, password: PASSWORD } })).status()).toBe(200);
    await page.reload();
    await openSources(page);
    await expect(sw(page, 'Qorlla Sources')).toHaveAttribute('aria-checked', 'false');
    await sw(page, 'Qorlla Sources').click();
    await expect(sw(page, 'Qorlla Sources')).toHaveAttribute('aria-checked', 'true');
    await expect(sw(page, 'My Notes')).toHaveAttribute('aria-checked', 'false');
  });

  test('a failed save rolls the switch back and says so', async ({ page }) => {
    await seed(page);
    await page.goto('/qorlla.html');
    await openSources(page);
    await page.route('**/api/workplace/ai/sources/**', (route) => route.request().method() === 'PATCH' ? route.abort() : route.continue());
    await sw(page, 'Chat').click();
    await expect(page.locator('#toast')).toContainText(/Cannot reach|Could not save/);
    await expect(sw(page, 'Chat')).toHaveAttribute('aria-checked', 'true');
    await page.unroute('**/api/workplace/ai/sources/**');
    expect((await (await page.request.get(API + '/sources')).json()).sources.chat).toBe(true);
  });

  test('switches work from the keyboard and expose their state to assistive tech', async ({ page }) => {
    await seed(page);
    await page.goto('/qorlla.html');
    await openSources(page);
    const master = sw(page, 'Qorlla Sources');
    await expect(master).toHaveAttribute('role', 'switch');
    await master.focus();
    await page.keyboard.press('Space');
    await expect(master).toHaveAttribute('aria-checked', 'false');
    await expect(master).toHaveAttribute('aria-label', /off/);
    await expect.poll(async () => (await (await page.request.get(API + '/sources')).json()).masterEnabled).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.locator('#aiSrcPop')).toBeHidden();
  });

  test('Meetings off removes meetings from the real summary and no meetings data is requested', async ({ page }) => {
    const { marker } = await seed(page);
    await page.goto('/qorlla.html');
    await page.locator('#sugWeek').click();
    await expect(thread(page)).toContainText('Sync ' + marker);

    await page.locator('#aiNew').click();
    await openSources(page);
    await sw(page, 'Meetings').click();
    await expect(sw(page, 'Meetings')).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');

    const asked = [];
    page.on('request', (r) => { if (r.url().includes('/ai/context/')) asked.push(r.url()); });
    await page.locator('#sugWeek').click();
    await expect(thread(page)).toContainText(/unread email/);
    await expect(thread(page)).not.toContainText(marker);
    await expect(thread(page)).not.toContainText('Next 7 days');
    expect(asked.some((u) => u.includes('/ai/context/meetings'))).toBe(false);
    // and the server refuses it even if the page is bypassed
    expect((await page.request.get(API + '/context/meetings')).status()).toBe(403);
  });

  test('My Notes off removes notes from action items and the summary', async ({ page }) => {
    const { marker } = await seed(page);
    await page.goto('/qorlla.html');
    await page.locator('#sugActions').click();
    await expect(thread(page)).toContainText(marker);

    await page.locator('#aiNew').click();
    await openSources(page);
    await sw(page, 'My Notes').click();
    await expect(sw(page, 'My Notes')).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');

    await page.locator('#sugActions').click();
    await expect(thread(page)).toContainText('My Notes is switched off');
    await expect(thread(page)).not.toContainText(marker);

    await page.locator('#aiNew').click();
    await page.locator('#sugWeek').click();
    await expect(thread(page)).not.toContainText(/\d+ notes?/);
    expect((await page.request.get(API + '/context/my_notes')).status()).toBe(403);
  });

  test('master off sends the assistant no data at all', async ({ page }) => {
    await seed(page);
    await page.goto('/qorlla.html');
    await openSources(page);
    await sw(page, 'Qorlla Sources').click();
    await expect(sw(page, 'Qorlla Sources')).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');

    const asked = [];
    page.on('request', (r) => { if (r.url().includes('/ai/context/') || /\/api\/workplace\/(mail|notes|calendar|schedule)$/.test(r.url())) asked.push(r.url()); });
    await page.locator('#sugWeek').click();
    await expect(thread(page)).toContainText('switched off');
    await page.locator('#aiNew').click();
    await page.locator('#sugActions').click();
    await expect(thread(page)).toContainText('switched off');
    expect(asked).toEqual([]);
  });

  test('Chat History survives a reload; rename and delete reach the server', async ({ page }) => {
    await seed(page);
    await page.goto('/qorlla.html');
    await page.locator('#sugWeek').click();
    await expect(thread(page)).toContainText('Next 7 days');
    await page.reload();
    await page.locator('#aiMenu').click();
    await expect(page.locator('.hist-row')).toHaveCount(1);
    await expect(page.locator('.hist-row .t')).toHaveText('Summarize my week');

    await page.locator('.hist-row').hover();
    await page.locator('.hist-row .more').click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await page.keyboard.type('Weekly recap');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await (await page.request.get(API + '/chats')).json()).chats.map((c) => c.title)).toEqual(['Weekly recap']);

    await page.locator('.hist-row').hover();
    await page.locator('.hist-row .more').click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.locator('.ai-confirm .danger').click();
    await expect(page.locator('.hist-row')).toHaveCount(0);
    await expect.poll(async () => (await (await page.request.get(API + '/chats')).json()).chats.length).toBe(0);
  });
});
