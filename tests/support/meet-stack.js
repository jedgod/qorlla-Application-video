// Test helper: a private Workplace server (MAIN) wired to the REAL Qorlla Meet on :3310 (node scripts/start-recording-test-meet.cjs), sharing the dev stack's bridge secret.
const { expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const MEET = 'http://localhost:' + (process.env.MEET_TEST_PORT || 3310);   // MEET_TEST_PORT: run an isolated test Meet beside another one on 3310
const root = path.resolve(__dirname, '..', '..');
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

// A test server must never attach to (or be mistaken for) something else already on its port: with { exclusive: true } an occupied port is refused (after a short wait for a previous test's server to finish closing).
// Opt-in on purpose: several specs still share fixed main-app ports across files (see the follow-up in the pull request) and some assert the literal port.
const portInUse = (port) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
async function assertPortFree(port, what) { for (let i = 0; i < 20; i++) { if (!(await portInUse(port))) return; await new Promise((r) => setTimeout(r, 250)); } throw new Error('Port ' + port + ' is already in use by another process; refusing to start ' + what + ' on it (it could be another environment).'); }
// A free port chosen at run time, for servers a test starts itself.
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function startMain(port, extraEnv = {}, { exclusive = false } = {}) {
  if (exclusive) await assertPortFree(port, 'the test main app');
  const secrets = JSON.parse(fs.readFileSync(path.join(root, '.dev-stack', 'secrets.json'), 'utf8'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qstack-'));
  const child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore', env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, MEET_PROBE_URL: MEET, ...extraEnv, QORLLA_BRIDGE_SECRET: secrets.bridge, MEET_DETECT: '', MEET_PUBLIC_URL: '' } });
  const base = 'http://localhost:' + port;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/')).ok) break; } catch (e) { /* not yet */ } await new Promise((r) => setTimeout(r, 500)); }
  const meetOk = await fetch(MEET + '/api/config').then((r) => r.ok).catch(() => false);
  if (!meetOk) throw new Error('Qorlla Meet is not running on ' + MEET + ' (MEET_TEST_PORT=<free port> MEET_DB_PORT=<port> node scripts/start-recording-test-meet.cjs)');
  // Fail closed: an unrelated Meet that merely answers HTTP (another environment, other secrets, maybe another database) must never be used. It has to accept this worktree's bridge secret.
  const probe = await fetch(MEET + '/api/integrations/telephony/capabilities', { headers: { 'x-qorlla-bridge-secret': secrets.bridge, 'x-qorlla-actor': 'u_harness_probe', 'x-qorlla-admin': '0' } }).then((r) => r.status).catch(() => 0);
  if (probe !== 200) { try { child.kill(); } catch (e) { /* gone */ } throw new Error('The Meet on ' + MEET + ' does not belong to this environment (it refused this worktree\'s bridge secret, status ' + probe + '). Refusing to run against it. Start an isolated one: MEET_TEST_PORT=<free port> MEET_DB_PORT=<port> node scripts/start-recording-test-meet.cjs'); }
  return { base, dataDir, stop() { try { child.kill(); } catch (e) { /* gone */ } try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* busy */ } } };
}

const PASSWORD = 'Handoff-pass-9917!x';
async function organiser(context, base, { name = 'Stryker', title = 'Sprint planning' } = {}) {
  const username = 'org' + Math.random().toString(36).slice(2, 8);
  const r = await context.request.post(base + '/api/auth/register', { data: { username, displayName: name, password: PASSWORD } }); expect(r.status()).toBe(201);
  const s = await context.request.post(base + '/api/workplace/schedule', { data: { title, date: ymd(new Date()), time: '23:00', duration: 30 } }); expect(s.status()).toBe(201);
  return { username, item: await s.json() };
}
async function login(context, base, username) { const r = await context.request.post(base + '/api/auth/login', { data: { username, password: PASSWORD } }); expect(r.status()).toBe(200); }

module.exports = { MEET, startMain, organiser, login, ymd, PASSWORD, freePort, assertPortFree };
