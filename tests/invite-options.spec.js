const { test, expect } = require('@playwright/test');
const choice = require('../assets/app-choice.js');

// A person who follows a meeting link can join as a guest straight away, and is offered the way into Qorlla that suits the device: the app where one exists, otherwise an account.
const UA = {
  android: 'Mozilla/5.0 (Linux; Android 13; SM-A037U) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  macos: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17 Mobile/15E148 Safari/604.1',
  desktopApp: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Qorlla/0.2.0 Chrome/130 Electron/33.4.11 Safari/537.36',
  mobileApp: 'Mozilla/5.0 (Linux; Android 13; SM-A037U) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 QorllaMobile/1'
};
const ID = '85898333712';
test('detection picks the device kind, and the plan recommends the app only where one exists', () => {
  for (const [k, want] of [['android', 'android'], ['windows', 'windows'], ['macos', 'macos'], ['linux', 'linux'], ['ios', 'ios'], ['desktopApp', 'in-app'], ['mobileApp', 'in-app']]) expect(choice.detect(UA[k], '', 0)).toBe(want);
  expect(choice.detect('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', 'MacIntel', 5)).toBe('ios');      // iPadOS pretends to be a Mac
  const links = { android: 'https://example.com/q.apk', windows: 'https://example.com/q.exe' };
  expect(choice.plan('android', links, ID)).toMatchObject({ recommended: 'app', app: { href: 'qorlla://join?meeting=' + ID, flavour: 'Android' }, download: { href: 'https://example.com/q.apk' } });
  expect(choice.plan('windows', {}, ID)).toMatchObject({ recommended: 'app', download: null });                       // no download is advertised unless the operator published one
  expect(choice.plan('linux', { linux: 'http://example.com/q' }, ID).download).toBeNull();                             // plain http links are never offered
  expect(choice.plan('ios', links, ID)).toMatchObject({ recommended: 'account', app: null, download: null });         // there is no iPhone app
  expect(choice.plan('windows', links, 'not-an-id').app).toBeNull();
  expect(choice.plan('in-app', links, ID).show).toBe(false);
});
test('the app-links endpoint lists only configured https links (none by default)', async ({ request }) => {
  const r = await request.get('/api/app-links'); expect(r.status()).toBe(200); expect(await r.json()).toEqual({});
  expect(r.headers()['cache-control']).toMatch(/no-store/);
});
for (const [kind, expectApp] of [['android', true], ['windows', true], ['linux', true], ['ios', false]]) {
  test(`${kind}: the invitee can join as a guest and sees the suitable option first`, async ({ browser }) => {
    const ctx = await browser.newContext({ userAgent: UA[kind] }); const page = await ctx.newPage();
    await page.route('**/api/guest/meetings/resolve', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ eligible: true, meeting: { topic: 'Invite test' }, passcodeRequired: false }) }));
    await page.goto('/guest/meeting/858%209833%203712/prejoin');
    await expect(page.locator('#pjGo')).toBeEnabled();                                                                 // joining as a guest is available at once
    await expect(page.locator('#pjApp')).toBeVisible();
    const first = page.locator('#pjAppBtns a').first();
    if (expectApp) { await expect(first).toHaveAttribute('href', 'qorlla://join?meeting=85898333712'); await expect(first).toContainText(kind === 'android' ? 'Android app' : 'desktop app'); await expect(first).toHaveClass(/^btn$/); }
    else await expect(first).toHaveAttribute('href', /^\/auth\/register\?next=/);
    const account = page.locator('#pjAppBtns a', { hasText: 'Create a free account' });
    await expect(account).toHaveAttribute('href', '/auth/register?next=' + encodeURIComponent('/guest/meeting/858 9833 3712/prejoin'));
    await expect(page.locator('#pjAppWhy')).toContainText('Recommended for your device');
    await ctx.close();
  });
}
test('inside a Qorlla app the extra options are not shown', async ({ browser }) => {
  for (const ua of [UA.desktopApp, UA.mobileApp]) {
    const ctx = await browser.newContext({ userAgent: ua }); const page = await ctx.newPage();
    await page.route('**/api/guest/meetings/resolve', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ eligible: true, meeting: { topic: 'x' }, passcodeRequired: false }) }));
    await page.goto('/guest/meeting/858%209833%203712/prejoin'); await expect(page.locator('#pjGo')).toBeEnabled(); await page.waitForTimeout(600);
    await expect(page.locator('#pjApp')).toBeHidden(); await ctx.close();
  }
});
