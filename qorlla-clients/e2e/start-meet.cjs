'use strict';
// Starts a Qorlla Meet from THIS checkout on its own port (default 3311) against the dev stack's PostgreSQL, so tests can run patched Meet code without touching the Meet that is already running on :3310.
// Normal clocks (unlike scripts/start-recording-test-meet.cjs, whose retention timers are shortened for recording tests). Needs the dev stack's database and .dev-stack/secrets.json.
//   node qorlla-clients/e2e/start-meet.cjs [port]      prints the pid; stop with:  node qorlla-clients/e2e/start-meet.cjs stop [port]
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname, '..', '..');
const arg = process.argv[2], stopping = arg === 'stop', port = String((stopping ? process.argv[3] : arg) || process.env.MEET_TEST_PORT || '3311');
const pidFile = path.join(os.tmpdir(), `qorlla-meet-${port}.pid`);
(async () => {
  if (stopping) { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8'))); console.log('stopped'); } catch { console.log('nothing to stop'); } try { fs.unlinkSync(pidFile); } catch { /* none */ } return; }
  if (await fetch(`http://localhost:${port}/api/config`).then((r) => r.ok).catch(() => false)) { console.log(`already running on :${port}`); return; }
  const s = JSON.parse(fs.readFileSync(path.join(root, '.dev-stack', 'secrets.json'), 'utf8'));
  const env = { ...process.env, PORT: port, DATABASE_URL: 'postgres://qorlla:' + s.dbPassword + '@127.0.0.1:35432/qorlla_meet', JWT_SECRET: s.jwt, QORLLA_BRIDGE_SECRET: s.bridge, RECOVERY_ESCROW_KEY: s.escrow, NODE_ENV: 'development',
    RECORDING_MASTER_KEYS: JSON.stringify({ dev1: s.recordingKey }), RECORDING_ACTIVE_KEY_ID: 'dev1', RECORDING_STORE_DIR: path.join(root, '.dev-stack', 'recordings'), RECORDING_ADMIN_SECRET: 'test-admin-secret', PHONE_PROVIDER: 'test', PHONE_WEBHOOK_SECRET: 'phone-test-secret-123456',
    RETURN_ORIGINS: process.env.RETURN_ORIGINS || 'http://localhost:5290,http://127.0.0.1:5290,http://localhost:5291,http://localhost:5292,http://localhost:5293,http://localhost:5294' };
  const log = fs.openSync(path.join(os.tmpdir(), `qorlla-meet-${port}.log`), 'w');
  const child = spawn(process.execPath, ['server/index.js'], { cwd: path.join(root, 'qorlla-meet-video'), detached: true, stdio: ['ignore', log, log], env }); child.unref(); fs.writeFileSync(pidFile, String(child.pid));
  for (let i = 0; i < 40; i++) { if (await fetch(`http://localhost:${port}/api/config`).then((r) => r.ok).catch(() => false)) { console.log(`Meet from ${path.relative(process.cwd(), path.join(root, 'qorlla-meet-video')) || '.'} running on :${port} (pid ${child.pid})`); return; } await new Promise((r) => setTimeout(r, 500)); }
  throw new Error('Meet did not come up on :' + port + ' (see ' + path.join(os.tmpdir(), `qorlla-meet-${port}.log`) + ')');
})().catch((e) => { console.error(e.message); process.exit(1); });
