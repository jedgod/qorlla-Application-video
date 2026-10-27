const { test, expect } = require('@playwright/test');
const { BASE } = require('./helpers');

// Qorlla Meet v4.0.1 / Gate G1: connection and media reliability, with two REAL browser clients (Chromium fake camera/microphone devices).
// Through the unified origin: /meet/. Local Meet: E2E_BASE=http://localhost:3310 E2E_MEET_PATH=/.
// NOT covered here: TURN relay fallback (needs the coturn service and a restricted network) - reported BLOCKED, not passed.
const MEET = process.env.E2E_MEET_PATH || '/meet/';

async function open(browser, who, code) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE, permissions: ['camera', 'microphone'], viewport: { width: 1366, height: 768 } }); const page = await ctx.newPage(); page.on('dialog', (d) => d.accept());
  await page.goto(MEET); await page.fill('#displayName', who);
  if (code) { await page.fill('#meetingId', code); await page.click('#joinBtn'); } else { await page.fill('#meetingTitle', 'Connection check'); await page.click('#createBtn'); }
  await page.waitForSelector('#app:not(.hidden)'); await expect(page.locator('#liveBadge')).toHaveAttribute('data-state', 'live');
  const out = { ctx, page }; if (!code) out.code = (await page.locator('#roomId').textContent()).trim(); return out;
}
// frames decoded by the remote tile's <video> and inbound RTP packets, per media kind, from the real peer connection
const frames = (page) => page.evaluate(() => { const v = document.querySelector('.tile:not([id="tile-' + __qorlla.state.participantId + '"]) video'); return v ? v.getVideoPlaybackQuality().totalVideoFrames : 0; });
const inbound = (page) => page.evaluate(async () => { const out = { audio: 0, video: 0 }; for (const pc of __qorlla.state.peers.values()) for (const r of (await pc.getStats()).values()) if (r.type === 'inbound-rtp') out[r.kind] += r.packetsReceived || 0; return out; });
const advancing = async (page, what) => { const f0 = await frames(page); await expect.poll(() => frames(page), { timeout: 15000, message: what }).toBeGreaterThan(f0 + 2); };
const watchBadge = (page) => page.evaluate(() => { window.__seen = []; new MutationObserver(() => window.__seen.push(document.getElementById('liveBadge').dataset.state)).observe(document.getElementById('liveBadge'), { attributes: true, attributeFilter: ['data-state'] }); });

test.describe('Qorlla Meet G1 connection reliability', () => {
  test('G1-01/02: two real browsers exchange audio and video; mute and camera-off act on the real tracks', async ({ browser }) => {
    test.setTimeout(90000);
    const a = await open(browser, 'Alice'); const b = await open(browser, 'Bob', a.code);
    for (const p of [a, b]) { await expect(p.page.locator('.tile')).toHaveCount(2); await advancing(p.page, 'remote video decodes'); await expect.poll(async () => (await inbound(p.page)).audio, { timeout: 15000 }).toBeGreaterThan(5); await expect.poll(async () => (await inbound(p.page)).video).toBeGreaterThan(5); }
    await a.page.click('#micBtn'); await a.page.click('#camBtn');
    const tr = await a.page.evaluate(() => ({ a: __qorlla.state.stream.getAudioTracks().map((t) => t.enabled), v: __qorlla.state.stream.getVideoTracks().map((t) => t.enabled), sent: [...__qorlla.state.peers.values()].flatMap((pc) => pc.getSenders().map((s) => [s.track.kind, s.track.enabled])) }));
    expect(tr.a).toEqual([false]); expect(tr.v).toEqual([false]); expect(tr.sent.every(([, en]) => en === false)).toBe(true);                           // the tracks being SENT are disabled, not just the buttons
    await a.page.click('#micBtn'); await a.page.click('#camBtn'); expect(await a.page.evaluate(() => __qorlla.state.stream.getTracks().every((t) => t.enabled))).toBe(true);
    await a.ctx.close(); await b.ctx.close();
  });

  test('G1-03/04/07: a lost connection is shown as lost (never Live), recovers on its own, media resumes, no duplicate participants', async ({ browser }) => {
    test.setTimeout(120000);
    const a = await open(browser, 'Alice'); const b = await open(browser, 'Bob', a.code); await advancing(a.page, 'before'); await advancing(b.page, 'before');
    // 1) signalling cut and automatic reconnection disabled: must read Disconnected, not Live
    await b.page.evaluate(() => { __qorlla.state.socket.io.reconnection(false); __qorlla.state.socket.io.engine.close(); });
    await expect(b.page.locator('#liveBadge')).toHaveAttribute('data-state', 'offline'); await expect(b.page.locator('#liveText')).toHaveText('Disconnected'); await expect(b.page.locator('#status')).not.toContainText('Connected');
    // 2) the network "comes back": reconnect, the badge returns to Live, media flows again and nobody is duplicated
    await b.page.evaluate(() => { __qorlla.state.socket.io.reconnection(true); __qorlla.state.socket.connect(); });
    await expect(b.page.locator('#liveBadge')).toHaveAttribute('data-state', 'live', { timeout: 30000 });
    for (const p of [a, b]) { await expect(p.page.locator('.tile')).toHaveCount(2); await advancing(p.page, 'media after reconnect'); }
    expect(await a.page.evaluate(() => [...__qorlla.state.roster].length)).toBe(2); expect(await b.page.evaluate(() => [...__qorlla.state.roster].length)).toBe(2);
    // 3) a dropped transport with automatic reconnection: shows Reconnecting while down, recovers by itself
    await watchBadge(a.page); await a.page.evaluate(() => __qorlla.state.socket.io.engine.close());
    await expect(a.page.locator('#liveBadge')).toHaveAttribute('data-state', 'live', { timeout: 30000 });
    expect(await a.page.evaluate(() => window.__seen)).toContain('reconnecting');
    for (const p of [a, b]) { await expect(p.page.locator('.tile')).toHaveCount(2); await advancing(p.page, 'media after auto reconnect'); }
    await a.ctx.close(); await b.ctx.close();
  });

  test('G1-05 (ICE restart path only): a peer connection that is told to recover restarts ICE and keeps media flowing', async ({ browser }) => {
    test.setTimeout(90000);
    const a = await open(browser, 'Alice'); const b = await open(browser, 'Bob', a.code); await advancing(b.page, 'before');
    const ufrag = () => b.page.evaluate(() => [...__qorlla.state.peers.values()][0].remoteDescription.sdp.match(/a=ice-ufrag:(\S+)/)[1]);
    const before = await ufrag();
    await b.page.evaluate(() => { const [id, pc] = [...__qorlla.state.peers.entries()][0]; __qorlla.recoverPeer(id, pc); });                                                  // what a 'failed' ICE state triggers
    await expect.poll(ufrag, { timeout: 15000 }).not.toBe(before);                                                                                        // new ICE credentials were negotiated
    await expect.poll(() => b.page.evaluate(() => [...__qorlla.state.peers.values()][0].connectionState)).toBe('connected'); await advancing(b.page, 'after ICE restart'); await advancing(a.page, 'after ICE restart');
    await a.ctx.close(); await b.ctx.close();
  });

  test('G1-06: leaving or ending the meeting closes the peer connections, signalling and local devices', async ({ browser }) => {
    test.setTimeout(90000);
    const a = await open(browser, 'Alice'); const b = await open(browser, 'Bob', a.code); await advancing(b.page, 'before');
    await a.page.click('#leaveBtn'); await expect(b.page.locator('.tile')).toHaveCount(1); expect(await b.page.evaluate(() => __qorlla.state.peers.size)).toBe(0);
    const h = await open(browser, 'Hanna'); const g = await open(browser, 'Gus', h.code);
    await g.page.evaluate(() => { addEventListener('pagehide', () => sessionStorage.setItem('__closed', JSON.stringify({ ended: __qorlla.state.stream.getTracks().every((t) => t.readyState === 'ended'), peers: __qorlla.state.peers.size, connected: __qorlla.state.socket.connected }))); });
    await h.page.click('#endBtn'); await h.page.locator('#rcModal').getByRole('button', { name: 'End for all' }).click();
    await expect(g.page.locator('#landing')).toBeVisible({ timeout: 15000 });
    expect(JSON.parse(await g.page.evaluate(() => sessionStorage.getItem('__closed')))).toEqual({ ended: true, peers: 0, connected: false });
    for (const p of [a, b, h, g]) await p.ctx.close().catch(() => {});
  });

  test('launch parameters (name, passcode) are removed from the address bar once used', async ({ browser }) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE, permissions: ['camera', 'microphone'] }); const page = await ctx.newPage();
    await page.goto(MEET + '?start=new&name=Zed&mic=true&camera=true&passcode=hunter2hunter2'); await page.waitForSelector('#app:not(.hidden)');
    expect(page.url()).not.toMatch(/passcode|hunter2|name=Zed|start=new/); await ctx.close();
  });
});
