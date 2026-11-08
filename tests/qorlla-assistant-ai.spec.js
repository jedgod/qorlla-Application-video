const { test, expect: baseExpect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const expect = baseExpect.configure({ timeout: 15000 });

// Workspace overview assistant, PHASE 2 (main app + page): the context packet for the private AI model, and the page's behaviour around it.
// The feature is OFF unless the server says ASSISTANT_AI_ENABLED=true; every test here that needs it runs its own server with it on. The portal is a mock in
// the browser tests: its real behaviour (private model only, verification, entitlements, audit) is proven in qorlla-portal/tests/overview-assistant.test.mjs.

const PASSWORD = 'AssistantAI-test-7712!';
const SECRET = 'q'.repeat(48);                                    // stands in for PORTAL_INTROSPECTION_SECRET, shared by MAIN and the portal
const API = '/api/workplace/ai';
const WP = '/api/workplace';
const GUIDANCE = 'I can help summarize your activities, meetings, tasks, and recent Workspace information. Try asking about a specific period or activity.';
const uname = () => 'ai' + Math.random().toString(36).slice(2, 12);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

async function startServer(env) {
  const port = String(5200 + Math.floor(Math.random() * 700));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qorlla-ai-'));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PORT: port, DATA_DIR: dataDir, GUEST_RATE_LIMIT_MAX: '5000', MEET_DETECT: 'off', ...env } });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch('http://localhost:' + port + '/api/health')).ok) break; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { baseURL: 'http://localhost:' + port, dataDir, stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }) };
}
async function verifier() { return import(pathToFileURL(path.join(__dirname, '..', 'qorlla-portal', 'server', 'ai', 'overview-packet.mjs')).href); }
async function signUp(request) {
  const username = uname();
  expect((await request.post('/api/auth/register', { data: { username, password: PASSWORD } })).status()).toBe(201);
  const me = await (await request.get('/api/auth/me')).json();
  return { username, id: String((me.user || me).id) };
}
async function csrf(request) { return { 'X-CSRF-Token': (await (await request.get('/api/auth/csrf')).json()).token }; }
async function seed(request, extra = {}) {
  const h = await csrf(request), today = ymd(new Date());
  expect((await request.post(WP + '/calendar', { data: { title: 'Sprint retro', date: today, start: '09:00', end: '10:00' }, headers: h })).status()).toBe(201);
  expect((await request.post(WP + '/notes', { data: { title: 'Weekly', content: '[x] Send the report\n[ ] Call Sam\nThe budget review is on Friday with Dana.' }, headers: h })).status()).toBe(201);
  if (extra.note) expect((await request.post(WP + '/notes', { data: extra.note, headers: h })).status()).toBe(201);
}
const context = (request, question) => request.post(API + '/assistant/context', { data: { question } });
async function ctxPost(request, question) { return request.post(API + '/assistant/context', { data: { question }, headers: await csrf(request) }); }

test.describe('OFF by default (the normal test server)', () => {
  test('status says disabled, the packet route does not exist, and an unrecognised question gets the guidance and calls no AI route', async ({ page }) => {
    const request = page.request;                                                              // the same session as the page
    await signUp(request);
    expect(await (await request.get(API + '/assistant/status')).json()).toEqual({ enabled: false });
    const r = await ctxPost(request, 'anything'); expect(r.status()).toBe(404); expect((await r.json()).code).toBe('feature_disabled');
    let portalCalls = 0;
    await page.route('**/api/v1/ai/overview**', (route) => { portalCalls++; route.abort(); });
    await page.goto('/qorlla.html');
    await page.locator('#aiInput').fill('what is the capital of France'); await page.locator('#aiInput').press('Enter');
    await expect(page.locator('#aiThread .bubble.ai').last()).toHaveText(GUIDANCE);
    expect(portalCalls).toBe(0);
  });
});

test.describe('ON: the context packet (API)', () => {
  let srv, V;
  test.beforeAll(async () => { srv = await startServer({ ASSISTANT_AI_ENABLED: 'true', PORTAL_INTROSPECTION_SECRET: SECRET }); V = await verifier(); });
  test.afterAll(async () => { await srv.stop(); });
  const ctx = async (playwright) => playwright.request.newContext({ baseURL: srv.baseURL });

  test('it needs sign-in and a CSRF token; status says enabled', async ({ playwright }) => {
    const c = await ctx(playwright);
    expect((await c.get(API + '/assistant/status')).status()).toBe(401);
    expect((await c.post(API + '/assistant/context', { data: { question: 'x' } })).status()).toBe(401);
    await signUp(c);
    expect(await (await c.get(API + '/assistant/status')).json()).toEqual({ enabled: true });
    expect((await context(c, 'x')).status()).toBe(403);                                        // signed in but no CSRF token
    expect((await (await ctxPost(c, '')).status())).toBe(400);
    expect((await ctxPost(c, 'x'.repeat(5000))).status(), 'the question is capped, not rejected').toBe(200);
    await c.dispose();
  });

  test('the packet verifies with the shared secret, is for this person only, expires within minutes, and carries only this account\'s own data', async ({ playwright }) => {
    const a = await ctx(playwright), b = await ctx(playwright);
    const A = await signUp(a), B = await signUp(b);
    await seed(a); await seed(b, { note: { title: 'Bob private', content: 'BOB-ONLY-SECRET plan' } });
    const r = await ctxPost(a, 'what is on my plate?'); expect(r.status()).toBe(200);
    const { packet, sources, off } = await r.json();
    const sub = A.id.replace(/^u_/, '').toLowerCase();
    const claims = V.verifyOverviewPacket(SECRET, packet, { actor: sub });
    expect(claims.sub).toBe(sub); expect(claims.v).toBe(1); expect(claims.exp - claims.iat).toBe(120000);
    expect(claims.sources).toEqual(['Meetings', 'Canvas', 'Chat', 'My Notes', 'Mail'].filter((s) => claims.sources.includes(s))); expect(sources).toEqual(claims.sources); expect(off).toEqual([]);
    expect(claims.text).toContain('Sprint retro'); expect(claims.text).toContain('Call Sam'); expect(claims.text).toMatch(/Today is \d{4}-\d{2}-\d{2}\./);
    expect(claims.text).not.toContain('BOB-ONLY-SECRET');                                       // nothing of another account
    expect(() => V.verifyOverviewPacket(SECRET, packet, { actor: B.id.replace(/^u_/, '') })).toThrow(/wrong_person/);   // useless to anyone else
    expect(() => V.verifyOverviewPacket('z'.repeat(48), packet, { actor: sub })).toThrow(/bad_signature/);
    await a.dispose(); await b.dispose();
  });

  test('the question only chooses which of your own items to include: a matching note\'s text comes along, an unrelated question does not pull it in', async ({ playwright }) => {
    const c = await ctx(playwright); const U = await signUp(c); await seed(c);
    const sub = U.id.replace(/^u_/, '').toLowerCase();
    const hit = V.verifyOverviewPacket(SECRET, (await (await ctxPost(c, 'when is the budget review?')).json()).packet, { actor: sub });
    expect(hit.text).toContain('[My Notes: matching the question]'); expect(hit.text).toContain('budget review is on Friday with Dana');
    const miss = V.verifyOverviewPacket(SECRET, (await (await ctxPost(c, 'tell me about zebras')).json()).packet, { actor: sub });
    expect(miss.text).not.toContain('[My Notes: matching the question]');
    await c.dispose();
  });

  test('Qorlla Sources is enforced: an off source contributes nothing and is named; every source off is refused; the size is capped', async ({ playwright }) => {
    const c = await ctx(playwright); const U = await signUp(c); await seed(c, { note: { title: 'Huge', content: 'budget ' + 'x'.repeat(48000) } });
    const sub = U.id.replace(/^u_/, '').toLowerCase(), h = await csrf(c);
    const big = V.verifyOverviewPacket(SECRET, (await (await ctxPost(c, 'budget')).json()).packet, { actor: sub });
    expect(big.text.length).toBeLessThanOrEqual(30000);
    await c.patch(API + '/sources/my_notes', { data: { enabled: false }, headers: h });
    await c.patch(API + '/sources/meetings', { data: { enabled: false }, headers: h });
    const r = await (await ctxPost(c, 'budget review')).json();
    const claims = V.verifyOverviewPacket(SECRET, r.packet, { actor: sub });
    expect(r.off.sort()).toEqual(['Meetings', 'My Notes']); expect(claims.sources).not.toContain('My Notes'); expect(claims.sources).not.toContain('Meetings');
    for (const leaked of ['Sprint retro', 'Call Sam', 'budget review is on Friday', 'My Notes']) expect(claims.text, leaked).not.toContain(leaked);
    await c.patch(API + '/sources', { data: { enabled: false }, headers: h });
    const none = await ctxPost(c, 'anything'); expect(none.status()).toBe(403); expect((await none.json()).source).toBe('all');
    await c.dispose();
  });

  test('every packet is recorded (when, which sources) and the record never holds the question or the data', async ({ playwright }) => {
    const c = await ctx(playwright); const U = await signUp(c); await seed(c);
    expect((await ctxPost(c, 'SECRET-QUESTION-8812 budget')).status()).toBe(200);
    const files = [];                                                                          // this account's record only: the server directory is shared by several tests
    (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/aireads\./.test(f.name) && f.name.includes(U.id)) files.push(p); } })(srv.dataDir);
    expect(files.length).toBe(1);
    const log = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    expect(log[log.length - 1]).toMatchObject({ kind: 'assistant' }); expect(log[log.length - 1].sources.length).toBe(5);
    const raw = JSON.stringify(log); expect(raw).not.toContain('SECRET-QUESTION'); expect(raw).not.toContain('Sprint retro'); expect(raw).not.toContain('Call Sam');
    await c.dispose();
  });
});

test.describe('ON: the text box (browser, mocked portal)', () => {
  let srv, V;
  test.beforeAll(async () => { srv = await startServer({ ASSISTANT_AI_ENABLED: 'true', PORTAL_INTROSPECTION_SECRET: SECRET }); V = await verifier(); });
  test.afterAll(async () => { await srv.stop(); });
  const open = async (browser) => {
    const context = await browser.newContext({ baseURL: srv.baseURL, viewport: { width: 1400, height: 900 } });
    const user = await signUp(context.request); await seed(context.request);
    const page = await context.newPage(); const calls = []; const outside = [];
    page.on('request', (r) => { if (!r.url().startsWith(srv.baseURL) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) outside.push(r.url()); });
    await page.goto('/qorlla.html');
    return { context, page, user, calls, outside };
  };
  const reply = (calls, make) => (route) => { const body = JSON.parse(route.request().postData() || '{}'); calls.push({ body, headers: route.request().headers() }); const r = make(calls.length); route.fulfill({ status: r.status || 200, contentType: 'application/json', body: JSON.stringify(r.body) }); };
  const ask = async (page, q) => { await page.locator('#aiInput').fill(q); await page.locator('#aiInput').press('Enter'); };
  const last = (page) => page.locator('#aiThread .bubble.ai:not(.pending)').last();

  test('an unrecognised question is answered by the private model through the portal, with a real signed packet, and the answer says what it was based on', async ({ browser }) => {
    const { context, page, user, calls, outside } = await open(browser);
    await page.route('**/api/v1/ai/overview', reply(calls, () => ({ body: { answer: 'Dana leads the budget review on Friday.' } })));
    await ask(page, 'who is Dana and what did she say about the budget?');
    await expect(last(page)).toContainText('Dana leads the budget review on Friday.');
    await expect(last(page)).toContainText('Based on: Meetings, Canvas, Chat, My Notes, Mail.'); await expect(last(page)).toContainText('Qorlla AI Private');
    expect(calls.length).toBe(1);
    const b = calls[0].body;
    expect(Object.keys(b).sort()).toEqual(['history', 'idempotency_key', 'packet', 'question']);
    expect(b.question).toBe('who is Dana and what did she say about the budget?'); expect(b.history).toEqual([]); expect(b.idempotency_key.length).toBeGreaterThanOrEqual(8);
    const claims = V.verifyOverviewPacket(SECRET, b.packet, { actor: user.id.replace(/^u_/, '').toLowerCase() });      // what the page relayed is exactly what MAIN signed
    expect(claims.text).toContain('Sprint retro');
    expect((await (await context.request.get(API + '/chats')).json()).chats[0].messages.map((m) => m.role)).toEqual(['me', 'ai']);   // saved like any chat
    expect(outside, 'nothing was requested from any other site').toEqual([]);
    await context.close();
  });

  test('follow-up questions carry the earlier turns (at most six) so the model can answer them in context', async ({ browser }) => {
    const { context, page, calls } = await open(browser);
    await page.route('**/api/v1/ai/overview', reply(calls, (n) => ({ body: { answer: 'ANSWER-' + n } })));
    await ask(page, 'who is Dana?');
    await expect(last(page)).toContainText('ANSWER-1');
    await ask(page, 'and what did she send me?');
    await expect(last(page)).toContainText('ANSWER-2');
    expect(calls[1].body.history.map((m) => m.role)).toEqual(['me', 'ai']); expect(calls[1].body.history[0].text).toBe('who is Dana?'); expect(calls[1].body.history[1].text).toContain('ANSWER-1');
    for (const q of ['third', 'fourth', 'fifth', 'sixth']) { await ask(page, q); await expect(last(page)).toContainText('ANSWER-'); }
    expect(calls[calls.length - 1].body.history.length).toBeLessThanOrEqual(6);
    await context.close();
  });

  test('requests phase 1 understands never go to the model, even with the feature on', async ({ browser }) => {
    const { context, page, calls } = await open(browser);
    await page.route('**/api/v1/ai/overview', reply(calls, () => ({ body: { answer: 'SHOULD-NOT-APPEAR' } })));
    for (const q of ['Summarize last week', 'What meetings do I have this week?', 'show my outstanding tasks']) { await page.locator('#aiNew').click(); await ask(page, q); await expect(last(page)).not.toContainText('SHOULD-NOT-APPEAR'); await expect(last(page)).not.toHaveText(GUIDANCE); }
    expect(calls.length).toBe(0);
    await context.close();
  });

  test('FAIL CLOSED: with no private model the answer is a refusal with Try again (not saved), never an answer from elsewhere; Try again builds a fresh packet and key', async ({ browser }) => {
    const { context, page, calls, outside } = await open(browser);
    let down = true;
    await page.route('**/api/v1/ai/overview', reply(calls, () => (down ? { status: 503, body: { code: 'private_unavailable', error: 'x' } } : { body: { answer: 'back online' } })));
    await ask(page, 'what is the budget review about?');
    const err = page.locator('#aiThread .bubble.error');
    await expect(err).toContainText('Qorlla AI Private is not available right now. Nothing was sent anywhere else.');
    expect(JSON.stringify((await (await context.request.get(API + '/chats')).json()).chats)).not.toContain('not available right now');
    down = false;
    await err.getByRole('button', { name: 'Try again' }).click();
    await expect(last(page)).toContainText('back online');
    expect(calls.length).toBe(2); expect(calls[1].body.packet).not.toBe(calls[0].body.packet); expect(calls[1].body.idempotency_key).not.toBe(calls[0].body.idempotency_key);
    expect(outside).toEqual([]);
    await context.close();
  });

  test('plan limit, busy, unverifiable data, not enabled on the portal and no workspace are each explained', async ({ browser }) => {
    const { context, page, calls } = await open(browser);
    const cases = [
      [{ status: 402, body: { code: 'plan_limit' } }, /message limit has been reached/, false],
      [{ status: 429, body: { code: 'ai_rate_limited' } }, /busy/, true],
      [{ status: 400, body: { code: 'context_invalid' } }, /could not be verified/, true],
      [{ status: 403, body: { error: 'No workspace membership' } }, /not set up for your workspace/, false],
      [{ status: 404, body: { code: 'feature_disabled' } }, /not enabled on this server/, false],      // last: the page then stops asking the portal for a while
    ];
    for (const [resp, text, isError] of cases) {
      await page.unroute('**/api/v1/ai/overview'); await page.route('**/api/v1/ai/overview', reply(calls, () => resp));
      await page.locator('#aiNew').click(); await ask(page, 'tell me about zebras ' + resp.status);
      if (isError) await expect(page.locator('#aiThread .bubble.error')).toContainText(text); else await expect(last(page)).toContainText(text);
    }
    await context.close();
  });

  test('with every source switched off the model is not asked at all', async ({ browser }) => {
    const { context, page, calls } = await open(browser);
    await context.request.patch(API + '/sources', { data: { enabled: false }, headers: await csrf(context.request) });
    await page.route('**/api/v1/ai/overview', reply(calls, () => ({ body: { answer: 'SHOULD-NOT-APPEAR' } })));
    await page.reload(); await ask(page, 'what is the budget review about?');
    await expect(last(page)).toHaveText('All sources are switched off in Qorlla Sources.');
    expect(calls.length).toBe(0);
    await context.close();
  });
});
