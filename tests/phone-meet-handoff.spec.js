const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const { PASSWORD } = require('./support/meet-stack');
const { startVoiceStack } = require('./support/voice-stack');
const { watch, dump } = require('./support/phone-diag');
const { Pool } = require('pg');
const path = require('node:path');

// Phone -> Meet hand-off v2.2, END TO END in two real Chromium sessions (fake camera and microphone) against the real main app, the real Voice Engine on PostgreSQL and the REAL Qorlla Meet
// (node on :3310, own PostgreSQL schema). Meet must be running WITH a Shield workload credential for this test engine: node scripts/phone-meet-test-meet.cjs (it writes the JWKS this spec serves). What this proves: the whole path on one machine with synthetic media. What it does NOT prove: physical
// devices, other networks, TURN, or mobile browsers.
const MAIN = 5343, VOICE = 5344;
test.describe('Phone to Meet hand-off (v2.2)', () => {
  test.describe.configure({ mode: 'default' });                                   // independent scenarios: one failure must not hide the others
  let stack, jwks, pool, T0 = Date.now(), LOG = [], PAGES = {}, CTXS = [];
  test.beforeEach(() => { T0 = Date.now(); LOG = []; PAGES = {}; CTXS = []; });
  test.afterEach(async ({}, info) => { if (info.status !== info.expectedStatus && pool) await dump({ dir: process.env.PM_DIAG_DIR || path.join(__dirname, '..', 'test-results', 'diag'), name: info.title, log: LOG, pages: PAGES, pool, stack, meetLog: process.env.QORLLA_TEST_MEET_LOG || require('node:os').tmpdir() + '/meet3310.log' });
    for (const c of CTXS) await c.close().catch(() => {});                                                  // every scenario ends with NO browser session left running against the shared engine and Meet (they used to pile up)
  });
  test.beforeAll(async () => {
    test.setTimeout(150000);
    const JWKS = process.env.QORLLA_TEST_MEET_JWKS || require('node:os').tmpdir() + '/meet-jwks.json';                       // written by the script that started Meet with its workload key
    jwks = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(fs.readFileSync(JWKS)); }); await new Promise((ok) => jwks.listen(5345, '127.0.0.1', ok));
    stack = await startVoiceStack({ mainPort: MAIN, voicePort: VOICE, engineEnv: { VOICE_RING_SECONDS: '60', VOICE_MOVE_RELEASE_WINDOW_SECONDS: '150', VOICE_MOVE_FRESH_MS: '8000', SHIELD_ENABLED: 'true', SHIELD_WORKLOAD_JWKS_URL: 'http://127.0.0.1:5345/jwks.json', SHIELD_WORKLOAD_ISSUER: 'qorlla-workload', SHIELD_WORKLOAD_ALLOWED: 'svc:meet=meet.signal' } });
    pool = new Pool({ connectionString: process.env.QORLLA_TEST_VOICE_DB, options: '-c search_path=' + stack.schema });
  });
  test.afterAll(async () => { if (pool) await pool.end(); if (stack) await stack.stop(); if (jwks) await new Promise((ok) => jwks.close(ok)); });
  const rand = () => Math.random().toString(36).slice(2, 7);
  async function account(browser, name) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['microphone', 'camera'] }), u = (name + rand()).toLowerCase(); CTXS.push(ctx);
    await ctx.addInitScript(() => { const c = window.close; window.close = function () { try { console.log('TRACE window.close() called from: ' + String(new Error().stack).replace(/\s+/g, ' ').slice(0, 400) + ' @' + location.href.slice(0, 80)); } catch (e) { /* none */ } return c.apply(this, arguments); }; });       // who closes a window (diagnosis only)
    expect((await ctx.request.post(stack.base + '/api/auth/register', { data: { username: u, displayName: name + ' Test', password: PASSWORD, email: u + '@example.test' } })).status()).toBeLessThan(300); return ctx;
  }
  async function openPhone(ctx) {
    const page = await ctx.newPage(), tag = PAGES.A ? 'B' : 'A'; PAGES[tag] = page; watch(page, tag, LOG, T0); page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300))); await page.goto(stack.base + '/qorlla.html#phone');
    await expect(async () => { await page.locator('.nav-item[data-view=phone]').click(); await expect(page.locator('#phTab-dial')).toBeVisible({ timeout: 3000 }); }).toPass({ timeout: 30000 }); return page;
  }
  const ready = (p) => expect.poll(() => p.evaluate(() => !!(window.qorllaVoice && window.qorllaVoice.ws && window.qorllaVoice.ws.readyState === 1)), { timeout: 30000 }).toBe(true);
  const extOf = (p) => p.evaluate(async () => { for (let i = 0; i < 60; i++) { try { const d = await (await fetch('/api/voice/directory', { credentials: 'same-origin' })).json(); const me = (d.people || []).find((x) => x.self); if (me) return me.extension; } catch (e) { /* retry */ } await new Promise((r) => setTimeout(r, 500)); } return ''; });
  async function connect(browser) {
    const ca = await account(browser, 'Ann'), cb = await account(browser, 'Ben'), pa = await openPhone(ca), pb = await openPhone(cb); await ready(pa); await ready(pb); const ext = await extOf(pb);
    await expect.poll(() => pa.evaluate(async (e) => { const d = await (await fetch('/api/voice/directory', { credentials: 'same-origin' })).json(); return (d.people || []).some((p) => p.extension === e && !p.self); }, ext), { timeout: 30000 }).toBe(true);
    await pa.locator('#qpDialNumber').fill(ext); await expect(pa.locator('#phCall')).toBeEnabled(); await pa.locator('#phCall').click();
    await expect(pb.locator('#voiceIncoming')).toBeVisible({ timeout: 20000 }); await pb.locator('#viAnswer').click();
    for (const p of [pa, pb]) await expect(p.locator('#vbStatus')).toContainText('Connected', { timeout: 40000 });
    await expect.poll(() => pa.evaluate(() => !!(window.qorllaVoice.peerCaps && window.qorllaVoice.peerCaps.move >= 2)), { timeout: 15000 }).toBe(true);
    return { ca, cb, pa, pb };
  }
  async function agree(pa, pb) {
    pa.on('response', (r) => { if (/\/move|meetings\/(create|[0-9 %]+\/settings)/.test(r.url()) && r.status() >= 400) console.log('[agree resp]', r.request().method(), r.status(), r.url().replace(/^https?:\/\/[^/]+/, '')); });
    await pa.locator('#stMove').click(); await expect(pb.locator('#voiceAsk')).toBeVisible({ timeout: 20000 }).catch(async (e) => { console.log('[agree] ask not shown; A toast/bar:', await pa.evaluate(() => (document.getElementById('toast') || {}).textContent + ' | ' + document.getElementById('vmbText').textContent), '| peerCaps', await pa.evaluate(() => JSON.stringify(window.qorllaVoice.peerCaps)), await pa.evaluate(() => window.qorllaVoice.ctl && window.qorllaVoice.ctl.readyState)); throw e; }); await pb.locator('#vaskYes').click();
    await expect(pa.locator('#vmbOpen')).toBeVisible({ timeout: 20000 }); await expect(pb.locator('#vmbOpen')).toBeVisible({ timeout: 20000 });
  }
  /** Presses Open meeting, then the Start / Join button of the dialog it opens, and returns the Meet window that appears. */
  async function openMeet(page) {
    const pop = page.context().waitForEvent('page', { timeout: 30000 });
    await page.locator('#vmbOpen').click(); await expect(page.locator('#startDialog')).toBeVisible({ timeout: 15000 }); await expect(page.locator('#sdGo')).toBeEnabled({ timeout: 20000 }); await page.locator('#sdGo').click();
    const meet = await pop; { const tag = 'M' + (PAGES.MA ? 'B' : 'A'); PAGES[tag] = meet; watch(meet, tag, LOG, T0); } await meet.waitForURL(/localhost:3310/, { timeout: 30000 }); return meet;
  }
  const phoneState = (p) => p.evaluate(() => ({ callId: window.qorllaVoice.callId, muted: window.qorllaVoice.muted }));
  const inboundAudio = (m) => m.evaluate(async () => (await window.__qorllaMeetProbe()).bytes);

  test('both join the SAME Meet room, hear each other, and only then does the server end the phone call (once, with the reason)', async ({ browser }) => {
    test.setTimeout(240000);
    const { pa, pb } = await connect(browser), callId = await pa.evaluate(() => window.qorllaVoice.callId);
    await agree(pa, pb);
    expect((await phoneState(pa)).muted, 'phone microphones are off during the move').toBe(true); expect((await phoneState(pb)).muted).toBe(true);
    const ma = await openMeet(pa);
    expect((await phoneState(pa)).callId, 'the phone call is still up while only ONE person is in Meet').toBe(callId); expect((await phoneState(pb)).callId).toBe(callId);
    await pa.waitForTimeout(6000); expect((await phoneState(pa)).callId, 'and it stays up: a lone participant never releases it').toBe(callId);
    const mb = await openMeet(pb);
    await expect.poll(async () => (await ma.evaluate(() => window.__qorllaMeetProbe())).participantId, { timeout: 30000 }).not.toBe(''); await expect.poll(async () => (await mb.evaluate(() => window.__qorllaMeetProbe())).participantId, { timeout: 30000 }).not.toBe('');
    const pra = await ma.evaluate(() => window.__qorllaMeetProbe()), prb = await mb.evaluate(() => window.__qorllaMeetProbe()); expect(pra.meetingId).toBe(prb.meetingId); expect(pra.participantId).not.toBe(prb.participantId);
    await expect.poll(() => inboundAudio(ma), { timeout: 60000 }).toBeGreaterThan(1000); await expect.poll(() => inboundAudio(mb), { timeout: 60000 }).toBeGreaterThan(1000);   // bidirectional audio inside Meet
    await expect.poll(() => pa.evaluate(() => window.qorllaVoice.callId), { timeout: 60000 }).toBeNull(); await expect.poll(() => pb.evaluate(() => window.qorllaVoice.callId), { timeout: 30000 }).toBeNull();
    const calls = await pa.evaluate(async () => (await window.qorllaVoice.api('/calls')).calls); const c = calls.find((x) => x.id === callId); expect(c.status).toBe('ended'); expect(c.end_reason).toBe('moved_to_meeting');
    expect(calls.filter((x) => x.id === callId).length).toBe(1);
    const lat = (await pool.query("SELECT extract(epoch FROM (init_ready_at - accepted_at)) AS init_s, extract(epoch FROM (recip_ready_at - accepted_at)) AS recip_s, extract(epoch FROM (completed_at - accepted_at)) AS done_s FROM voice_handoffs WHERE call_id=$1", [callId])).rows[0];
    console.log('[latency] accepted -> init ready ' + Number(lat.init_s).toFixed(1) + ' s, -> recip ready ' + Number(lat.recip_s).toFixed(1) + ' s, -> call ended ' + Number(lat.done_s).toFixed(1) + ' s');
  });

  test('premature release is impossible: B agrees but never joins -> the phone call carries on, microphones come back, the hand-off expires', async ({ browser }) => {
    test.setTimeout(300000);
    const { pa, pb } = await connect(browser), callId = await pa.evaluate(() => window.qorllaVoice.callId); await agree(pa, pb);
    await openMeet(pa);                                                                                              // only A ever enters Meet
    await expect.poll(async () => (await pa.evaluate(async (id) => window.qorllaVoice.api('/calls/' + id + '/move'), callId)).state, { timeout: 175000 }).toBe('expired');           // the 150 s window ends (the SERVER's record)
    await expect(pa.locator('#voiceMoveBar')).toBeHidden({ timeout: 15000 });
    for (const [who, p] of [['host', pa], ['guest', pb]]) { await expect.poll(() => p.evaluate(() => window.qorllaVoice.muted), { message: who + ' microphone restored', timeout: 15000 }).toBe(false); expect((await phoneState(p)).callId).toBe(callId); await expect(p.locator('#vbStatus')).toContainText('Connected'); }
    const st = await pa.evaluate(async (id) => window.qorllaVoice.api('/calls/' + id + '/move'), callId); expect(st.state).toBe('expired'); expect(st.closedReason).toBe('release_deadline_passed');
  });

  test('refresh recovery: B reloads its page mid hand-off, the server still holds the move, B resumes (microphone off) and the hand-off completes', async ({ browser }) => {
    test.setTimeout(240000);
    const { pa, pb } = await connect(browser), callId = await pa.evaluate(() => window.qorllaVoice.callId); await agree(pa, pb);
    const ma = await openMeet(pa), mb = await openMeet(pb);
    await pb.reload(); await expect(pb.locator('#voiceMoveBar')).toBeVisible({ timeout: 60000 }); await expect(pb.locator('#vmbText')).toContainText('still in progress');       // resumed from the server's record
    await expect.poll(() => inboundAudio(ma), { timeout: 60000 }).toBeGreaterThan(1000);
    await expect.poll(() => pa.evaluate(() => window.qorllaVoice.callId), { timeout: 90000 }).toBeNull();
    const c = (await pa.evaluate(async () => (await window.qorllaVoice.api('/calls')).calls)).find((x) => x.id === callId); expect(c.end_reason).toBe('moved_to_meeting'); void mb;
  });

  // ---------------------------------------------------------------- recovery scenarios (v2.3): the SERVER's record decides, a reload never ends a call
  const lastCall = async () => (await pool.query('SELECT id, status, end_reason FROM voice_calls ORDER BY created_at DESC LIMIT 1')).rows[0];
  const kinds = async (id) => (await pool.query('SELECT kind FROM voice_call_events WHERE call_id=$1 ORDER BY 1', [id])).rows.map((x) => x.kind);
  /** The server's own event record proves a call was never ended, missed, rejected or failed before the test ended it. */
  const neverEnded = async (id, what) => { const k = await kinds(id); expect(k.filter((x) => /^(ended|missed|rejected|failed|cancelled)$/.test(x)), what + ': the server recorded no end event; events were ' + k.join(',')).toEqual([]); };
  async function dialOnly(browser) {
    const ca = await account(browser, 'Ann'), cb = await account(browser, 'Ben'), pa = await openPhone(ca), pb = await openPhone(cb); await ready(pa); await ready(pb); const ext = await extOf(pb);
    await expect.poll(() => pa.evaluate(async (e) => { const d = await (await fetch('/api/voice/directory', { credentials: 'same-origin' })).json(); return (d.people || []).some((p) => p.extension === e && !p.self); }, ext), { timeout: 30000 }).toBe(true);
    await pa.locator('#qpDialNumber').fill(ext); await expect(pa.locator('#phCall')).toBeEnabled(); await pa.locator('#phCall').click();
    return { ca, cb, pa, pb };
  }
  const reopen = async (p) => { await p.reload(); await expect(async () => { await p.locator('.nav-item[data-view=phone]').click(); await expect(p.locator('#phTab-dial')).toBeVisible({ timeout: 3000 }); }).toPass({ timeout: 30000 }); await ready(p); };
  const bothConnected = async (pa, pb) => { for (const p of [pa, pb]) await expect(p.locator('#vbStatus')).toContainText('Connected', { timeout: 60000 }); };

  test('RECOVERY: the callee reloads while the phone is RINGING -> the invitation comes back from the server, the call is answered and connects, and nothing ended it', async ({ browser }) => {
    test.setTimeout(240000);
    const { pa, pb } = await dialOnly(browser); await expect(pb.locator('#voiceIncoming')).toBeVisible({ timeout: 30000 });
    await reopen(pb); await expect(pb.locator('#voiceIncoming')).toBeVisible({ timeout: 30000 }); await pb.locator('#viAnswer').click(); await bothConnected(pa, pb);
    const c = await lastCall(); expect(c.status).toBe('active'); await neverEnded(c.id, 'callee reload while ringing');
  });

  test('RECOVERY: the CALLER reloads while the phone is ringing -> the call is still ringing on the server, the callee answers, and BOTH sides connect', async ({ browser }) => {
    test.setTimeout(240000);
    const { pa, pb } = await dialOnly(browser); await expect(pb.locator('#voiceIncoming')).toBeVisible({ timeout: 30000 });
    await reopen(pa); await pb.locator('#viAnswer').click(); await bothConnected(pa, pb);
    const c = await lastCall(); expect(c.status).toBe('active'); await neverEnded(c.id, 'caller reload while ringing');
  });

  test('RECOVERY: a reload of either side of a CONNECTED call (one after the other) never ends the call: the server records no end event and both sides connect again', async ({ browser }) => {
    test.setTimeout(240000);
    const { pa, pb } = await connect(browser), callId = await pa.evaluate(() => window.qorllaVoice.callId);
    await reopen(pb); await bothConnected(pa, pb); await reopen(pa); await bothConnected(pa, pb);
    expect((await lastCall()).status).toBe('active'); await neverEnded(callId, 'connected-call reloads');
  });

  test('RECOVERY (invitation): the guest reloads while the MOVE INVITATION is pending -> the host offers it again from the server state, the guest sees it and accepts', async ({ browser }) => {
    test.setTimeout(240000);
    const { pa, pb } = await connect(browser), callId = await pa.evaluate(() => window.qorllaVoice.callId);
    await pa.locator('#stMove').click(); await expect(pb.locator('#voiceAsk')).toBeVisible({ timeout: 30000 });
    await reopen(pb); await bothConnected(pa, pb);                                                 // B's page is new: the first invitation is gone with it
    await expect(pb.locator('#voiceAsk')).toBeVisible({ timeout: 60000 }); await pb.locator('#vaskYes').click();
    await expect(pa.locator('#vmbOpen')).toBeVisible({ timeout: 30000 }); await expect(pb.locator('#vmbOpen')).toBeVisible({ timeout: 30000 });
    await neverEnded(callId, 'reload during the pending invitation');
  });

  test('RECOVERY (acceptance): the guest reloads right after ACCEPTING -> the accepted hand-off is resumed from the server, the call is untouched', async ({ browser }) => {
    test.setTimeout(240000);
    const { pa, pb } = await connect(browser), callId = await pa.evaluate(() => window.qorllaVoice.callId); await agree(pa, pb);
    await reopen(pb); await expect(pb.locator('#voiceMoveBar')).toBeVisible({ timeout: 60000 }); await expect(pb.locator('#vmbText')).toContainText('still in progress');
    expect((await pool.query("SELECT status FROM voice_handoffs WHERE call_id=$1", [callId])).rows[0].status).toBe('accepted'); await neverEnded(callId, 'reload after accepting');
  });

  test('RECOVERY (Meet admission): the HOST reloads its phone page after entering Meet and before the guest has joined -> the hand-off continues and completes once the guest joins', async ({ browser }) => {
    test.setTimeout(300000);
    const { pa, pb } = await connect(browser), callId = await pa.evaluate(() => window.qorllaVoice.callId); await agree(pa, pb);
    const ma = await openMeet(pa); await reopen(pa); await expect(pa.locator('#voiceMoveBar')).toBeVisible({ timeout: 60000 });
    expect((await lastCall()).status, 'the call is up while only the host is in Meet').toBe('active');
    const mb = await openMeet(pb); await expect.poll(() => inboundAudio(ma), { timeout: 90000 }).toBeGreaterThan(1000); await expect.poll(() => inboundAudio(mb), { timeout: 90000 }).toBeGreaterThan(1000);
    await expect.poll(async () => (await lastCall()).status, { timeout: 120000 }).toBe('ended'); expect((await lastCall()).end_reason).toBe('moved_to_meeting'); expect((await kinds(callId)).filter((x) => x === 'ended').length, 'ended exactly once').toBe(1);
  });

  test('RECOVERY (media): BOTH phone pages reload while audio is flowing in Meet -> the hand-off still completes, exactly once', async ({ browser }) => {
    test.setTimeout(300000);
    const { pa, pb } = await connect(browser), callId = await pa.evaluate(() => window.qorllaVoice.callId); await agree(pa, pb);
    const ma = await openMeet(pa), mb = await openMeet(pb); await expect.poll(() => inboundAudio(ma), { timeout: 90000 }).toBeGreaterThan(1000);
    await Promise.all([reopen(pa), reopen(pb)]);
    await expect.poll(async () => (await lastCall()).status, { timeout: 150000 }).toBe('ended'); expect((await lastCall()).end_reason).toBe('moved_to_meeting'); expect((await kinds(callId)).filter((x) => x === 'ended').length, 'ended exactly once').toBe(1); void mb;
  });

  test('NETWORK DISCONNECT / RECONNECT (the page stays open, only the network drops): the call is NOT ended by the server, and both sides are Connected again afterwards', async ({ browser }) => {
    test.setTimeout(240000);
    const { ca, cb, pa, pb } = await connect(browser), callId = await pa.evaluate(() => window.qorllaVoice.callId); void ca;
    await cb.setOffline(true); await pb.waitForTimeout(8000); expect((await lastCall()).status, 'the server keeps the call while a device is merely offline').toBe('active'); await cb.setOffline(false);
    await bothConnected(pa, pb); await expect.poll(() => pb.evaluate(() => !!(window.qorllaVoice.ws && window.qorllaVoice.ws.readyState === 1)), { timeout: 60000 }).toBe(true);
    expect((await lastCall()).status).toBe('active'); await neverEnded(callId, 'network drop and return');
  });

  test('BROWSER PROCESS CRASH (a different failure from a dropped network): the server does not end the call at once; the call lives on until the device lease runs out', async ({ playwright }) => {
    test.setTimeout(300000);
    const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], server = await playwright.chromium.launchServer({ args }), doomed = await playwright.chromium.connect(server.wsEndpoint()), good = await playwright.chromium.launch({ args });
    try {
      const ca = await account(good, 'Ann'), cb = await account(doomed, 'Ben'), pa = await openPhone(ca), pb = await openPhone(cb); await ready(pa); await ready(pb); const ext = await extOf(pb);
      await expect.poll(() => pa.evaluate(async (e) => { const d = await (await fetch('/api/voice/directory', { credentials: 'same-origin' })).json(); return (d.people || []).some((p) => p.extension === e && !p.self); }, ext), { timeout: 30000 }).toBe(true);
      await pa.locator('#qpDialNumber').fill(ext); await pa.locator('#phCall').click(); await expect(pb.locator('#voiceIncoming')).toBeVisible({ timeout: 30000 }); await pb.locator('#viAnswer').click(); await bothConnected(pa, pb);
      const callId = (await lastCall()).id; process.kill(server.process().pid, 'SIGKILL');                    // the whole browser process dies: no unload, no close frames
      await expect.poll(() => pa.evaluate(() => window.qorllaVoice.pc && window.qorllaVoice.pc.connectionState), { timeout: 60000 }).not.toBe('connected');   // A notices the media stopped
      expect((await lastCall()).status, 'the server did not end the call just because the browser vanished').toBe('active'); await neverEnded(callId, 'right after the crash');
    } finally { await good.close().catch(() => {}); await doomed.close().catch(() => {}); await server.close().catch(() => {}); }
  });

  // ---------------------------------------------------------------- Meet outage (v2.3): Meet goes away in the middle of a hand-off; the phone call must not
  const OS = require('node:os'), CP = require('node:child_process');
  const meetUp = async () => { try { const r = await fetch('http://127.0.0.1:3310/api/config', { signal: AbortSignal.timeout(1500) }); return r.ok; } catch (e) { return false; } };
  /** Stops the TEST Meet (the process the helper script started; its pid is in the temp folder). Production services are never touched. */
  async function stopMeet() {
    const pid = Number(fs.readFileSync(path.join(OS.tmpdir(), 'meet3310.pid'), 'utf8')); expect(pid, 'the Meet test helper has written its pid').toBeGreaterThan(0); process.kill(pid, 'SIGKILL');
    await expect.poll(meetUp, { timeout: 15000, message: 'Meet is really down' }).toBe(false);
  }
  async function startMeet() { CP.execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'phone-meet-test-meet.cjs')], { env: process.env, stdio: 'ignore' }); await expect.poll(meetUp, { timeout: 90000, message: 'Meet is reachable again' }).toBe(true); }
  /** No page of this session is on the built-in room, and none is a stray blank window. */
  /** After the failure the start/join dialog is still open with everything the person typed: pressing its button again IS the retry. Returns the Meet window. */
  async function retryInDialog(page) {
    const pop = page.context().waitForEvent('page', { timeout: 60000 }); await expect(page.locator('#sdGo')).toBeEnabled(); await page.locator('#sdGo').click();
    const meet = await pop; { const tag = 'M' + (PAGES.MA ? 'B' : 'A'); PAGES[tag] = meet; watch(meet, tag, LOG, T0); } await meet.waitForURL(/localhost:3310/, { timeout: 60000 }); return meet;
  }
  const noBuiltinRoom = (ctxs) => { for (const c of ctxs) for (const pg of c.pages()) { const u = pg.url(); expect(u, 'no page was sent to the built-in room').not.toMatch(/start=join|\/room|\/guest\/(room|welcome)/); expect(u, 'no stray blank window').not.toBe('about:blank'); } };
  const callAlive = async (pa, pb, callId, what) => { const c = await lastCall(); expect(c.id).toBe(callId); expect(c.status, what + ': the call is still up on the server').toBe('active'); await neverEnded(callId, what); void pa; void pb; };

  test('MEET OUTAGE (before anyone is in Meet): Open meeting while Meet is down -> a clear retry message, no built-in room, the phone call stays up on both sides; after Meet returns the hand-off completes', async ({ browser }) => {
    test.setTimeout(480000);
    const { ca, cb, pa, pb } = await connect(browser), callId = await pa.evaluate(() => window.qorllaVoice.callId); await agree(pa, pb);
    await stopMeet();
    try {
      await pa.locator('#vmbOpen').click(); await expect(pa.locator('#startDialog')).toBeVisible({ timeout: 15000 }); await expect(pa.locator('#sdGo')).toBeEnabled({ timeout: 20000 }); await pa.locator('#sdGo').click();
      await expect(pa.locator('#sdErr')).toContainText(/Qorlla Meet.*(reach|available)|try again/i, { timeout: 40000 });
      await expect(pa.locator('#sdGo')).toBeEnabled(); expect(await pa.locator('#sdGo').textContent()).toMatch(/Retry/i);        // the dialog keeps everything and offers a retry
      expect(pa.url(), 'the host page is still the Portal (it was not navigated away, which would drop the call)').toContain('/qorlla.html'); noBuiltinRoom([ca, cb]);
      await callAlive(pa, pb, callId, 'Meet is down'); await bothConnected(pa, pb);
      expect(await pa.evaluate(() => !!(window.qorllaVoice.pc && window.qorllaVoice.pc.connectionState === 'connected')), 'the phone media of A is still connected').toBe(true);
      expect(await pb.evaluate(() => !!(window.qorllaVoice.pc && window.qorllaVoice.pc.connectionState === 'connected')), 'the phone media of B is still connected').toBe(true);
      await expect(pb.locator('#voiceMoveBar')).toBeVisible();                                                              // B still has the recoverable hand-off bar
    } finally { if (!(await meetUp())) await startMeet(); }
    // Meet is back: the same pages finish the hand-off, no new dial, no new invitation
    const ma = await retryInDialog(pa), mb = await openMeet(pb);
    await expect.poll(() => inboundAudio(ma), { timeout: 90000 }).toBeGreaterThan(1000); await expect.poll(() => inboundAudio(mb), { timeout: 90000 }).toBeGreaterThan(1000);
    await expect.poll(async () => (await lastCall()).status, { timeout: 150000 }).toBe('ended'); expect((await lastCall()).end_reason).toBe('moved_to_meeting'); expect((await kinds(callId)).filter((x) => x === 'ended').length, 'ended exactly once').toBe(1);
  });

  test('MEET OUTAGE (a meeting that already lives in Meet): the host is in Meet, Meet goes down, the guest tries to join -> retry message, never the built-in room, the call lives, and after Meet returns both are in the SAME Meet room and the call ends once', async ({ browser }) => {
    test.setTimeout(540000);
    const { ca, cb, pa, pb } = await connect(browser), callId = await pa.evaluate(() => window.qorllaVoice.callId); await agree(pa, pb);
    const ma = await openMeet(pa);                                                                                    // the meeting now exists in Meet and the main app knows it (viaMeet)
    await expect.poll(async () => (await pool.query('SELECT init_session FROM voice_handoffs WHERE call_id=$1', [callId])).rows[0].init_session, { timeout: 90000, message: 'the host is really inside the Meet room (the server has its first media report) before Meet goes down' }).not.toBeNull();
    await stopMeet();
    try {
      await pb.locator('#vmbOpen').click(); await expect(pb.locator('#startDialog')).toBeVisible({ timeout: 15000 }); await expect(pb.locator('#sdGo')).toBeEnabled({ timeout: 20000 }); await pb.locator('#sdGo').click();
      await expect(pb.locator('#sdErr')).toContainText(/Qorlla Meet.*(reach|available)|try again/i, { timeout: 40000 });
      await expect(pb.locator('#sdGo')).toBeEnabled(); expect(pb.url()).toContain('/qorlla.html'); noBuiltinRoom([ca, cb]);
      await callAlive(pa, pb, callId, 'Meet is down for an existing Meet meeting'); await bothConnected(pa, pb);
      expect((await pool.query("SELECT status FROM voice_handoffs WHERE call_id=$1", [callId])).rows[0].status, 'the hand-off record survives the outage').toBe('accepted');
    } finally { if (!(await meetUp())) await startMeet(); }
    const mb = await retryInDialog(pb);                                                                              // the retry is the dialog's own button
    await expect.poll(() => inboundAudio(mb), { timeout: 120000 }).toBeGreaterThan(1000); await expect.poll(() => inboundAudio(ma), { timeout: 120000 }).toBeGreaterThan(1000);
    await expect.poll(async () => (await lastCall()).status, { timeout: 180000 }).toBe('ended'); expect((await lastCall()).end_reason).toBe('moved_to_meeting'); expect((await kinds(callId)).filter((x) => x === 'ended').length, 'ended exactly once').toBe(1);
  });
});
