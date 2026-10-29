const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const AxeBuilder = require('@axe-core/playwright').default;
const { PASSWORD } = require('./support/meet-stack');

// A check of the REAL, RUNNING Qorlla application (the dev stack: `npm run dev:stack`), not a throwaway server. It registers a few "qa" test accounts in that stack's data folder, then uses real browsers
// (headless Chromium, synthetic microphone) to place real calls through the real voice engine. Run it with:  LIVE_BASE=http://localhost:3200 npx playwright test tests/live-voice-check.spec.js --project=chromium
// Screenshots go to .dev-stack/live-check/. It does not run as part of the normal suite.
const BASE = process.env.LIVE_BASE, root = path.resolve(__dirname, '..'), shots = path.join(root, '.dev-stack', 'live-check');
const secrets = fs.existsSync(path.join(root, '.dev-stack', 'secrets.json')) ? JSON.parse(fs.readFileSync(path.join(root, '.dev-stack', 'secrets.json'), 'utf8')) : {};
const VOICE = process.env.LIVE_VOICE || 'http://127.0.0.1:4600';

test.describe('Live check: the running Qorlla application', () => {
  test.skip(!BASE, 'set LIVE_BASE to the running application, e.g. http://localhost:3200');
  test.describe.configure({ mode: 'serial' });
  fs.mkdirSync(shots, { recursive: true });
  const rand = () => Math.random().toString(36).slice(2, 7), RUN = rand();      // display names carry a per-run tag, so repeated runs on the same stack never collide
  const adminGet = (p, bearer) => fetch(VOICE + p, { headers: bearer ? { authorization: 'Bearer ' + secrets.voiceAdmin } : { 'x-voice-admin-secret': secrets.voiceAdmin } }).then(async (r) => ({ status: r.status, body: await r.text() }));

  async function openPhone(ctx) {
    const page = await ctx.newPage(); await page.goto(BASE + '/qorlla.html#home');
    await expect(async () => { await page.locator('.nav-item[data-view=phone]').click(); await expect(page.locator('#phTab-dial')).toBeVisible({ timeout: 3000 }); }).toPass({ timeout: 30000 });
    await expect.poll(() => page.evaluate(() => !!(window.qorllaVoice && window.qorllaVoice.ws && window.qorllaVoice.ws.readyState === 1)), { timeout: 30000 }).toBe(true);
    await expect(page.locator('#qpMyExt')).toContainText('Your Qorlla extension'); return { page, ext: (await page.locator('#qpMyExt').textContent()).match(/extension: (\d+)/)[1] };
  }
  async function person(browser, name) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] }), u = 'qa' + name.toLowerCase() + rand();
    expect((await ctx.request.post(BASE + '/api/auth/register', { data: { username: u, displayName: 'QA ' + name + ' ' + RUN, password: PASSWORD } })).status()).toBe(201);
    return { ctx, username: u, name: 'QA ' + name + ' ' + RUN, ...(await openPhone(ctx)) };
  }
  const tracks = (p) => p.evaluate(() => { const c = window.qorllaVoice; return [c.stream, c.roomStream].filter(Boolean).flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length; });
  const flows = async (p, label) => expect.poll(async () => { const s = await p.evaluate(() => window.qorllaVoice.stats()); return s && s.bytesReceived > 3000 && s.bytesSent > 3000 ? 'flowing' : JSON.stringify(s); }, { timeout: 30000, intervals: [500], message: label }).toBe('flowing');
  const bad = async (p, sel) => (await new AxeBuilder({ page: p }).include(sel).analyze()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id);
  let alice, bob, carol;

  test('1. the services are up and report themselves honestly', async ({ request }) => {
    expect((await request.get(BASE + '/')).status()).toBe(200);
    const health = await (await fetch(VOICE + '/healthz')).json(); expect(health).toMatchObject({ ok: true, service: 'qorlla-voice', pstn: false });
    const ready = await (await fetch(VOICE + '/readyz')).json(); expect(ready.ok).toBe(true);
    const strict = await fetch(VOICE + '/v1/voice/operational/readiness'); const sb = await strict.json(); expect(strict.status).toBe(200); expect(sb).toMatchObject({ ready: true, db: true }); expect(sb.outbox.pending).toBe(0);
    const jwks = await (await request.get(BASE + '/.well-known/voice-jwks.json')).json(); expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256' }); expect(jwks.keys[0].d).toBeUndefined();       // public key only
    expect((await fetch(VOICE + '/v1/voice/admin/identities')).status).toBe(401);
    const m = await adminGet('/v1/voice/admin/metrics', true); expect(m.status).toBe(200); const mj = JSON.parse(m.body); expect(mj.outbox.dead).toBe(0); expect(mj.history.retentionDays).toBe(365);
  });

  test('2. a one-to-one call: ring, answer, audio both ways, mute, hang up, history', async ({ browser }) => {
    test.setTimeout(180000);
    alice = await person(browser, 'Alice'); bob = await person(browser, 'Bob'); carol = await person(browser, 'Carol');
    await alice.page.locator('#phTab-join').click(); await alice.page.locator('#phTab-dial').click(); await expect(alice.page.locator('#qpColleagues')).toContainText('Qorlla colleagues', { timeout: 20000 }); if (await alice.page.locator('#qpColSearch').count()) await alice.page.locator('#qpColSearch').fill(bob.name);   // with more than 8 colleagues the list has a search
    await expect(alice.page.locator('#qpColleagues')).toContainText(bob.name, { timeout: 20000 }); if (await alice.page.locator('#qpColSearch').count()) await alice.page.locator('#qpColSearch').fill('');
    await alice.page.screenshot({ path: path.join(shots, '01-phone-colleagues.png') });
    expect(await tracks(bob.page)).toBe(0);
    await alice.page.locator('#qpDialNumber').fill(bob.ext); await alice.page.locator('#phCall').click(); await expect(bob.page.locator('#voiceIncoming')).toBeVisible({ timeout: 15000 }); await bob.page.screenshot({ path: path.join(shots, '02-incoming-call.png') });
    expect(await tracks(bob.page)).toBe(0);                                                                                                           // ringing: microphones off
    await bob.page.locator('#viAnswer').click(); for (const p of [alice, bob]) await expect(p.page.locator('#vbStatus')).toContainText('Connected', { timeout: 30000 });
    await flows(alice.page, 'alice'); await flows(bob.page, 'bob'); const s = await alice.page.evaluate(() => window.qorllaVoice.stats()); expect(String(s.codec).toLowerCase()).toContain('opus'); expect(s.totalAudioEnergy).toBeGreaterThanOrEqual(0);
    await alice.page.locator('#vbMute').click(); await expect(alice.page.locator('#vbMute')).toHaveAttribute('aria-pressed', 'true'); await alice.page.locator('#vbMute').click();
    await alice.page.screenshot({ path: path.join(shots, '03-call-connected.png') }); expect(await bad(alice.page, '#voiceBar')).toEqual([]);
    await alice.page.locator('#vbEnd').click(); await expect(bob.page.locator('#voiceBar')).toBeHidden({ timeout: 15000 }); await expect.poll(() => tracks(alice.page)).toBe(0); await expect.poll(() => tracks(bob.page)).toBe(0);
    await alice.page.locator('#phTab-recent').click(); await expect(alice.page.locator('.qp-call-row', { hasText: 'Internet call' }).first()).toContainText(bob.name);
  });

  test('3. a group call of three: invite, answer, audio in every direction, leave, host ends; history; deletion', async () => {
    test.setTimeout(240000);
    await alice.page.locator('#phTab-dial').click(); await alice.page.locator('#qpGroupBtn').click();
    const find = async (q) => { if (await alice.page.locator('#qpColSearch').count()) await alice.page.locator('#qpColSearch').fill(q); };
    await find(bob.name); await alice.page.getByLabel(`Add ${bob.name} to the group call`).check(); await find(carol.name); await alice.page.getByLabel(`Add ${carol.name} to the group call`).check(); await find('');
    await alice.page.locator('#qpGroupGo').click(); for (const p of [bob, carol]) { await expect(p.page.locator('#voiceIncoming')).toBeVisible({ timeout: 15000 }); await expect(p.page.locator('#viTitle')).toContainText('group call'); }
    await bob.page.locator('#viAnswer').click(); await carol.page.locator('#viAnswer').click(); for (const p of [alice, bob, carol]) await expect(p.page.locator('#vbStatus')).toContainText('Connected', { timeout: 45000 });
    for (const [label, p] of [['alice', alice], ['bob', bob], ['carol', carol]]) await expect.poll(async () => { const r = Object.values(await p.page.evaluate(() => window.qorllaVoice.roomStats())); return r.length === 2 && r.every((x) => x.bytesReceived > 3000 && x.bytesSent > 3000) ? 'ok' : JSON.stringify(r); }, { timeout: 40000, intervals: [700], message: label }).toBe('ok');
    await alice.page.screenshot({ path: path.join(shots, '04-group-call.png') });
    await carol.page.locator('#vbEnd').click(); await expect(alice.page.locator('#vbPeer')).toContainText('2 people', { timeout: 15000 }); await alice.page.waitForTimeout(1500);
    await alice.page.locator('#vbEndAll').click(); await expect(bob.page.locator('#voiceBar')).toBeHidden({ timeout: 15000 }); for (const p of [alice, bob, carol]) await expect.poll(() => tracks(p.page)).toBe(0);
    // history + privacy
    await alice.page.locator('#phTab-dial').click(); await alice.page.locator('#phTab-recent').click(); const row = alice.page.locator('.qp-call-row', { hasText: 'Group call' }).first(); await expect(row).toContainText('Host'); await expect(row).toContainText('Completed'); await row.click();
    await expect(alice.page.locator('#qpGroupStays .qp-stay')).toHaveCount(1); await expect(alice.page.locator('#qpGroupTimeline')).toContainText('You joined'); await expect(alice.page.locator('#qpGroupPolicy')).toContainText('kept for 365 days');
    const groupText = (await row.innerText()) + (await alice.page.locator('#qpGroupDetail').innerText()) + (await alice.page.locator('#qpGroupFacts').innerText()) + (await alice.page.locator('#qpGroupStays').innerText()) + (await alice.page.locator('#qpGroupTimeline').innerText()); expect(groupText).not.toContain(bob.name); expect(groupText).not.toContain(carol.name); /* the group call names nobody else */ await alice.page.screenshot({ path: path.join(shots, '05-group-history.png') }); expect(await bad(alice.page, '#recent-calls')).toEqual([]);
    await carol.page.locator('#phTab-recent').click(); await carol.page.locator('.qp-call-row', { hasText: 'Group call' }).first().click(); await carol.page.locator('#qpGroupDelete').click(); await expect(carol.page.locator('#qpGroupDeleteYesNo')).toBeFocused(); await carol.page.locator('#qpGroupDeleteYes').click();
    await expect(carol.page.locator('.qp-call-row', { hasText: 'Group call' })).toHaveCount(0, { timeout: 15000 }); await alice.page.locator('#phTab-dial').click(); await alice.page.locator('#phTab-recent').click(); await expect(alice.page.locator('.qp-call-row', { hasText: 'Group call' }).first()).toBeVisible();   // alice keeps hers
  });

  test('4. the same person on a second device takes a call over; a page reload recovers by itself', async ({ browser }) => {
    test.setTimeout(240000);
    await alice.page.locator('#phTab-dial').click(); await alice.page.locator('#qpDialNumber').fill(bob.ext); await alice.page.locator('#phCall').click(); await expect(bob.page.locator('#voiceIncoming')).toBeVisible({ timeout: 15000 }); await bob.page.locator('#viAnswer').click();
    for (const p of [alice, bob]) await expect(p.page.locator('#vbStatus')).toContainText('Connected', { timeout: 30000 }); await flows(alice.page, 'alice'); await flows(bob.page, 'bob');
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] }); expect((await ctx2.request.post(BASE + '/api/auth/login', { data: { username: alice.username, password: PASSWORD } })).status()).toBe(200);
    const dev2 = await openPhone(ctx2); await expect(dev2.page.locator('#voiceMove')).toBeVisible({ timeout: 20000 }); await dev2.page.screenshot({ path: path.join(shots, '06-continue-here.png') }); expect(await tracks(dev2.page)).toBe(0); await dev2.page.locator('#vmHere').click();
    await expect(dev2.page.locator('#vbStatus')).toContainText('Connected', { timeout: 40000 }); await expect(alice.page.locator('#voiceBar')).toBeHidden({ timeout: 10000 }); expect(await tracks(alice.page)).toBe(0); await flows(dev2.page, 'second device');
    await dev2.page.reload(); await expect(dev2.page.locator('#vbStatus')).toContainText('Connected', { timeout: 50000 }); await flows(dev2.page, 'after reload');                                  // reload mid-call
    await bob.page.locator('#vbEnd').click(); await expect(dev2.page.locator('#voiceBar')).toBeHidden({ timeout: 15000 }); await ctx2.close();
  });

  test('5. afterwards the engine is clean: nothing waiting, nothing set aside, every account\'s events in order, no secrets in the log', async () => {
    const m = JSON.parse((await adminGet('/v1/voice/admin/metrics', true)).body); await expect.poll(async () => JSON.parse((await adminGet('/v1/voice/admin/metrics', true)).body).outbox.pending, { timeout: 15000 }).toBe(0);
    expect(m.outbox.dead).toBe(0); expect(m.outbox.failClosed).toBe(false);
    for (const p of [alice, bob, carol]) { const ev = await p.page.evaluate(() => window.qorllaVoice.api('/events?after=0')); const ids = ev.events.map((e) => e.id); if (p !== carol) expect(ids.length).toBeGreaterThan(3);   /* carol deleted her group-call record, which removes her delivered copies of its events */ expect(ids).toEqual([...ids].sort((a, b) => a - b)); expect(JSON.stringify(ev)).not.toMatch(/"sdp"|candidate:/); }
    const prom = await adminGet('/v1/voice/admin/metrics?format=prometheus', true); expect(prom.body).toContain('qorlla_voice_outbox_pending 0'); expect(prom.body).toContain('qorlla_voice_outbox_dead 0');
    const log = fs.readFileSync(path.join(root, '.dev-stack', 'launch.log'), 'utf8') + (fs.existsSync(path.join(root, '.dev-stack', 'launch.err.log')) ? fs.readFileSync(path.join(root, '.dev-stack', 'launch.err.log'), 'utf8') : '');
    expect(log).not.toContain(secrets.voiceAdmin); expect(log).not.toMatch(/ticket=|Bearer ey/); expect(log).not.toMatch(/TypeError|ReferenceError|UnhandledPromise/);
    for (const p of [alice, bob, carol]) await p.ctx.close();
  });
});
