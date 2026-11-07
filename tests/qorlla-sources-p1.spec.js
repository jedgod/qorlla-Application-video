const { test, expect } = require('@playwright/test');

// Qorlla Sources P1: the Chat and Canvas adapters, and summaries built from all five sources.
// Helpers are repeated from qorlla-sources.spec.js so each file can run on its own.

const PASSWORD = 'Sources-test-9917!';
const API = '/api/workplace/ai';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const uname = () => 'qp' + Math.random().toString(36).slice(2, 12);
const mark = (p) => p + Math.floor(Math.random() * 1e6);
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

async function signUp(request) {
  const r = await request.post('/api/auth/register', { data: { username: uname(), password: PASSWORD } });
  expect(r.status()).toBe(201);
}
async function token(request) { return (await (await request.get('/api/auth/csrf')).json()).token; }
async function patch(request, url, data, t) {
  return request.patch(API + url, { data, headers: { 'X-CSRF-Token': t } });
}
async function makeChannel(request, name, text, isPublic) {
  const c = await request.post('/api/workplace/chat', { data: { type: 'channel', name, public: !!isPublic } });
  expect(c.status()).toBe(201);
  const id = (await c.json()).id;
  expect((await request.post('/api/workplace/chat/' + id + '/messages', { data: { text } })).status()).toBe(201);
  return id;
}

test.describe('Chat adapter', () => {
  test('returns only conversations the account belongs to', async ({ request, playwright, baseURL }) => {
    await signUp(request);
    const other = await playwright.request.newContext({ baseURL });
    await signUp(other);
    const mine = mark('MINE'), theirs = mark('THEIRS'), pub = mark('PUBLIC');
    await makeChannel(request, 'a-' + mine, 'hello ' + mine, false);
    await makeChannel(other, 'b-' + theirs, 'secret ' + theirs, false);
    await makeChannel(other, 'p-' + pub, 'open ' + pub, true); // public, but the first account never joined it

    const body = JSON.stringify(await (await request.get(API + '/context/chat')).json());
    expect(body).toContain(mine);
    expect(body).not.toContain(theirs);
    expect(body).not.toContain(pub);

    const otherBody = JSON.stringify(await (await other.get(API + '/context/chat')).json());
    expect(otherBody).toContain(theirs);
    expect(otherBody).not.toContain(mine);
    await other.dispose();
  });

  test('a conversation you leave stops contributing', async ({ request }) => {
    await signUp(request);
    const m = mark('LEFT');
    const id = await makeChannel(request, 'c-' + m, 'bye ' + m, false);
    expect(JSON.stringify(await (await request.get(API + '/context/chat')).json())).toContain(m);
    expect((await request.post('/api/workplace/chat/' + id + '/leave')).status()).toBeLessThan(300);
    expect(JSON.stringify(await (await request.get(API + '/context/chat')).json())).not.toContain(m);
  });

  test('is refused when Chat or the master switch is off, and only then', async ({ request }) => {
    await signUp(request);
    const t = await token(request);
    await makeChannel(request, 'd-' + mark('X'), 'text', false);
    expect((await request.get(API + '/context/chat')).status()).toBe(200);
    await patch(request, '/sources/chat', { enabled: false }, t);
    expect((await request.get(API + '/context/chat')).status()).toBe(403);
    expect((await request.get(API + '/context/canvas')).status()).toBe(200);
    await patch(request, '/sources/chat', { enabled: true }, t);
    await patch(request, '/sources', { enabled: false }, t);
    expect((await request.get(API + '/context/chat')).status()).toBe(403);
  });
});

test.describe('Canvas adapter', () => {
  test('returns your own boards by name and never the drawing', async ({ request, playwright, baseURL }) => {
    await signUp(request);
    const other = await playwright.request.newContext({ baseURL });
    await signUp(other);
    const mine = mark('BOARDMINE'), theirs = mark('BOARDTHEIRS');
    expect((await request.post('/api/workplace/whiteboard', { data: { name: mine, data: PNG } })).status()).toBe(201);
    expect((await other.post('/api/workplace/whiteboard', { data: { name: theirs, data: PNG } })).status()).toBe(201);

    const text = JSON.stringify(await (await request.get(API + '/context/canvas')).json());
    expect(text).toContain(mine);
    expect(text).not.toContain(theirs);
    expect(text).not.toContain('base64');
    expect(text).not.toContain('"data"');
    await other.dispose();
  });

  test('is refused when Canvas or the master switch is off, and only then', async ({ request }) => {
    await signUp(request);
    const t = await token(request);
    expect((await request.get(API + '/context/canvas')).status()).toBe(200);
    await patch(request, '/sources/canvas', { enabled: false }, t);
    expect((await request.get(API + '/context/canvas')).status()).toBe(403);
    expect((await request.get(API + '/context/chat')).status()).toBe(200);
    await patch(request, '/sources/canvas', { enabled: true }, t);
    await patch(request, '/sources', { enabled: false }, t);
    expect((await request.get(API + '/context/canvas')).status()).toBe(403);
  });
});

test.describe('Browser: summaries from all five sources', () => {
  test.use({ viewport: { width: 1400, height: 900 } });
  const thread = (page) => page.locator('#aiThread');
  const LABEL = { meetings: 'Meetings', canvas: 'Canvas', chat: 'Chat', mail: 'Mail', my_notes: 'My Notes' };

  async function seedAll(page) {
    await signUp(page.request);
    const m = { note: mark('NOTE'), event: mark('EVENT'), chat: mark('CHATMSG'), board: mark('BOARD') };
    expect((await page.request.post('/api/workplace/notes', { data: { title: 'N ' + m.note, content: 'TODO: ' + m.note } })).status()).toBe(201);
    expect((await page.request.post('/api/workplace/calendar', { data: { title: 'E ' + m.event, date: ymd(new Date(Date.now() + 86400000)), start: '10:00', end: '11:00' } })).status()).toBe(201);
    await makeChannel(page.request, 'team-' + m.chat, 'ping ' + m.chat, false);
    expect((await page.request.post('/api/workplace/whiteboard', { data: { name: 'Board ' + m.board, data: PNG } })).status()).toBe(201);
    return m;
  }
  async function setSource(page, key, enabled) {
    const t = await token(page.request);
    const r = await patch(page.request, key === 'master' ? '/sources' : '/sources/' + key, { enabled }, t);
    expect(r.status()).toBe(200);
  }
  async function summarize(page) {
    await page.reload();
    await page.locator('#sugWeek').click();
    await expect(thread(page)).toContainText('Based on:');
    return thread(page).innerText();
  }

  test('all five sources contribute and the summary names them', async ({ page }) => {
    const m = await seedAll(page);
    await page.goto('/qorlla.html');
    const text = await summarize(page);
    expect(text).toContain('E ' + m.event);
    expect(text).toContain('Chat, last 7 days: 1 message');
    expect(text).toContain('Board ' + m.board);
    expect(text).toMatch(/\d+ unread emails?/);
    expect(text).toMatch(/\d+ notes?/);
    expect(text).toContain('Based on: Meetings, Canvas, Chat, Mail, My Notes.');
    expect(text).not.toContain('Switched off');
  });

  for (const key of ['meetings', 'canvas', 'chat', 'mail', 'my_notes']) {
    test('with ' + LABEL[key] + ' off, nothing from it is requested or shown and the rest still works', async ({ page }) => {
      const m = await seedAll(page);
      await setSource(page, key, false);
      const asked = [];
      page.on('request', (r) => { if (r.url().includes('/ai/context/')) asked.push(r.url().split('/ai/context/')[1]); });
      await page.goto('/qorlla.html');
      const text = await summarize(page);

      expect(asked).not.toContain(key);
      expect(asked.slice().sort()).toEqual(['canvas', 'chat', 'mail', 'meetings', 'my_notes'].filter((k) => k !== key).sort());
      expect(text).toContain('Switched off: ' + LABEL[key] + '.');
      const based = text.split('Based on: ')[1].split('\n')[0];
      expect(based).not.toContain(LABEL[key]);
      Object.keys(LABEL).filter((k) => k !== key).forEach((k) => expect(based).toContain(LABEL[k]));

      if (key === 'chat') { expect(text).not.toContain('Chat, last'); expect(text).not.toContain(m.chat); }
      if (key === 'canvas') { expect(text).not.toContain('Canvas:'); expect(text).not.toContain(m.board); }
      if (key === 'meetings') { expect(text).not.toContain(m.event); expect(text).not.toContain('Next 7 days'); }
      if (key === 'mail') expect(text).not.toMatch(/unread email/);
      if (key === 'my_notes') expect(text).not.toMatch(/\d+ notes?\b/);
    });
  }

  test('master off: the summary refuses and requests nothing', async ({ page }) => {
    await seedAll(page);
    await setSource(page, 'master', false);
    const asked = [];
    page.on('request', (r) => { if (r.url().includes('/ai/context/')) asked.push(r.url()); });
    await page.goto('/qorlla.html');
    await page.locator('#sugWeek').click();
    await expect(thread(page)).toContainText('All sources are switched off');
    expect(asked).toEqual([]);
  });
});
