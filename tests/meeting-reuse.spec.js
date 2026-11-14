const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');

// "Meeting access (reusable)" in the real page: Meeting ID and password on History rows and on the host's Start screen, copy buttons, the Allow reuse switch, the plan limit, Start again.
// Own server per test with an isolated DATA_DIR, a password key and a small free-plan allowance. Needs the fake camera/microphone of the Chromium project (built-in room attendee test).
test.use({ permissions: ['camera', 'microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });
let nextPort = 5400 + Math.floor(Math.random() * 300);
async function start(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qreuse-ui-')), port = nextPort++;
  const env = { ...process.env, PORT: String(port), DATA_DIR: dir, MEET_DETECT: 'off', HISTORY_IDLE_MS: '1', REUSE_LIMIT_FREE: '2', MEETING_PASSCODE_KEY: 'p'.repeat(40), ...extraEnv }; delete env.DATABASE_URL;
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' }); const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 240; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch (e) { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }
  return { base, stop: () => child.kill() };
}
async function signedIn(context, base, name = 'Reuse Host') {
  const username = 'r' + Math.random().toString(36).slice(2, 8);
  const r = await context.request.post(base + '/api/auth/register', { data: { username, displayName: name, password: 'History-pass-9917!x' } }); expect(r.status()).toBe(201);
}
const PW = 'Planning-Pass-77';
const missed = async (context, base, extra = {}) => { const r = await context.request.post(base + '/api/meetings/create', { data: { topic: 'Quarterly planning', startTime: new Date(Date.now() - 3 * 3600e3).toISOString(), durationMinutes: 0.02, passcode: PW, ...extra } }); expect(r.status()).toBe(201); return (await r.json()).meeting; };
const group = (id) => id;                                                                                       // allocated IDs are already stored grouped (3-4-4)
const openRow = async (page, text) => { const row = page.locator('.hist-row', { hasText: text }).first(); await expect(row).toBeVisible({ timeout: 30000 }); await row.locator('.hist-rowhead').click(); const card = row.locator('.acc-card'); await expect(card).toBeVisible(); return { row, card }; };
const clip = (page) => page.evaluate(() => navigator.clipboard.readText());

test('host: the card shows the Meeting ID and the password (fetched on open, never in lists, summaries or exports); both copy buttons work; the switch persists; Start again consumes exactly one', async ({ browser }) => {
  test.setTimeout(150000); const s = await start();
  try {
    const context = await browser.newContext({ permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] }); await signedIn(context, s.base); const m = await missed(context, s.base);
    const page = await context.newPage(); const listBodies = [], revealHeaders = [];
    page.on('response', async (r) => { try { if (/\/api\/history\/meetings/.test(r.url())) listBodies.push(await r.text()); if (/credentials\/reveal/.test(r.url())) revealHeaders.push(r.headers()['cache-control'] || ''); } catch (e) { /* page closed */ } });
    await page.goto(s.base + '/');
    const { row, card } = await openRow(page, 'Quarterly planning');
    await expect(row.locator('.hist-id')).toContainText(group(m.meetingId));                                          // the ID is on the collapsed row
    await expect(card).toContainText('Meeting access (reusable)'); await expect(card).toContainText('Use the same Meeting ID and Password to start again.');
    await expect(card.locator('.acc-val').nth(0)).toHaveValue(group(m.meetingId)); await expect(card.locator('.acc-val').nth(1)).toHaveValue(PW);        // shown, not masked
    expect(revealHeaders.join(' ')).toContain('no-store'); expect(listBodies.length).toBeGreaterThan(0); expect(listBodies.join('')).not.toContain(PW);   // never in the list payload
    // copy: the Meeting ID copies the raw digits, the password copies as is, and the confirmation is visible and announced
    await card.getByRole('button', { name: 'Copy Meeting ID' }).click(); expect(await clip(page)).toBe(m.meetingId.replace(/\D/g, '')); await expect(card.locator('.acc-copy.done')).toHaveCount(1); await expect(page.locator('#toast')).toContainText('Meeting ID copied');
    await card.getByRole('button', { name: 'Copy Password' }).click(); expect(await clip(page)).toBe(PW);
    // Copy summary and Export report never carry the password
    await row.getByRole('button', { name: 'Copy summary' }).click(); expect(await clip(page)).not.toContain(PW);
    const rep = await context.request.get(s.base + '/api/history/meetings/' + encodeURIComponent(m.meetingId) + '/report'); expect(rep.status()).toBe(200); expect(await rep.text()).not.toContain(PW);
    // the switch is a real switch, on by default, labelled; turning it off persists after a reload and disables Start again
    const sw = card.getByRole('switch', { name: 'Allow reuse' }); await expect(sw).toHaveAttribute('aria-checked', 'true'); await expect(card.getByRole('button', { name: /Start again/ })).toContainText('2 left'); await expect(card.getByRole('button', { name: /Start again/ })).toBeEnabled();
    await sw.focus(); await page.keyboard.press('Space'); await expect(sw).toHaveAttribute('aria-checked', 'false'); await expect(card.getByRole('button', { name: /Start again/ })).toBeDisabled();
    await page.reload(); const again = await openRow(page, 'Quarterly planning'); await expect(again.card.getByRole('switch', { name: 'Allow reuse' })).toHaveAttribute('aria-checked', 'false'); await expect(again.card.getByRole('button', { name: /Start again/ })).toBeDisabled();
    expect((await context.request.post(s.base + '/api/meetings/' + encodeURIComponent(m.meetingId) + '/reuse', { data: { clientRequestId: 'ui-off-request-1' } })).status()).toBe(403);   // and the server refuses it too
    await again.card.getByRole('switch', { name: 'Allow reuse' }).click(); await expect(again.card.getByRole('switch', { name: 'Allow reuse' })).toHaveAttribute('aria-checked', 'true');
    // the information tooltip explains the plan limit and what is left
    await expect(again.card.locator('.acc-info')).toHaveAttribute('title', /2 of 2 re-uses left on your free plan/);
    // Start again: exactly one re-use is consumed, the existing Start screen opens for the same ID, and shows the same access card
    await again.card.getByRole('button', { name: /Start again/ }).click();
    await expect(page.locator('#startDialog')).toBeVisible({ timeout: 15000 }); await expect(page.locator('#sdAccess .acc-val').nth(0)).toHaveValue(m.meetingId); await expect(page.locator('#sdAccess .acc-val').nth(1)).toHaveValue(PW);
    const info = await (await context.request.get(s.base + '/api/meetings/' + encodeURIComponent(m.meetingId) + '/credentials')).json(); expect([info.reuse.used, info.reuse.remaining]).toEqual([1, 1]);
    await page.keyboard.press('Escape'); await expect(page.locator('.hist-row', { hasText: 'Quarterly planning' })).toHaveCount(1);        // the finished run stays in History (as Run 1)
    await expect(page.locator('.hist-row', { hasText: 'Quarterly planning' }).first().locator('.hist-id')).toContainText('Run 1');
    await context.close();
  } finally { s.stop(); }
});

test('attendee: sees the Meeting ID but not the password, and has no reuse controls', async ({ browser }) => {
  test.setTimeout(150000); const s = await start();
  try {
    const hc = await browser.newContext(); await signedIn(hc, s.base, 'Hostess'); const ac = await browser.newContext(); await signedIn(ac, s.base, 'Ann Attendee');
    const created = await hc.request.post(s.base + '/api/meetings/create', { data: { topic: 'Team sync', durationMinutes: 30 } }); expect(created.status()).toBe(201); const m = (await created.json()).meeting;
    const enter = async (page, name) => { page.on('dialog', (d) => d.accept()); await page.goto(s.base + '/index.html?start=join&meeting=' + encodeURIComponent(m.meetingId) + '&name=' + name); await expect(page.locator('#meetingBar')).toBeVisible({ timeout: 40000 }); };
    const hp = await hc.newPage(), ap = await ac.newPage(); await enter(hp, 'Hostess'); await enter(ap, 'Ann'); await expect(hp.locator('#videoGrid .tile')).toHaveCount(2, { timeout: 30000 });
    expect((await hc.request.put(s.base + '/api/meetings/' + encodeURIComponent(m.meetingId) + '/passcode', { data: { passcode: PW } })).status()).toBe(200);        // the host sets a password during the meeting
    await hp.click('#endCallBtn'); await expect.poll(async () => (await (await ac.request.get(s.base + '/api/history/meetings')).json()).meetings.length, { timeout: 20000 }).toBe(1);
    const page = await ac.newPage(); const bodies = []; page.on('response', async (r) => { try { if (/\/api\//.test(r.url())) bodies.push(await r.text()); } catch (e) { /* closed */ } });
    await page.goto(s.base + '/'); const { row, card } = await openRow(page, 'Team sync');
    await expect(row.locator('.hist-id')).toContainText(m.meetingId); await expect(card.locator('.acc-val').nth(0)).toHaveValue(m.meetingId); await expect(card.locator('.acc-val').nth(1)).toHaveValue('Ask the host for the password');
    await expect(card.getByRole('switch')).toHaveCount(0); await expect(card.getByRole('button', { name: /Start again/ })).toHaveCount(0); await expect(card.getByRole('button', { name: 'Copy Password' })).toHaveCount(0);
    expect(await page.content()).not.toContain(PW); expect(bodies.join('')).not.toContain(PW);
    for (const [method, p] of [['get', '/credentials'], ['post', '/credentials/reveal'], ['post', '/reuse']]) { const r = await ac.request[method](s.base + '/api/meetings/' + encodeURIComponent(m.meetingId) + p, method === 'post' ? { data: { clientRequestId: 'attendee-try-01' } } : {}); expect(r.status()).toBe(403); expect(await r.text()).not.toContain(PW); }
    // and the host sees the password on the same meeting
    const hh = await hc.newPage(); await hh.goto(s.base + '/'); const mine = await openRow(hh, 'Team sync'); await expect(mine.card.locator('.acc-val').nth(1)).toHaveValue(PW);
    await hc.close(); await ac.close();
  } finally { s.stop(); }
});

test('limit: with no re-use left the switch is off and disabled, Start again is disabled and Upgrade is offered; zero-allowance plans too', async ({ browser }) => {
  test.setTimeout(150000); const s = await start({ REUSE_LIMIT_FREE: '1' });
  try {
    const context = await browser.newContext(); await signedIn(context, s.base); const m = await missed(context, s.base, { topic: 'Only one re-use' });
    expect((await context.request.post(s.base + '/api/meetings/' + encodeURIComponent(m.meetingId) + '/reuse', { data: { clientRequestId: 'limit-ui-run-1' } })).status()).toBe(201);
    await new Promise((r) => setTimeout(r, 2500));                                                                    // the new run (1.2 s) is over and counts as finished
    const page = await context.newPage(); await page.goto(s.base + '/'); const { card } = await openRow(page, 'Run 2');
    const sw = card.getByRole('switch', { name: 'Allow reuse' }); await expect(sw).toBeDisabled(); await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(card.getByRole('button', { name: /Start again/ })).toBeDisabled(); await expect(card).toContainText('0 of 1 re-uses left on your free plan'); await expect(card).toContainText('Upgrade to have full access to Qorlla packages');
    await expect(card.getByRole('link', { name: 'See plans and upgrade' })).toHaveAttribute('href', /pricing\?reason=meeting-reuse/);
    await context.close();
  } finally { s.stop(); }
  const z = await start({ REUSE_LIMIT_FREE: '0' });
  try {
    const context = await browser.newContext(); await signedIn(context, z.base); await missed(context, z.base, { topic: 'No reuse on this plan' });
    const page = await context.newPage(); await page.goto(z.base + '/'); const { card } = await openRow(page, 'No reuse on this plan');
    await expect(card.getByRole('switch', { name: 'Allow reuse' })).toBeDisabled(); await expect(card).toContainText('Your plan does not include re-using a meeting'); await expect(card.getByRole('button', { name: /Start again/ })).toBeDisabled();
    await context.close();
  } finally { z.stop(); }
});

test('no key or an old password: "Password not stored"; a cancelled meeting shows the card too; the page does not scroll sideways at 390 px', async ({ browser }) => {
  test.setTimeout(150000); const s = await start({ MEETING_PASSCODE_KEY: '' });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 } }); await signedIn(context, s.base); await missed(context, s.base, { topic: 'Stored hash only' });
    const d = new Date(Date.now() + 864e5), ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const sc = await context.request.post(s.base + '/api/workplace/schedule', { data: { title: 'Cancelled one', date: ymd, time: '10:00', duration: 30 } }); expect(sc.status()).toBe(201); await context.request.delete(s.base + '/api/workplace/schedule/' + (await sc.json()).id);
    const page = await context.newPage(); await page.goto(s.base + '/');
    const a = await openRow(page, 'Stored hash only'); await expect(a.card.locator('.acc-val').nth(1)).toHaveValue('Password not stored');
    const b = await openRow(page, 'Cancelled one'); await expect(b.card).toBeVisible(); await expect(b.row.locator('.hist-chip')).toContainText('Cancelled'); await expect(b.card.getByRole('switch', { name: 'Allow reuse' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const box = await b.card.boundingBox(); expect(box.width).toBeLessThanOrEqual(390);          // (phones keep one card open at a time: the second one is the open one)
    await context.close();
  } finally { s.stop(); }
});

test('current meeting: the host\'s Start screen shows the Meeting ID and password, and Create-less: a password set before is shown', async ({ browser }) => {
  test.setTimeout(150000); const s = await start();
  try {
    const context = await browser.newContext({ permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] }); await signedIn(context, s.base);
    const d = new Date(Date.now() + 864e5), ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const sc = await context.request.post(s.base + '/api/workplace/schedule', { data: { title: 'Upcoming sync', date: ymd, time: '10:00', duration: 30 } }); expect(sc.status()).toBe(201); const meetingId = (await sc.json()).meetingId;
    expect((await context.request.put(s.base + '/api/meetings/' + encodeURIComponent(meetingId) + '/passcode', { data: { passcode: PW } })).status()).toBe(200);
    const page = await context.newPage(); await page.goto(s.base + '/'); const card = page.locator('.meeting', { hasText: 'Upcoming sync' }); await expect(card).toBeVisible({ timeout: 30000 }); await expect(card).toContainText(meetingId);       // the ID is on the card
    await card.click(); await expect(page.locator('#startDialog')).toBeVisible();
    const acc = page.locator('#sdAccess .acc-card'); await expect(acc.locator('.acc-val').nth(0)).toHaveValue(meetingId); await expect(acc.locator('.acc-val').nth(1)).toHaveValue(PW); await expect(acc.getByRole('button', { name: /Start again/ })).toHaveCount(0);     // not finished: no Start again
    await context.close();
  } finally { s.stop(); }
});
