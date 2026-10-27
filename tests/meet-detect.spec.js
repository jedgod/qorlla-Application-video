const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process'); const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path');

test.use({ permissions: ['camera', 'microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });
// Where does "New meeting" go? Configured Meet first, then a Meet detected on this machine, otherwise the basic built-in room WITH a visible notice.
let nextPort = 5640 + Math.floor(Math.random() * 25);
function listen(handler) { return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, close: () => new Promise((r) => s.close(r)) })); }); }
const stubMeet = () => listen((req, res) => { if (req.url === '/api/config') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"iceServers":[]}'); } else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>stub meet</h1>'); } });
const notMeet = () => listen((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); });   // answers everything, but is not Meet
async function boot(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qorlla-meet-')); const port = nextPort++;
  const e = { ...process.env, PORT: String(port), DATA_DIR: dir, ...env }; delete e.DATABASE_URL; delete e.MEET_DETECT; Object.assign(e, env);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: e, stdio: 'ignore' }); const base = `http://127.0.0.1:${port}`;
  let up = false; for (let i = 0; i < 300 && !up; i++) { try { up = (await fetch(base + '/api/health')).ok; } catch (x) { /* not up yet */ } if (!up) await new Promise((r) => setTimeout(r, 150)); }
  if (!up) throw new Error('test server did not start within 45 s: ' + base);
  return { base, stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }) };
}
const cfg = async (base) => (await (await fetch(base + '/meet-config.js')).text()).trim();

test.describe('server-side detection of Meet', () => {
  test('a Meet answering on the probe address is detected and used with the visitor\'s own host name', async () => {
    const m = await stubMeet(); const app = await boot({ MEET_PROBE_URL: `http://127.0.0.1:${m.port}` });
    try { expect(await cfg(app.base)).toBe(`window.QORLLA_MEET_URL="http://127.0.0.1:${m.port}/";`); } finally { await app.stop(); await m.close(); }
  });
  test('another app on that port is NOT mistaken for Meet; nothing listening gives no Meet; the probe can be switched off', async () => {
    const other = await notMeet(); const a = await boot({ MEET_PROBE_URL: `http://127.0.0.1:${other.port}` }); const m = await stubMeet(); const off = await boot({ MEET_PROBE_URL: `http://127.0.0.1:${m.port}`, MEET_DETECT: 'off' });
    const gone = await boot({ MEET_PROBE_URL: 'http://127.0.0.1:9' });
    try { expect(await cfg(a.base)).toBe('window.QORLLA_MEET_URL="";'); expect(await cfg(off.base)).toBe('window.QORLLA_MEET_URL="";'); expect(await cfg(gone.base)).toBe('window.QORLLA_MEET_URL="";'); }
    finally { await a.stop(); await off.stop(); await gone.stop(); await other.close(); await m.close(); }
  });
  test('an explicit MEET_PUBLIC_URL wins over detection', async () => {
    const m = await stubMeet(); const app = await boot({ MEET_PUBLIC_URL: 'https://meet.example.test/x', MEET_PROBE_URL: `http://127.0.0.1:${m.port}` });
    try { expect(await cfg(app.base)).toBe('window.QORLLA_MEET_URL="https://meet.example.test/";'); } finally { await app.stop(); await m.close(); }
  });
});

test.describe('New meeting in the browser', () => {
  const signUp = async (context, base) => { const r = await context.request.post(base + '/api/auth/register', { data: { username: 'md' + Math.random().toString(36).slice(2, 8), displayName: 'Stryker', password: 'Detect-pass-9917!x' } }); expect(r.status()).toBe(201); };

  test('with Meet running, New meeting opens Meet (the current video page), not the basic room', async ({ page, context }) => {
    const m = await stubMeet(); const app = await boot({ MEET_PROBE_URL: `http://127.0.0.1:${m.port}` });
    try {
      await signUp(context, app.base); await page.goto(app.base + '/qorlla.html#home'); await page.locator('.action-btn[data-act="meet"]').click(); await page.click('#dlgGo');
      await expect(page.getByRole('heading', { name: 'stub meet' })).toBeVisible(); const u = new URL(page.url()); expect(u.port).toBe(String(m.port)); expect(u.searchParams.get('start')).toBe('new'); expect(u.searchParams.get('name')).toBe('Stryker');
    } finally { await app.stop(); await m.close(); }
  });

  test('without Meet, New meeting opens the basic room AND says why (never silently the old page)', async ({ page, context }) => {
    const app = await boot({ MEET_PROBE_URL: 'http://127.0.0.1:9' });
    try {
      await signUp(context, app.base); await page.goto(app.base + '/qorlla.html#home'); await page.locator('.action-btn[data-act="meet"]').click(); await page.click('#dlgGo');
      await expect(page).toHaveURL(/\/index\.html\?start=new/); await expect(page.locator('#meetingBar')).toBeVisible();
      await expect(page.locator('#toasts')).toContainText('Qorlla Meet is not running here'); await expect(page.locator('#toasts')).toContainText('basic meeting room');
    } finally { await app.stop(); }
  });
});
