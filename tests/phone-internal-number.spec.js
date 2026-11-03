const { test, expect } = require('@playwright/test');
const { startVoiceStack, ADMIN } = require('./support/voice-stack');
const { startMain, PASSWORD } = require('./support/meet-stack');

// Every authenticated account gets an internal Qorlla number (extension) from the server at sign-in, and "recharge for external calls" exists only as a switched-off structure.
// Real main app + real voice engine + real PostgreSQL (a throw-away schema). Needs a PostgreSQL (QORLLA_TEST_VOICE_DB) and a reachable Meet (QORLLA_TEST_MEET_URL), as the other voice specs do.
const MAIN = 5391, VOICE = 5392, MAIN2 = 5393;

test.describe('internal numbers for everyone; recharge switched off', () => {
  test.describe.configure({ mode: 'serial' });
  let stack, strict; const users = {};
  const register = async (request, base, name) => { const username = name + Math.random().toString(36).slice(2, 7); const r = await request.post(base + '/api/auth/register', { data: { username, displayName: name, password: PASSWORD } }); expect(r.status()).toBe(201); return { username, id: (await r.json()).user.id }; };
  const directory = async (request, base) => (await (await request.get(base + '/api/voice/directory')).json()).people || [];
  const engineIdentities = async () => (await (await fetch(`http://127.0.0.1:${VOICE}/v1/voice/admin/identities`, { headers: { 'x-voice-admin-secret': ADMIN } })).json()).identities;
  const until = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 200)); } };

  test.beforeAll(async () => { stack = await startVoiceStack({ mainPort: MAIN, voicePort: VOICE }); });
  test.afterAll(async () => { if (strict) strict.stop(); if (stack) await stack.stop(); });

  test('registering gives the account an internal number at once - without it ever opening a voice page or asking for a token', async ({ playwright }) => {
    const a = await playwright.request.newContext(), b = await playwright.request.newContext();
    users.a = await register(a, stack.base, 'Alice'); users.b = await register(b, stack.base, 'Bruno');
    const ids = await until(async () => { const l = await engineIdentities(); return [users.a.id, users.b.id].every((id) => l.some((i) => i.account_id === id)) && l; });
    const ea = ids.find((i) => i.account_id === users.a.id).extension, eb = ids.find((i) => i.account_id === users.b.id).extension;
    expect(ea).toMatch(/^[0-9]{3,8}$/); expect(eb).toMatch(/^[0-9]{3,8}$/); expect(ea).not.toBe(eb);
    const people = await directory(a, stack.base); expect(people.map((p) => p.id).sort()).toEqual([users.a.id, users.b.id].sort());           // the colleague directory lists everyone who has signed in
    users.ext = { a: ea, b: eb }; await a.dispose(); await b.dispose();
  });

  test('signing in again is idempotent: the same number, never a second one', async ({ playwright }) => {
    const a = await playwright.request.newContext(); const r = await a.post(stack.base + '/api/auth/login', { data: { username: users.a.username, password: PASSWORD } }); expect(r.status()).toBe(200);
    await new Promise((x) => setTimeout(x, 800)); const l = (await engineIdentities()).filter((i) => i.account_id === users.a.id);
    expect(l).toHaveLength(1); expect(l[0].extension).toBe(users.ext.a); await a.dispose();
  });

  test('the voice engine being down never fails a sign-in or registration; the number is assigned on the next sign-in after recovery', async ({ playwright }) => {
    await stack.stopEngine();
    const c = await playwright.request.newContext(); users.c = await register(c, stack.base, 'Carla');                                         // 201 asserted inside register()
    const again = await c.post(stack.base + '/api/auth/login', { data: { username: users.c.username, password: PASSWORD } }); expect(again.status()).toBe(200);
    await stack.startEngine(); expect((await engineIdentities()).some((i) => i.account_id === users.c.id)).toBe(false);
    const login = await c.post(stack.base + '/api/auth/login', { data: { username: users.c.username, password: PASSWORD } }); expect(login.status()).toBe(200);
    const mine = await until(async () => (await engineIdentities()).find((i) => i.account_id === users.c.id)); expect(mine.extension).toMatch(/^[0-9]{3,8}$/); await c.dispose();
  });

  test('an account that must verify its email first gets no number until it has (the existing Shield rule is respected)', async ({ playwright }) => {
    strict = await startMain(MAIN2, { QORLLA_VOICE_ENABLED: 'true', VOICE_ADMIN_SECRET: ADMIN, VOICE_PORT: String(VOICE), VOICE_INTERNAL_URL: 'http://127.0.0.1:' + VOICE, SHIELD_REQUIRE_VERIFIED: 'true' });
    const d = await playwright.request.newContext(); users.d = await register(d, strict.base, 'Dina'); await new Promise((x) => setTimeout(x, 1500));
    expect((await engineIdentities()).some((i) => i.account_id === users.d.id)).toBe(false); await d.dispose();
  });

  test('recharge for external calls is a structure only: unavailable, with reasons, no balance, no price, and it cannot be activated by a request', async ({ playwright }) => {
    const anon = await playwright.request.newContext(); expect((await anon.get(stack.base + '/api/phone/recharge')).status()).toBe(401); expect((await anon.post(stack.base + '/api/phone/recharge', { data: {} })).status()).toBe(401);
    const a = await playwright.request.newContext(); await a.post(stack.base + '/api/auth/login', { data: { username: users.a.username, password: PASSWORD } });
    const g = await a.get(stack.base + '/api/phone/recharge'); expect(g.status()).toBe(200); const s = await g.json();
    expect(s).toMatchObject({ available: false, balance: null, packages: [] }); expect(s.reasons).toEqual(expect.arrayContaining(['carrier_not_connected', 'billing_not_certified', 'prepaid_calling_not_built']));
    for (const body of [{}, { amount: 5000, currency: 'usd' }, { package: 'big', confirm: true }]) { const p = await a.post(stack.base + '/api/phone/recharge', { data: body }); expect(p.status()).toBe(503); expect((await p.json()).error).toBe('recharge_unavailable'); }
    expect(JSON.stringify(s)).not.toMatch(/\$|price|amount_cents/i);
    expect(await (await a.get(stack.base + '/api/phone/recharge')).json()).toMatchObject({ available: false, balance: null }); await a.dispose(); await anon.dispose();
  });

  test('in the browser: the Phone screen shows the internal number, and the Recharge button is disabled with the reason; calls between Qorlla numbers are stated as free', async ({ browser }) => {
    test.setTimeout(120000);
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    expect((await ctx.request.post(stack.base + '/api/auth/login', { data: { username: users.b.username, password: PASSWORD } })).status()).toBe(200);
    await page.goto(stack.base + '/qorlla.html#phone'); await page.locator('#view').getByText('Numbers & Plans', { exact: true }).first().click();
    const internal = page.locator('#qpInternalNumber'); await expect(internal).toHaveAttribute('data-state', 'assigned', { timeout: 20000 }); await expect(internal).toContainText(users.ext.b); await expect(internal).toContainText('free inside Qorlla');
    await page.getByRole('tab', { name: 'Plans & usage' }).click(); const box = page.locator('#qpRecharge'); await expect(box).toBeVisible();
    await expect(box.getByRole('button', { name: 'Recharge' })).toBeDisabled(); await expect(page.locator('#qpRechargeWhy')).toContainText('Recharge is unavailable'); await expect(page.locator('#qpRechargeWhy')).toContainText('licensed telephony carrier');
    await expect(page.locator('#qpRechargeWhy')).toContainText('Calls between Qorlla numbers stay free'); await expect(box).not.toContainText(/\$\s?\d/); await ctx.close();
  });
});
