const { test, expect } = require('@playwright/test');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const { PASSWORD } = require('./support/meet-stack');
const { startVoiceStack } = require('./support/voice-stack');

// Qorlla Voice over a REAL self-hosted TURN relay: our own coturn container, short-lived REST credentials issued by the engine, and the browsers forced to relay-only (iceTransportPolicy 'relay'),
// so the call can ONLY work if media really goes through the relay. Single machine (the relay sits in Docker on loopback): this proves the TURN configuration, credentials and relay path, not a
// call between two different real networks.
const MAIN_PORT = 5283, VOICE_PORT = 5282, NET = 'qorlla-voice-test-net', NAME = 'qorlla-voice-test-coturn', IP = '172.29.77.10', SECRET = 't'.repeat(40), TURN_PORT = 34781;
const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8' });
// Chromium gathers per network interface once the microphone is allowed, and a TURN server on loopback is not reachable that way (a real deployment uses a routable address), so the relay is published on this machine's LAN address.
const LAN = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))?.address;

test.describe('Qorlla Voice through a real TURN relay', () => {
  let stack, ok = false;
  test.beforeAll(async () => {
    if (!LAN || docker('image', 'inspect', 'coturn/coturn:latest').status !== 0) return;
    docker('rm', '-f', NAME); docker('network', 'rm', NET); if (docker('network', 'create', '--subnet', '172.29.77.0/24', NET).status !== 0) return;
    const run = docker('run', '-d', '--name', NAME, '--network', NET, '--ip', IP, '-p', `${LAN}:${TURN_PORT}:3478/udp`, '-p', `${LAN}:${TURN_PORT}:3478/tcp`, '-p', `${LAN}:47200-47230:47200-47230/udp`, 'coturn/coturn:latest',
      '-n', '-v', '--log-file=stdout', '--realm=qorlla.test', '--use-auth-secret', `--static-auth-secret=${SECRET}`, '--listening-port=3478', `--listening-ip=${IP}`, `--relay-ip=${IP}`, `--external-ip=${LAN}/${IP}`,
      '--min-port=47200', '--max-port=47230', '--no-tls', '--no-dtls', '--allow-loopback-peers', '--fingerprint', '--no-software-attribute');
    if (run.status !== 0) return;
    await new Promise((r) => setTimeout(r, 2500)); ok = true;
    stack = await startVoiceStack({ mainPort: MAIN_PORT, voicePort: VOICE_PORT, engineEnv: { TURN_URLS: `turn:${LAN}:${TURN_PORT}?transport=udp`, TURN_SHARED_SECRET: SECRET, VOICE_RELAY_ONLY: 'true', VOICE_REQUIRE_TURN: 'true', VOICE_RING_SECONDS: '30' } });
  });
  test.afterAll(async () => { if (stack) await stack.stop(); if (!process.env.KEEP_TURN) { docker('rm', '-f', NAME); docker('network', 'rm', NET); } });

  const rand = () => Math.random().toString(36).slice(2, 7);
  async function person(browser, name) {
    const ctx = await browser.newContext({ permissions: ['microphone'] }), u = name.toLowerCase() + rand();
    expect((await ctx.request.post(stack.base + '/api/auth/register', { data: { username: u, displayName: name + ' Test', password: PASSWORD } })).status()).toBe(201);
    const page = await ctx.newPage(); await page.goto(stack.base + '/qorlla.html#home'); await expect(async () => { await page.locator('.nav-item[data-view=phone]').click(); await expect(page.locator('#phTab-dial')).toBeVisible({ timeout: 3000 }); }).toPass({ timeout: 30000 });
    await expect.poll(() => page.evaluate(() => !!(window.qorllaVoice && window.qorllaVoice.ws && window.qorllaVoice.ws.readyState === 1)), { timeout: 20000 }).toBe(true);
    await expect(page.locator('#qpMyExt')).toContainText('Your Qorlla extension'); return { ctx, page, ext: (await page.locator('#qpMyExt').textContent()).match(/extension: (\d+)/)[1] };
  }

  test('relay-only: both browsers use TURN relay candidates and audio flows both ways; the credentials are short-lived and per account', async ({ browser }) => {
    test.skip(!ok, 'docker or the coturn image is not available');
    test.setTimeout(150000);
    const alice = await person(browser, 'Alice'), bob = await person(browser, 'Bob');
    const ice = await alice.page.evaluate(() => window.qorllaVoice.api('/ice')); expect(ice.iceTransportPolicy).toBe('relay');
    const turn = ice.iceServers.find((s) => [].concat(s.urls).some((u) => u.startsWith('turn:'))); expect(turn.username).toMatch(/^\d+:/); expect(Number(turn.username.split(':')[0]) - Date.now() / 1000).toBeLessThan(700); expect(turn.credential).toBeTruthy();
    expect(JSON.stringify(ice)).not.toContain(SECRET);                                                                                               // the shared secret never reaches a browser
    await alice.page.locator('#qpDialNumber').fill(bob.ext); await alice.page.locator('#phCall').click(); await expect(bob.page.locator('#voiceIncoming')).toBeVisible({ timeout: 10000 }); await bob.page.locator('#viAnswer').click();
    for (const p of [alice, bob]) await expect(p.page.locator('#vbStatus')).toContainText('Connected', { timeout: 40000 });
    for (const [label, p] of [['alice', alice], ['bob', bob]]) {
      await expect.poll(async () => { const s = await p.page.evaluate(() => window.qorllaVoice.stats()); return s && s.bytesReceived > 3000 && s.bytesSent > 3000 ? s.candidateType : JSON.stringify(s); }, { timeout: 30000, intervals: [700], message: label }).toBe('relay');
    }
    await alice.page.locator('#vbEnd').click(); await expect(bob.page.locator('#voiceBar')).toBeHidden({ timeout: 15000 }); await alice.ctx.close(); await bob.ctx.close();
  });
});
