// Test helper: the real main app + the real Qorlla Voice engine (a child process we can kill and restart) on an isolated PostgreSQL schema. TURN/Redis can be passed through engineEnv.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { startMain } = require('./meet-stack');

const root = path.resolve(__dirname, '..', '..');
const ADMIN = 'v'.repeat(40);

async function startVoiceStack({ mainPort, voicePort, engineEnv = {}, mainEnv = {} }) {
  const secrets = JSON.parse(fs.readFileSync(path.join(root, '.dev-stack', 'secrets.json'), 'utf8'));
  const DB = 'postgres://qorlla:' + secrets.dbPassword + '@127.0.0.1:35432/qorlla_meet';
  const schema = 'qe2e_' + Math.random().toString(36).slice(2, 9), admin = new Pool({ connectionString: DB }); await admin.query('CREATE SCHEMA ' + schema);
  const sp = new Pool({ connectionString: DB, options: '-c search_path=' + schema });
  const dir = path.join(root, 'qorlla-voice-engine'); for (const f of fs.readdirSync(path.join(dir, 'sql')).filter((x) => /^\d{3}_.+\.sql$/.test(x)).sort()) await sp.query(fs.readFileSync(path.join(dir, 'sql', f), 'utf8')); await sp.end();
  const main = await startMain(mainPort, { QORLLA_VOICE_ENABLED: 'true', VOICE_ADMIN_SECRET: ADMIN, VOICE_PORT: String(voicePort), VOICE_INTERNAL_URL: 'http://127.0.0.1:' + voicePort, ...mainEnv });
  const log = []; let engine = null;
  const env = () => ({ ...process.env, PORT: String(voicePort), DATABASE_URL: DB + '?options=' + encodeURIComponent('-c search_path=' + schema), VOICE_JWKS_URL: 'http://127.0.0.1:' + mainPort + '/.well-known/voice-jwks.json',
    VOICE_JWT_ISSUER: 'qorlla-main', VOICE_JWT_AUDIENCE: 'qorlla-voice', VOICE_ALLOWED_ORIGIN: 'http://localhost:' + mainPort, VOICE_ADMIN_SECRET: ADMIN, VOICE_RING_SECONDS: '5', VOICE_OUTBOX_INTERVAL_MS: '100', ...engineEnv });
  async function startEngine() {
    engine = spawn(process.execPath, ['src/server.mjs'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: env() });
    for (const s of [engine.stdout, engine.stderr]) s.on('data', (d) => log.push(String(d)));
    for (let i = 0; i < 80; i++) { if (await fetch('http://127.0.0.1:' + voicePort + '/readyz').then((r) => r.ok).catch(() => false)) return; await new Promise((r) => setTimeout(r, 250)); }
    throw new Error('the voice engine did not become ready:\n' + log.join(''));
  }
  async function stopEngine() { if (!engine) return; const e = engine; engine = null; await new Promise((r) => { e.once('exit', r); e.kill(); setTimeout(r, 3000); }); }
  await startEngine();
  return { main, base: main.base, log, ADMIN, schema, startEngine, stopEngine, restartEngine: async () => { await stopEngine(); await startEngine(); },
    metrics: () => fetch('http://127.0.0.1:' + voicePort + '/v1/voice/admin/metrics', { headers: { 'x-voice-admin-secret': ADMIN } }).then((r) => r.json()),
    async stop() { await stopEngine(); main.stop(); await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(() => {}); await admin.end(); } };
}
module.exports = { startVoiceStack, ADMIN };
