// Test helper: a private Workplace server (MAIN) wired to the REAL Qorlla Meet on :3310 (node scripts/start-recording-test-meet.cjs), sharing the dev stack's bridge secret.
const { expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MEET = 'http://localhost:' + (process.env.MEET_TEST_PORT || 3310);   // MEET_TEST_PORT: run an isolated test Meet beside another one on 3310
const root = path.resolve(__dirname, '..', '..');
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

async function startMain(port, extraEnv = {}) {
  const secrets = JSON.parse(fs.readFileSync(path.join(root, '.dev-stack', 'secrets.json'), 'utf8'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qstack-'));
  const child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore', env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, MEET_PROBE_URL: MEET, ...extraEnv, QORLLA_BRIDGE_SECRET: secrets.bridge, MEET_DETECT: '', MEET_PUBLIC_URL: '' } });
  const base = 'http://localhost:' + port;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/')).ok) break; } catch (e) { /* not yet */ } await new Promise((r) => setTimeout(r, 500)); }
  const meetOk = await fetch(MEET + '/api/config').then((r) => r.ok).catch(() => false);
  if (!meetOk) throw new Error('Qorlla Meet is not running on :3310 (node scripts/start-recording-test-meet.cjs)');
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

module.exports = { MEET, startMain, organiser, login, ymd, PASSWORD };
