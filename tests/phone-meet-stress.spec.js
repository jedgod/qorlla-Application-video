const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { PASSWORD } = require('./support/meet-stack');
const { startVoiceStack } = require('./support/voice-stack');

// Reliability harness for the Phone call set-up path that the hand-off tests depend on: dial -> ring -> answer -> Connected on BOTH sides, repeated many times with brand-new accounts and
// pages. On any failure it writes a full diagnosis (both pages' console and failed requests, the voice WebSocket frames, the client's own state, the call rows and events in PostgreSQL,
// the engine log) to PM_DIAG_DIR so the failure can be understood instead of retried. Optional steps (PM_STRESS_REFRESH=ringing|connected) refresh a page mid set-up.
const MAIN = 5353, VOICE = 5354, N = Number(process.env.PM_STRESS_N || 20), DIAG = process.env.PM_DIAG_DIR || path.join(__dirname, '..', 'test-results', 'diag');
test.describe('Phone call set-up reliability', () => {
  test.describe.configure({ mode: 'serial' });
  let stack, pool;
  test.beforeAll(async () => { test.setTimeout(150000); stack = await startVoiceStack({ mainPort: MAIN, voicePort: VOICE }); pool = new Pool({ connectionString: process.env.QORLLA_TEST_VOICE_DB, options: '-c search_path=' + stack.schema }); fs.mkdirSync(DIAG, { recursive: true }); });
  test.afterAll(async () => { if (pool) await pool.end(); if (stack) await stack.stop(); });
  const rand = () => Math.random().toString(36).slice(2, 7);

  function watch(page, tag, log) {
    page.on('console', (m) => { if (!/DevTools|Failed to load resource: net::ERR_CONNECTION_REFUSED/.test(m.text())) log.push([Date.now(), tag, 'console.' + m.type(), m.text().slice(0, 240)]); });
    page.on('pageerror', (e) => log.push([Date.now(), tag, 'pageerror', String(e).slice(0, 300)]));
    page.on('requestfailed', (r) => log.push([Date.now(), tag, 'requestfailed', r.method() + ' ' + r.url().replace(/^https?:\/\/[^/]+/, '') + ' ' + (r.failure() || {}).errorText]));
    page.on('response', (r) => { if (r.status() >= 400 && !/\/socket\.io\//.test(r.url())) log.push([Date.now(), tag, 'http.' + r.status(), r.request().method() + ' ' + r.url().replace(/^https?:\/\/[^/]+/, '')]); });
    page.on('websocket', (ws) => { if (!/\/v1\/voice\/ws/.test(ws.url())) return; log.push([Date.now(), tag, 'ws.open', '']); ws.on('framereceived', (f) => log.push([Date.now(), tag, 'ws.recv', String(f.payload).slice(0, 160)])); ws.on('framesent', (f) => log.push([Date.now(), tag, 'ws.sent', String(f.payload).slice(0, 160)])); ws.on('close', () => log.push([Date.now(), tag, 'ws.close', ''])); });
  }
  async function account(browser, name) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['microphone', 'camera'] }), u = (name + rand()).toLowerCase();
    expect((await ctx.request.post(stack.base + '/api/auth/register', { data: { username: u, displayName: name + ' Test', password: PASSWORD, email: u + '@example.test' } })).status()).toBeLessThan(300); return ctx;
  }
  async function openPhone(ctx, tag, log) {
    const page = await ctx.newPage(); watch(page, tag, log); await page.goto(stack.base + '/qorlla.html#phone');
    await expect(async () => { await page.locator('.nav-item[data-view=phone]').click(); await expect(page.locator('#phTab-dial')).toBeVisible({ timeout: 3000 }); }).toPass({ timeout: 30000 }); return page;
  }
  const wsReady = (p) => expect.poll(() => p.evaluate(() => !!(window.qorllaVoice && window.qorllaVoice.ws && window.qorllaVoice.ws.readyState === 1)), { timeout: 30000 }).toBe(true);
  const extOf = (p) => p.evaluate(async () => { for (let i = 0; i < 60; i++) { try { const d = await (await fetch('/api/voice/directory', { credentials: 'same-origin' })).json(); const me = (d.people || []).find((x) => x.self); if (me) return me.extension; } catch (e) { /* retry */ } await new Promise((r) => setTimeout(r, 500)); } return ''; });
  const clientState = (p) => p.evaluate(() => { const c = window.qorllaVoice; if (!c) return null; return { ws: c.ws && c.ws.readyState, callId: c.callId, role: c.role, ringing: [...c.ringing], pc: c.pc && c.pc.connectionState, ice: c.pc && c.pc.iceConnectionState, ctl: c.ctl && c.ctl.readyState, pendingOffer: !!c.pendingOffer, cursor: c.log && c.log.cursor, status: (document.getElementById('vbStatus') || {}).textContent, bar: !document.getElementById('voiceBar').classList.contains('hidden'), incoming: document.getElementById('voiceIncoming').open }; }).catch((e) => ({ error: String(e).slice(0, 100) }));

  async function oneRun(browser, i) {
    const log = [], t0 = Date.now(); let pa, pb, where = 'start';
    try {
      const ca = await account(browser, 'Ann'), cb = await account(browser, 'Ben'); where = 'open'; pa = await openPhone(ca, 'A', log); pb = await openPhone(cb, 'B', log);
      where = 'ws-ready'; await wsReady(pa); await wsReady(pb); where = 'directory'; const ext = await extOf(pb);
      await expect.poll(() => pa.evaluate(async (e) => { const d = await (await fetch('/api/voice/directory', { credentials: 'same-origin' })).json(); return (d.people || []).some((p) => p.extension === e && !p.self); }, ext), { timeout: 30000 }).toBe(true);
      where = 'dial'; await pa.locator('#qpDialNumber').fill(ext); await expect(pa.locator('#phCall')).toBeEnabled(); await pa.locator('#phCall').click();
      where = 'ring'; await expect(pb.locator('#voiceIncoming')).toBeVisible({ timeout: 20000 });
      if (process.env.PM_STRESS_REFRESH === 'ringing') { where = 'refresh-ringing'; await pb.reload(); await expect(pb.locator('#voiceIncoming')).toBeVisible({ timeout: 20000 }); }
      where = 'answer'; await pb.locator('#viAnswer').click();
      where = 'connected'; for (const p of [pa, pb]) await expect(p.locator('#vbStatus')).toContainText('Connected', { timeout: 40000 });
      if (process.env.PM_STRESS_REFRESH === 'connected') { where = 'refresh-connected'; await pb.reload(); for (const p of [pa, pb]) await expect(p.locator('#vbStatus')).toContainText('Connected', { timeout: 40000 }); }
      where = 'caps'; await expect.poll(() => pa.evaluate(() => !!(window.qorllaVoice.peerCaps && window.qorllaVoice.peerCaps.move >= 2)), { timeout: 15000 }).toBe(true);
      await pa.locator('#stEnd').click(); await ca.close(); await cb.close(); return { ok: true, ms: Date.now() - t0 };
    } catch (e) {
      const calls = await pool.query("SELECT c.id, c.status, c.end_reason, c.created_at, c.answered_at, c.ended_at FROM voice_calls c ORDER BY c.created_at DESC LIMIT 2").then((r) => r.rows).catch(() => []);
      const events = calls.length ? await pool.query('SELECT kind, actor_id, created_at FROM voice_call_events WHERE call_id=$1 ORDER BY created_at', [calls[0].id]).then((r) => r.rows).catch(() => []) : [];
      const diag = { run: i, failedAt: where, error: String(e && e.message).split('\n')[0], ms: Date.now() - t0, stateA: pa ? await clientState(pa) : null, stateB: pb ? await clientState(pb) : null, calls, events, log: log.map(([t, ...r]) => [t - t0, ...r]), engine: stack.log.join('').slice(-1500) };
      fs.writeFileSync(path.join(DIAG, 'diag-' + String(i).padStart(3, '0') + '.json'), JSON.stringify(diag, null, 2)); return { ok: false, where, ms: Date.now() - t0 };
    } finally { for (const p of [pa, pb]) { try { await p.context().close(); } catch (e) { /* closed */ } } }
  }

  test('N consecutive call set-ups (dial, ring, answer, Connected on both sides) with no failure', async ({ browser }) => {
    test.setTimeout(N * 90000 + 60000); const res = [];
    for (let i = 1; i <= N; i++) { const r = await oneRun(browser, i); res.push(r); console.log(`[stress] run ${i}/${N}: ${r.ok ? 'ok' : 'FAILED at ' + r.where} (${r.ms} ms)`); }
    const bad = res.filter((r) => !r.ok); console.log(`[stress] ${res.length - bad.length}/${res.length} ok; failures at: ${bad.map((b) => b.where).join(', ') || 'none'}`);
    expect(bad.length, 'failed set-ups (see ' + DIAG + ')').toBe(0);
  });
});
