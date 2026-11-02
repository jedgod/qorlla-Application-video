const { test, expect } = require('@playwright/test');
const { BASE } = require('./helpers');

test.describe('Meet through the single HTTPS origin (/meet/)', () => {
  test('Meet UI loads under /meet/, redirects /meet, and its assets and API are prefix-aware', async ({ page, request }) => {
    const r = await request.get('/meet', { maxRedirects: 0 }); expect(r.status()).toBe(301); expect(r.headers().location).toMatch(/\/meet\/$/);
    await page.goto('/meet/'); await expect(page.locator('#displayName')).toBeVisible();
    expect((await request.get('/meet/app.js')).status()).toBe(200); expect((await request.get('/meet/api/health')).status()).toBe(200);
    expect((await request.get('/meet/socket.io/socket.io.js')).status()).toBe(200);
  });

  test('internal bridge, recovery and readiness endpoints are not reachable even with the right secret header', async ({ request }) => {
    for (const [m, p] of [['GET', '/meet/api/integrations/scheduled-meetings/x'], ['POST', '/meet/api/integrations/scheduled-meetings'], ['POST', '/meet/api/integrations/scheduled-meetings/x/recover-host'], ['POST', '/meet/api/integrations/scheduled-meetings/x/ack-host'], ['GET', '/meet/api/ready'], ['GET', '/api/auth/internal/session/' + 'a'.repeat(64)]]) {
      const r = await request.fetch(p, { method: m, headers: { 'x-qorlla-bridge-secret': 'x'.repeat(40), authorization: 'Bearer ' + 'x'.repeat(40) }, data: m === 'POST' ? {} : undefined });
      expect(r.status(), `${m} ${p}`).toBe(404);
    }
  });

  test('two browsers meet under /meet/: websocket upgrade on the prefixed path, chat both ways, passcode, refresh and rejoin', async ({ browser }) => {
    const mk = async () => { const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE, permissions: ['camera', 'microphone'] }); return { ctx, page: await ctx.newPage() }; };
    const a = await mk(), b = await mk(); const sockets = [];
    for (const p of [a.page, b.page]) p.on('websocket', (ws) => sockets.push(ws.url()));
    await a.page.goto('/meet/'); await a.page.fill('#displayName', 'Alice'); await a.page.fill('#meetingTitle', 'Prefixed'); await a.page.fill('#newPasscode', 'prefixed-pass-1'); await a.page.click('#createBtn');
    await a.page.waitForSelector('#app:not(.hidden)'); await expect(a.page.locator('#status')).toContainText('Connected');
    const code = (await a.page.textContent('#roomId')).trim(); expect(code).toMatch(/^\d{12}$/);
    await b.page.goto('/meet/'); await b.page.fill('#displayName', 'Bob'); await b.page.fill('#meetingId', code); await b.page.fill('#joinPasscode', 'wrong-pass'); await b.page.click('#joinBtn');
    await expect(b.page.locator('#landingError')).toContainText(/passcode/i);
    await b.page.fill('#joinPasscode', 'prefixed-pass-1'); await b.page.click('#joinBtn'); await b.page.waitForSelector('#app:not(.hidden)'); await expect(b.page.locator('#status')).toContainText('Connected');
    expect(sockets.some((u) => /wss:\/\/[^/]+\/meet\/socket\.io\//.test(u))).toBe(true);
    await a.page.fill('#chatText', 'hello under /meet'); await a.page.press('#chatText', 'Enter'); await expect(b.page.locator('#messages')).toContainText('hello under /meet');
    await b.page.fill('#chatText', 'reply'); await b.page.press('#chatText', 'Enter'); await expect(a.page.locator('#messages')).toContainText('reply');
    await b.page.reload(); await b.page.waitForSelector('#app:not(.hidden)'); await expect(b.page.locator('#messages')).toContainText('hello under /meet');   // rejoin restores history
    await expect.poll(async () => b.page.evaluate(() => [...document.querySelectorAll('.tile video')].filter((v) => v.srcObject && v.videoWidth > 0).length), { timeout: 40000 }).toBeGreaterThanOrEqual(2);
    await a.ctx.close(); await b.ctx.close();
  });
});
