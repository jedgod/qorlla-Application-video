const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Scheduled meetings: the organiser sees START (not Join) and goes straight into the current Meet video page as host, with the meeting ID and password shown first;
// invited guests JOIN through the pre-join page and land in the same current Meet page (never the old built-in room).
// Runs its own Workplace server (port 5290) against a REAL Qorlla Meet on 3310 (node scripts/start-recording-test-meet.cjs), sharing the dev stack's bridge secret.
const MAIN = 'http://localhost:5290', MEET = 'http://localhost:3310';
const root = path.resolve(__dirname, '..');
let child, dataDir;
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

test.describe.configure({ mode: 'serial' });
test.use({ permissions: ['camera', 'microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test.beforeAll(async () => {
  const secrets = JSON.parse(fs.readFileSync(path.join(root, '.dev-stack', 'secrets.json'), 'utf8'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qhandoff-'));
  child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore', env: { ...process.env, PORT: '5290', DATA_DIR: dataDir, MEET_PROBE_URL: MEET, QORLLA_BRIDGE_SECRET: secrets.bridge, MEET_DETECT: '', MEET_PUBLIC_URL: '' } });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(MAIN + '/api/health')).ok || (await fetch(MAIN + '/')).ok) break; } catch (e) { /* not yet */ } await new Promise((r) => setTimeout(r, 500)); }
  const meetOk = await fetch(MEET + '/api/config').then((r) => r.ok).catch(() => false); if (!meetOk) throw new Error('Qorlla Meet is not running on :3310 (node scripts/start-recording-test-meet.cjs)');
});
test.afterAll(() => { try { child.kill(); } catch (e) { /* gone */ } try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* busy */ } });

async function organiser(context, name = 'Stryker') {
  const username = 'org' + Math.random().toString(36).slice(2, 8);
  const r = await context.request.post(MAIN + '/api/auth/register', { data: { username, displayName: name, password: 'Handoff-pass-9917!x' } }); expect(r.status()).toBe(201);
  const s = await context.request.post(MAIN + '/api/workplace/schedule', { data: { title: 'Sprint planning', date: ymd(new Date()), time: '23:00', duration: 30 } }); expect(s.status()).toBe(201);
  return { username, item: await s.json() };
}

test('the organiser sees Start (never Join) on Home, Schedule and the menu', async ({ page, context }) => {
  await organiser(context);
  await page.goto(MAIN + '/qorlla.html#home'); const card = page.locator('.meeting', { hasText: 'Sprint planning' }); await expect(card).toBeVisible();
  await expect(card.locator('.join-pill')).toHaveText('Start');
  await page.goto(MAIN + '/qorlla.html#schedule'); await page.reload();
  const row = page.locator('.sched-item, .item, li, div', { has: page.getByText('Sprint planning') }).filter({ has: page.getByRole('button', { name: 'Start' }) }).first();
  await expect(page.getByRole('button', { name: 'Start', exact: true }).first()).toBeVisible(); await expect(page.getByRole('button', { name: 'Join', exact: true })).toHaveCount(0);
  void row;
});

test('Start shows the meeting ID and password, then goes straight into the Meet video page as host (no landing page, no secrets left in the address bar)', async ({ page, context }) => {
  test.setTimeout(90000);
  const { item } = await organiser(context);
  await page.goto(MAIN + '/qorlla.html#home'); await page.locator('.meeting', { hasText: 'Sprint planning' }).locator('.join-pill').click();
  const dlg = page.locator('#joinDialog'); await expect(dlg).toBeVisible(); await expect(page.locator('#dlgTitle')).toContainText('Start meeting'); await expect(page.locator('#siId')).toHaveText(item.meetingId);
  await expect(page.locator('#siPassText')).toContainText('No password');
  await page.click('#siGen'); await expect(page.locator('#siPassText')).toHaveText(/^[A-Za-z0-9]{10}$/); const password = await page.locator('#siPassText').textContent(); await expect(page.locator('#siGen')).toHaveText('Generate new password');
  await page.click('#dlgGo');
  await page.waitForURL(/localhost:3310/); await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 });                       // the meeting itself, not the landing page
  await expect(page.locator('#landing')).toBeHidden(); await expect(page.locator('#endBtn')).toBeVisible();                                                // host controls: the organiser is the host
  await expect(page.locator('#roomTitle')).toHaveText('Sprint planning'); await expect(page.locator('#roomId')).toHaveText(item.meetingId);               // the same ID the pre-join page shows
  expect(page.url()).not.toContain('qs='); expect(page.url()).not.toContain('token'); await expect(page.locator('#panelToggle')).toBeVisible();          // current video page
  // the host credential never reached the browser
  const stored = await page.evaluate(() => JSON.stringify(sessionStorage) + JSON.stringify(localStorage)); expect(stored).not.toMatch(/hostSecret/i);
  test.info().annotations.push({ type: 'password', description: password });
  globalThis.__handoff = { item, password };
});

test('an invited guest joins through the pre-join page, needs the password, and lands in the SAME current Meet page', async ({ browser }) => {
  test.setTimeout(120000);
  const { item, password } = globalThis.__handoff || {};
  expect(item, 'the previous test sets up the meeting').toBeTruthy();
  const g = await browser.newContext({ permissions: ['camera', 'microphone'] }); const gp = await g.newPage();
  await gp.goto(MAIN + '/guest/meeting/' + encodeURIComponent(item.meetingId) + '/prejoin'); await expect(gp.locator('#pjTopic')).toContainText('Sprint planning'); await expect(gp.locator('#pjPassWrap')).toBeVisible();
  await gp.fill('#pjName', 'Guest Gail'); await gp.fill('#pjPass', 'definitely-wrong'); await gp.click('#pjGo'); await expect(gp.locator('#pjMsg')).toContainText('Incorrect passcode'); expect(gp.url()).toContain('/prejoin');   // refused: stays here
  await gp.fill('#pjPass', password); await gp.click('#pjGo');
  await gp.waitForURL(/localhost:3310/); await expect(gp.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 }); await expect(gp.locator('#endBtn')).toBeHidden();   // a guest, not a host
  await expect(gp.locator('#panelToggle')).toBeVisible(); await expect(gp.locator('#liveBadge')).toBeVisible(); await expect(gp.locator('#roomId')).toHaveText(item.meetingId);   // the new video page
  expect(gp.url()).not.toContain('qs=');
  await g.close();
});

test('host and guest meet in the same room; the ID cannot be used to bypass the password directly in Meet; only the organiser can launch', async ({ browser, context }) => {
  test.setTimeout(150000);
  // organiser (own context)
  const oc = await browser.newContext({ permissions: ['camera', 'microphone'] }); const op = await oc.newPage(); const { item } = await organiser(oc);
  await op.goto(MAIN + '/qorlla.html#home'); await op.locator('.meeting', { hasText: 'Sprint planning' }).locator('.join-pill').click(); await op.click('#dlgGo');
  await op.waitForURL(/localhost:3310/); await expect(op.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 });
  // open meeting (no password): the guest goes straight in and both see each other
  const gc = await browser.newContext({ permissions: ['camera', 'microphone'] }); const gp = await gc.newPage();
  await gp.goto(MAIN + '/guest/meeting/' + encodeURIComponent(item.meetingId) + '/prejoin'); await gp.fill('#pjName', 'Guest Gus'); await expect(gp.locator('#pjGo')).toBeEnabled(); await gp.click('#pjGo');
  await gp.waitForURL(/localhost:3310/); await expect(gp.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 });
  await expect(op.locator('.tile')).toHaveCount(2, { timeout: 30000 }); await expect(gp.locator('.tile')).toHaveCount(2, { timeout: 30000 });
  // typing the ID into Meet directly does not skip MAIN's password check: Meet itself demands a passcode only this server knows
  const direct = await fetch(MEET + '/api/meetings/' + encodeURIComponent(item.meetingId.replace(/\D/g, '')) + '/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sneaky' }) }); expect(direct.status).toBe(403);
  // launching someone else's meeting is refused; so is launching without signing in
  const other = await browser.newContext(); await other.request.post(MAIN + '/api/auth/register', { data: { username: 'oth' + Math.random().toString(36).slice(2, 7), displayName: 'Other', password: 'Handoff-pass-9917!x' } });
  expect((await other.request.post(MAIN + '/api/meetings/' + encodeURIComponent(item.meetingId) + '/meet-launch', { data: {} })).status()).toBe(403);
  expect((await (await browser.newContext()).request.post(MAIN + '/api/meetings/' + encodeURIComponent(item.meetingId) + '/meet-launch', { data: {} })).status()).toBe(401);
  expect((await other.request.put(MAIN + '/api/meetings/' + encodeURIComponent(item.meetingId) + '/passcode', { data: { passcode: 'abcdefgh' } })).status()).toBe(403);
  for (const c of [oc, gc, other]) await c.close();
});
