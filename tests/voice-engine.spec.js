const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const AxeBuilder = require('@axe-core/playwright').default;
const { startMain, PASSWORD } = require('./support/meet-stack');

// Qorlla Voice end to end: the real main app, the real voice engine, a real PostgreSQL schema, and TWO REAL BROWSERS holding a call over real WebRTC with a synthetic microphone.
// What this proves: signaling, one-use tickets, call state, encrypted audio flowing in both directions (browser statistics), mute, hang-up, history, privacy of the microphone.
// What it does NOT prove: calls across different networks (needs TURN), real microphones/speakers, other browsers' WebRTC stacks, Safari/iOS, or load.
const root = path.resolve(__dirname, '..');
const secrets = JSON.parse(fs.readFileSync(path.join(root, '.dev-stack', 'secrets.json'), 'utf8'));
const DB = 'postgres://qorlla:' + secrets.dbPassword + '@127.0.0.1:' + (process.env.MEET_DB_PORT || 35432) + '/qorlla_meet';
const ADMIN = 'v'.repeat(40), MAIN_PORT = 5287, VOICE_PORT = 5288;

test.describe('Qorlla Voice: two browsers, real audio', () => {
  test.describe.configure({ mode: 'serial' });
  let main, engine, schema, admin; const log = [];
  test.beforeAll(async () => {
    schema = 'qe2e_' + Math.random().toString(36).slice(2, 9); admin = new Pool({ connectionString: DB }); await admin.query('CREATE SCHEMA ' + schema);
    const sp = new Pool({ connectionString: DB, options: '-c search_path=' + schema }); for (const f of fs.readdirSync(path.join(root, 'qorlla-voice-engine', 'sql')).filter((x) => /^\d{3}_.+\.sql$/.test(x)).sort()) await sp.query(fs.readFileSync(path.join(root, 'qorlla-voice-engine', 'sql', f), 'utf8')); await sp.end();
    main = await startMain(MAIN_PORT, { QORLLA_VOICE_ENABLED: 'true', VOICE_ADMIN_SECRET: ADMIN, VOICE_PORT: String(VOICE_PORT), VOICE_INTERNAL_URL: 'http://127.0.0.1:' + VOICE_PORT });
    engine = spawn(process.execPath, ['src/server.mjs'], { cwd: path.join(root, 'qorlla-voice-engine'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(VOICE_PORT), DATABASE_URL: DB + '?options=' + encodeURIComponent('-c search_path=' + schema), VOICE_JWKS_URL: 'http://127.0.0.1:' + MAIN_PORT + '/.well-known/voice-jwks.json',
      VOICE_JWT_ISSUER: 'qorlla-main', VOICE_JWT_AUDIENCE: 'qorlla-voice', VOICE_ALLOWED_ORIGIN: 'http://localhost:' + MAIN_PORT, VOICE_ADMIN_SECRET: ADMIN, VOICE_RING_SECONDS: '5' } });
    for (const s of [engine.stdout, engine.stderr]) s.on('data', (d) => log.push(String(d)));
    for (let i = 0; i < 60; i++) { if (await fetch('http://127.0.0.1:' + VOICE_PORT + '/readyz').then((r) => r.ok).catch(() => false)) break; await new Promise((r) => setTimeout(r, 400)); }
  });
  test.afterAll(async () => { if (engine) engine.kill(); if (main) main.stop(); if (admin) { await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(() => {}); await admin.end(); } });

  const rand = () => Math.random().toString(36).slice(2, 7);
  async function person(browser, name) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] }), u = name + rand();
    expect((await ctx.request.post(main.base + '/api/auth/register', { data: { username: u, displayName: name + ' Test', password: PASSWORD } })).status()).toBe(201);
    return { ctx, name: name + ' Test', username: u, ...(await open(ctx)) };
  }
  async function open(ctx) {
    const page = await ctx.newPage(); await page.goto(main.base + '/qorlla.html#home'); await expect(async () => { await page.locator('.nav-item[data-view=phone]').click(); await expect(page.locator('#phTab-dial')).toBeVisible({ timeout: 3000 }); }).toPass({ timeout: 30000 });
    await expect.poll(() => page.evaluate(() => !!(window.qorllaVoice && window.qorllaVoice.ws && window.qorllaVoice.ws.readyState === 1)), { timeout: 20000 }).toBe(true);
    await expect(page.locator('#qpMyExt')).toContainText('Your Qorlla extension'); const ext = (await page.locator('#qpMyExt').textContent()).match(/extension: (\d+)/)[1]; return { page, ext };
  }
  const refresh = async (p) => { await p.locator('#phTab-join').click(); await p.locator('#phTab-dial').click(); };
  const stats = (p) => p.evaluate(() => window.qorllaVoice.stats());
  const liveTracks = (p) => p.evaluate(() => (window.qorllaVoice.stream ? window.qorllaVoice.stream.getTracks().filter((t) => t.readyState === 'live').length : 0));

  test('the service is healthy and refuses what it should', async () => {
    expect((await fetch('http://127.0.0.1:' + VOICE_PORT + '/healthz')).status).toBe(200);
    expect((await fetch('http://127.0.0.1:' + VOICE_PORT + '/v1/voice/me')).status).toBe(401);                                                  // no identity, no service
    expect((await fetch(main.base + '/api/voice/token', { method: 'POST' })).status).toBe(401);                                                 // the main app only issues tokens to a signed-in session
    const jwks = await (await fetch(main.base + '/.well-known/voice-jwks.json')).json(); expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' }); expect(jwks.keys[0].d).toBeUndefined();   // the public key only, never the private part
    expect((await fetch('http://127.0.0.1:' + VOICE_PORT + '/v1/voice/admin/identities', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"accountId":"x"}' })).status).toBe(401);
  });

  test('a real call: ring, answer, two-way encrypted audio, mute, hang up; the microphone is closed afterwards; history shows it', async ({ browser }) => {
    test.setTimeout(120000);
    const alice = await person(browser, 'Alice'), bob = await person(browser, 'Bob');
    await refresh(alice.page); await expect(alice.page.locator('#qpColleagues')).toContainText('Bob Test', { timeout: 20000 });
    // privacy: nobody's microphone has been touched by being signed in, connected, or dialling
    expect(await liveTracks(bob.page)).toBe(0);
    // alice chooses Bob from the colleague list, sees who she is about to call, and dials
    await alice.page.locator('.qp-colleague', { hasText: 'Bob Test' }).click(); await expect(alice.page.locator('#qpDialNumber')).toHaveValue(bob.ext); await expect(alice.page.locator('#qpDialHint')).toContainText('Internet call to Bob Test'); await expect(alice.page.locator('#phCall')).toBeEnabled();
    await alice.page.locator('#phCall').click(); await expect(alice.page.locator('#voiceBar')).toBeVisible(); await expect(alice.page.locator('#vbPeer')).toContainText('Bob Test');
    await expect(bob.page.locator('#voiceIncoming')).toBeVisible({ timeout: 10000 }); await expect(bob.page.locator('#viWho')).toContainText('Alice Test');
    expect(await liveTracks(bob.page)).toBe(0); expect(await liveTracks(alice.page)).toBe(0);                                                   // still ringing: both microphones are off
    await bob.page.locator('#viAnswer').click();
    for (const p of [alice.page, bob.page]) { await expect(p.locator('#vbStatus')).toContainText('Connected', { timeout: 20000 }); await expect(p.locator('#voiceBar')).toBeVisible(); }
    // real media: bytes are flowing in BOTH directions on BOTH sides, over Opus, and the far end's sound has energy
    for (const [label, p] of [['alice', alice.page], ['bob', bob.page]]) {
      await expect.poll(async () => { const s = await stats(p); return s && s.bytesReceived > 3000 && s.bytesSent > 3000 ? 'flowing' : JSON.stringify(s); }, { timeout: 20000, intervals: [500], message: label + ' audio' }).toBe('flowing');
      const s = await stats(p); expect(s.connectionState).toBe('connected'); expect(String(s.codec).toLowerCase()).toContain('opus'); expect(s.packetsLost).toBeLessThan(25);
      await expect.poll(async () => (await stats(p)).totalAudioEnergy, { timeout: 15000, intervals: [500], message: label + ' hears sound' }).toBeGreaterThan(0);
    }
    expect(await liveTracks(alice.page)).toBe(1); expect(await liveTracks(bob.page)).toBe(1);
    // mute: the local track is switched off, the bar says so, and un-mute restores it
    await alice.page.locator('#vbMute').click(); await expect(alice.page.locator('#vbMute')).toHaveAttribute('aria-pressed', 'true'); expect(await alice.page.evaluate(() => window.qorllaVoice.stream.getAudioTracks()[0].enabled)).toBe(false);
    await alice.page.locator('#vbMute').click(); expect(await alice.page.evaluate(() => window.qorllaVoice.stream.getAudioTracks()[0].enabled)).toBe(true);
    // a second call cannot be started while in one
    expect(await alice.page.evaluate(() => window.qorllaVoice.dial('2999').then(() => 'dialled', (e) => e.message))).toBe('already_in_call');
    await alice.page.waitForTimeout(1200);
    // hang up from Alice: Bob's bar goes, every microphone closes
    await alice.page.locator('#vbEnd').click(); await expect(alice.page.locator('#voiceBar')).toBeHidden(); await expect(bob.page.locator('#voiceBar')).toBeHidden({ timeout: 10000 });
    await expect.poll(() => liveTracks(alice.page)).toBe(0); await expect.poll(() => liveTracks(bob.page)).toBe(0); expect(await alice.page.evaluate(() => window.qorllaVoice.pc)).toBeNull();
    // history: both sides, with who, direction and a server-measured duration; Alice can call back
    await alice.page.locator('#phTab-recent').click(); await expect(alice.page.locator('.qp-call-row', { hasText: 'Call to Bob Test' })).toContainText('Internet call'); await alice.page.locator('.qp-call-row', { hasText: 'Call to Bob Test' }).click();
    await expect(alice.page.locator('#qpVoiceDetail')).toContainText('Bob Test'); await expect(alice.page.locator('#qpCallDetail')).toContainText('Outgoing'); await expect(alice.page.locator('#qpCallDetail')).toContainText(bob.ext); await expect(alice.page.locator('#qpCallBack')).toBeEnabled();
    await bob.page.locator('#phTab-recent').click(); await expect(bob.page.locator('.qp-call-row', { hasText: 'Call from Alice Test' })).toBeVisible();
    await alice.page.locator('#recent-calls [data-f=calls]').click(); await expect(alice.page.locator('.qp-call-row')).toHaveCount(1); await alice.page.locator('#recent-calls [data-f=meeting]').click(); await expect(alice.page.locator('#phNoCalls')).toBeVisible();
    await alice.ctx.close(); await bob.ctx.close();
  });

  test('declining, an unanswered call, a refused microphone, and answering on another device', async ({ browser }) => {
    test.setTimeout(150000);
    const carol = await person(browser, 'Carol'), dan = await person(browser, 'Dan'); await refresh(carol.page); await expect(carol.page.locator('#qpColleagues')).toContainText('Dan Test', { timeout: 20000 });
    const dialDan = async () => { await carol.page.locator('#qpDialNumber').fill(dan.ext); await expect(carol.page.locator('#phCall')).toBeEnabled(); await carol.page.locator('#phCall').click(); };
    // decline
    await dialDan(); await expect(dan.page.locator('#voiceIncoming')).toBeVisible({ timeout: 10000 }); await dan.page.locator('#viDecline').click(); await expect(dan.page.locator('#voiceIncoming')).toBeHidden(); await expect(carol.page.locator('#voiceBar')).toBeHidden({ timeout: 10000 });
    expect(await liveTracks(dan.page)).toBe(0); expect(await liveTracks(carol.page)).toBe(0);                                                   // nobody's microphone was ever opened
    // a microphone that is refused: the call is NOT answered, and the caller keeps ringing until the timeout
    await dan.page.evaluate(() => { window.__realGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })); });
    await dialDan(); await expect(dan.page.locator('#voiceIncoming')).toBeVisible({ timeout: 10000 }); await dan.page.locator('#viAnswer').click(); await expect(dan.page.locator('#voiceIncoming')).toBeHidden(); await expect(dan.page.locator('#toast.show')).toContainText('Microphone access was blocked');
    expect((await (await fetch('http://127.0.0.1:' + VOICE_PORT + '/readyz')).json()).ok).toBe(true);
    // unanswered: it becomes missed on its own (5 s here), and both people are told
    await expect(carol.page.locator('#voiceBar')).toBeHidden({ timeout: 25000 });
    await carol.page.locator('#phTab-recent').click(); await carol.page.locator('#recent-calls [data-f=missed]').click(); await expect(carol.page.locator('.qp-call-row').first()).toContainText('Missed'); await dan.page.evaluate(() => { navigator.mediaDevices.getUserMedia = window.__realGum; });
    // the same person on two devices: both ring; answering on one dismisses the other
    const dan2 = await open(dan.ctx); await carol.page.locator('#phTab-dial').click(); await dialDan(); await expect(dan.page.locator('#voiceIncoming')).toBeVisible({ timeout: 10000 }); await expect(dan2.page.locator('#voiceIncoming')).toBeVisible({ timeout: 10000 });
    await dan.page.locator('#viAnswer').click(); await expect(dan2.page.locator('#voiceIncoming')).toBeHidden({ timeout: 10000 }); await expect(dan.page.locator('#vbStatus')).toContainText('Connected', { timeout: 20000 }); expect(await liveTracks(dan2.page)).toBe(0);   // the other device never opened its microphone
    await carol.page.locator('#vbEnd').click(); await expect(dan.page.locator('#voiceBar')).toBeHidden({ timeout: 10000 }); await carol.ctx.close(); await dan.ctx.close();
  });

  test('busy people, bad extensions and yourself get plain answers; the screens are accessible', async ({ browser }) => {
    test.setTimeout(120000);
    const erin = await person(browser, 'Erin'), finn = await person(browser, 'Finn'), gail = await person(browser, 'Gail'); await refresh(erin.page); await expect(erin.page.locator('#qpColleagues')).toContainText('Finn Test', { timeout: 20000 });
    await erin.page.locator('#qpDialNumber').fill(erin.ext); await expect(erin.page.locator('#qpDialHint')).toContainText('own extension'); await expect(erin.page.locator('#phCall')).toBeDisabled();
    for (const n of ['911', '112', '999']) { await erin.page.locator('#qpDialNumber').fill(n); await expect(erin.page.locator('#qpDialHint')).toContainText('cannot place emergency calls'); await expect(erin.page.locator('#phCall')).toBeDisabled(); }   // never rings a colleague
    await erin.page.locator('#qpDialNumber').fill('999999'); await expect(erin.page.locator('#phCall')).toBeEnabled(); await erin.page.locator('#phCall').click(); await expect(erin.page.locator('#voiceBar')).toBeHidden({ timeout: 10000 });   // nobody has that extension
    await erin.page.locator('#qpDialNumber').fill(finn.ext); await erin.page.locator('#phCall').click(); await expect(finn.page.locator('#voiceIncoming')).toBeVisible({ timeout: 10000 });
    // accessibility of the new surfaces: the ringing dialog, the call bar and the Dial Pad with colleagues
    const bad = async (p, sel) => (await new AxeBuilder({ page: p }).include(sel).analyze()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id + ' ' + v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | '));
    expect(await bad(finn.page, '#voiceIncoming'), 'incoming dialog').toEqual([]); expect(await bad(erin.page, '#voiceBar'), 'call bar').toEqual([]); expect(await bad(erin.page, '.qp'), 'dial pad').toEqual([]);
    await expect(finn.page.locator('#viAnswer')).toBeFocused();                                                                                   // the Answer button has focus when the dialog opens
    await finn.page.keyboard.press('Escape'); await expect(finn.page.locator('#voiceIncoming')).toBeHidden(); await expect(erin.page.locator('#voiceBar')).toBeHidden({ timeout: 10000 });   // Escape declines
    // while Gail is ringing, nobody else can reach her or the caller
    await gail.page.locator('#qpDialNumber').fill(finn.ext); await gail.page.locator('#phCall').click(); await expect(finn.page.locator('#voiceIncoming')).toBeVisible({ timeout: 10000 });
    await erin.page.locator('#qpDialNumber').fill(finn.ext); await erin.page.locator('#phCall').click(); await expect(erin.page.locator('#voiceBar')).toBeHidden({ timeout: 10000 }); await expect(erin.page.locator('#toast.show')).toContainText('another call');
    await finn.page.locator('#viDecline').click(); await erin.ctx.close(); await finn.ctx.close(); await gail.ctx.close();
  });

  test('the engine exposes no secrets, and the page shows the right thing when Qorlla Voice is not set up', async ({ browser }) => {
    test.setTimeout(90000);
    const text = log.join(''); expect(text).not.toContain(ADMIN); expect(text).not.toMatch(/ticket=|Bearer /);                                      // the engine log carries no secret, token or ticket
    const flagless = await startMain(5281, { VOICE_ADMIN_SECRET: ADMIN }); try {                                                                       // the secret alone does not switch voice on: the flag is separate
      const c0 = await browser.newContext(); expect((await c0.request.post(flagless.base + '/api/auth/register', { data: { username: 'fl' + rand(), displayName: 'Flagless', password: PASSWORD } })).status()).toBe(201);
      const cfg = await (await c0.request.get(flagless.base + '/api/voice/config')).json(); expect(cfg.enabled).toBe(false); expect(cfg.reason).toContain('QORLLA_VOICE_ENABLED'); expect((await c0.request.post(flagless.base + '/api/voice/token')).status()).toBe(503); expect((await c0.request.get(flagless.base + '/.well-known/voice-jwks.json')).status()).toBe(404); await c0.close();
    } finally { flagless.stop(); }
    const plain = await startMain(5286, {}); try {                                                                                                   // a server where voice is not configured
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); expect((await ctx.request.post(plain.base + '/api/auth/register', { data: { username: 'nov' + rand(), displayName: 'NoVoice', password: PASSWORD } })).status()).toBe(201);
      expect((await (await ctx.request.get(plain.base + '/api/voice/config')).json()).enabled).toBe(false); expect((await ctx.request.post(plain.base + '/api/voice/token')).status()).toBe(503); expect((await ctx.request.get(plain.base + '/.well-known/voice-jwks.json')).status()).toBe(404);
      const p = await ctx.newPage(); await p.goto(plain.base + '/qorlla.html#home'); await p.locator('.nav-item[data-view=phone]').click(); await p.locator('#qpDialNumber').fill('2041'); await expect(p.locator('#qpDialHint')).toContainText('not set up'); await expect(p.locator('#phCall')).toBeDisabled(); await expect(p.locator('#qpColleagues')).toBeEmpty(); await ctx.close();
    } finally { plain.stop(); }
  });
});
