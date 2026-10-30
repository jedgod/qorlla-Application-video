const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PASSWORD } = require('./support/meet-stack');
const { startVoiceStack } = require('./support/voice-stack');

// A3.6: the Phone page and voice.js against the REAL main app and the REAL voice engine with Security Shield enforcement ON, in real browsers.
// What this proves: the page shows the truth the server decides (unverified, ready, suspended, internal-only, features off), refuses public telephone numbers in the UI, and two verified accounts still hold a real call.
// What it does NOT prove: calls across networks, other browsers, real devices, or that an established peer-to-peer stream stops when an account is suspended (the page and server end the call in signaling).
const MAIN = 5293, VOICE = 5294;

test.describe('Phone page and voice.js wired to the Security Shield', () => {
  test.describe.configure({ mode: 'serial' });
  let stack;
  test.beforeAll(async () => {
    test.setTimeout(150000);                                  // starting the main app, the engine and a database schema can take longer than the default hook timeout on a busy machine
    stack = await startVoiceStack({ mainPort: MAIN, voicePort: VOICE,
      engineEnv: { SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_WORKLOAD_JWKS_URL: 'http://127.0.0.1:' + MAIN + '/.well-known/shield-workload-jwks.json', SHIELD_WORKLOAD_ISSUER: 'qorlla-main-workload', SHIELD_WORKLOAD_ALLOWED: 'svc:main-app=shield.admin|shield.suspend' },
      mainEnv: { SHIELD_SYNC_URL: 'http://127.0.0.1:' + VOICE, SHIELD_REQUIRE_VERIFIED: 'true', SHIELD_RECONCILE_SECONDS: '2', PHONE_ADMIN_USERS: 'adminx*' } });
  });
  test.afterAll(async () => { if (stack) await stack.stop(); });

  const rand = () => Math.random().toString(36).slice(2, 7);
  async function account(browser, name, { verify = true } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] }), u = (name + rand()).toLowerCase();
    const r = await ctx.request.post(stack.base + '/api/auth/register', { data: { username: u, displayName: name + ' Test', password: PASSWORD, email: u + '@example.test' } }); expect(r.status()).toBe(201);
    const id = (await r.json()).user.id;
    if (verify) await verifyEmail(ctx, id, u);
    return { ctx, id, username: u, name: name + ' Test' };
  }
  // the REAL verify route, with a one-time token planted in the (plain JSON) token store of the test server
  async function verifyEmail(ctx, id, u) {
    const raw = crypto.randomBytes(32).toString('hex'), file = path.join(stack.main.dataDir, 'auth', 'tokens.json'); let list = []; try { list = JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); } catch { /* none yet */ }
    list.push({ hash: crypto.createHash('sha256').update(raw).digest('hex'), userId: id, purpose: 'verify', exp: Date.now() + 3600e3, email: u + '@example.test' }); fs.writeFileSync(file, JSON.stringify(list));
    expect((await ctx.request.post(stack.base + '/api/auth/verify', { data: { token: raw } })).status()).toBe(200);
  }
  async function openPhone(ctx) {
    const page = await ctx.newPage(); await page.goto(stack.base + '/qorlla.html#home');
    await expect(async () => { await page.locator('.nav-item[data-view=phone]').click(); await expect(page.locator('#phTab-dial')).toBeVisible({ timeout: 3000 }); }).toPass({ timeout: 30000 }); return page;
  }
  const connected = (page) => expect.poll(() => page.evaluate(() => !!(window.qorllaVoice && window.qorllaVoice.ws && window.qorllaVoice.ws.readyState === 1)), { timeout: 30000 }).toBe(true);

  test('an UNVERIFIED account is told to verify: no voice token, no extension, the dial pad cannot place a call', async ({ browser }) => {
    const u = await account(browser, 'Newbie', { verify: false });
    expect((await u.ctx.request.post(stack.base + '/api/voice/token')).status()).toBe(403); expect((await (await u.ctx.request.post(stack.base + '/api/voice/token')).json()).error).toBe('verification_required');
    const page = await openPhone(u.ctx);
    await expect(page.locator('#qpMyExt')).toContainText('Verify your email address'); await expect(page.locator('#qpMyExt')).not.toContainText('Your Qorlla extension');
    await page.locator('#qpDialNumber').fill('5001'); await expect(page.locator('#qpDialHint')).toContainText('Verify your email address'); await expect(page.locator('#phCall')).toBeDisabled();
    await page.screenshot({ path: path.join(__dirname, '..', 'test-results', 'a36-unverified.png') }).catch(() => {});
    await u.ctx.close();
  });

  test('a VERIFIED account is ready: its extension shows, public telephone numbers are refused in the UI, and the number features are OFF', async ({ browser }) => {
    const u = await account(browser, 'Vera'); const page = await openPhone(u.ctx); await connected(page);
    await expect(page.locator('#qpMyExt')).toContainText('Your Qorlla extension'); await expect(page.locator('#qpMyExt')).not.toContainText('Your Qorlla number');
    await page.locator('#qpDialNumber').fill('+16502530000'); await expect(page.locator('#qpDialHint')).toContainText('Public telephone numbers are not available'); await expect(page.locator('#phCall')).toBeDisabled();
    await page.locator('#qpDialNumber').fill('911'); await expect(page.locator('#qpDialHint')).toContainText('cannot place emergency calls'); await expect(page.locator('#phCall')).toBeDisabled();
    // what the server says is switched on: internal calls yes, public numbers and PSTN no; and the number endpoint refuses with the policy answer
    expect(await page.evaluate(() => window.qorllaVoice.api('/features'))).toEqual({ internalCalls: true, numbers: false, pstn: false, countryAlias: false }); await expect(page.locator('#qpAlias')).toBeEmpty();       // country numbers are off by default: no form, no number
    expect(await page.evaluate(() => window.qorllaVoice.api('/numbers/me').then(() => 'allowed', (e) => e.code))).toBe('feature_disabled');
    const me = await page.evaluate(() => window.qorllaVoice.api('/me')); expect(me.standing).toEqual({ registered: true, verified: true, suspended: false });
    await u.ctx.close();
  });

  test('the page greys out calling when the server has switched internal calls off (feature flag from the server)', async ({ browser }) => {
    const u = await account(browser, 'Flag'), v = await account(browser, 'Other'); const page = await openPhone(v.ctx); await connected(page); const ext2 = (await page.locator('#qpMyExt').textContent()).match(/extension: (\d+)/)[1];
    const page2 = await u.ctx.newPage(); await page2.route('**/v1/voice/features', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ internalCalls: false, numbers: false, pstn: false }) }));
    await page2.goto(stack.base + '/qorlla.html#home'); await expect(async () => { await page2.locator('.nav-item[data-view=phone]').click(); await expect(page2.locator('#phTab-dial')).toBeVisible({ timeout: 3000 }); }).toPass({ timeout: 30000 }); await connected(page2);
    await page2.locator('#qpDialNumber').fill(ext2); await expect(page2.locator('#qpDialHint')).toContainText('switched off by your administrator'); await expect(page2.locator('#phCall')).toBeDisabled();
    await u.ctx.close(); await v.ctx.close();
  });

  test('two VERIFIED accounts hold a real call with Shield enforcement on (ring, answer, connected, hang up)', async ({ browser }) => {
    test.setTimeout(120000);
    const a = await account(browser, 'Alice'), b = await account(browser, 'Bob'); const pa = await openPhone(a.ctx), pb = await openPhone(b.ctx); await connected(pa); await connected(pb);
    const extB = (await pb.locator('#qpMyExt').textContent()).match(/extension: (\d+)/)[1];
    await pa.locator('#phTab-join').click(); await pa.locator('#phTab-dial').click(); await expect(pa.locator('#qpColleagues')).toContainText('Bob Test', { timeout: 20000 });
    await pa.locator('#qpDialNumber').fill(extB); await expect(pa.locator('#qpDialHint')).toContainText('Internet call to'); await expect(pa.locator('#phCall')).toBeEnabled();
    await pa.locator('#phCall').click(); await expect(pb.locator('#voiceIncoming')).toBeVisible({ timeout: 10000 }); await pb.locator('#viAnswer').click();
    for (const p of [pa, pb]) await expect(p.locator('#vbStatus')).toContainText('Connected', { timeout: 20000 });
    await pa.locator('#vbEnd').click();
    await expect(pa.locator('#voiceBar')).toBeHidden({ timeout: 15000 }); await a.ctx.close(); await b.ctx.close();
  });

  test('SUSPENSION while connected: the open page learns it, stops, cannot call, and the account has no session or voice token any more', async ({ browser }) => {
    test.setTimeout(120000);
    const admin = await account(browser, 'adminx'), victim = await account(browser, 'Sam'); const page = await openPhone(victim.ctx); await connected(page); await expect(page.locator('#qpMyExt')).toContainText('Your Qorlla extension');
    expect((await admin.ctx.request.post(stack.base + '/api/admin/accounts/' + victim.id + '/suspend', { data: { suspended: true } })).status()).toBe(200);
    await expect(page.locator('#qpMyExt')).toContainText('Your account is suspended', { timeout: 20000 });
    await page.locator('#qpDialNumber').fill('5001'); await expect(page.locator('#qpDialHint')).toContainText('suspended'); await expect(page.locator('#phCall')).toBeDisabled();
    expect((await victim.ctx.request.post(stack.base + '/api/voice/token')).status()).toBe(401);
    expect((await (await fetch(stack.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: victim.username, password: PASSWORD }) })).status)).toBe(403);
    await admin.ctx.close(); await victim.ctx.close();
  });
});
