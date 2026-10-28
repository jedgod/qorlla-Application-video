// One command for local development: Qorlla Meet (its own PostgreSQL in Docker) + the main app, wired together.
//   npm run dev:stack            main app http://localhost:3200   Meet http://localhost:3300
//   MAIN_PORT=3100 MEET_PORT=3000 npm run dev:stack     (use other ports)
//   DEV_SEED_FROM=<folder> npm run dev:stack            first start only: copy an existing data folder (e.g. the project's data/) so those accounts exist here.
//                                                       The ORIGINAL folder is never written to; the stack works on its own copy in .dev-stack/data.
// Needs Docker (for Meet's PostgreSQL) and the dependencies installed in this folder and in qorlla-meet-video/. State lives in .dev-stack/ (git-ignored).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_PORT = Number(process.env.MAIN_PORT || 3200), MEET_PORT = Number(process.env.MEET_PORT || 3300), DB_PORT = Number(process.env.MEET_DB_PORT || 35432);
const DB = 'qorlla-meet-dev-db', state = path.join(root, '.dev-stack'); fs.mkdirSync(path.join(state, 'data'), { recursive: true });
if (process.env.DEV_SEED_FROM && !fs.existsSync(path.join(state, 'data', 'auth', 'users.json'))) {
  const from = path.resolve(process.env.DEV_SEED_FROM);
  if (!fs.existsSync(path.join(from, 'auth', 'users.json'))) { console.error('DEV_SEED_FROM has no auth/users.json: ' + from); process.exit(1); }
  fs.cpSync(from, path.join(state, 'data'), { recursive: true, filter: (src) => !/passcode-lockout|limits.json$/.test(src) });   // copy accounts and content; start with clean sign-in throttles
  console.log('Seeded .dev-stack/data from a copy of ' + from);
}
const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8' });

// secrets are generated once and kept, so restarts keep working (Meet encrypts host-recovery material with the escrow key)
const secretsFile = path.join(state, 'secrets.json');
const secrets = fs.existsSync(secretsFile) ? JSON.parse(fs.readFileSync(secretsFile, 'utf8')) : { jwt: crypto.randomBytes(24).toString('hex'), bridge: crypto.randomBytes(24).toString('hex'), escrow: crypto.randomBytes(32).toString('base64'), dbPassword: crypto.randomBytes(12).toString('hex') };
if (!secrets.recordingKey) secrets.recordingKey = crypto.randomBytes(32).toString('base64');
fs.writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });

if (docker('version').status !== 0) { console.error('Docker is required for Meet\'s database. Start Docker Desktop and try again.'); process.exit(1); }
const exists = docker('ps', '-a', '--filter', `name=^${DB}$`, '--format', '{{.Names}}').stdout.trim() === DB;
if (!exists) {
  const r = docker('run', '-d', '--name', DB, '-e', 'POSTGRES_USER=qorlla', '-e', `POSTGRES_PASSWORD=${secrets.dbPassword}`, '-e', 'POSTGRES_DB=qorlla_meet', '-p', `127.0.0.1:${DB_PORT}:5432`, '-v', 'qorlla-meet-dev-data:/var/lib/postgresql/data', 'postgres:16-alpine');
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
} else if (docker('ps', '--filter', `name=^${DB}$`, '--format', '{{.Names}}').stdout.trim() !== DB) docker('start', DB);
for (let i = 0; i < 60 && docker('exec', DB, 'pg_isready', '-U', 'qorlla', '-d', 'qorlla_meet').status !== 0; i++) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1500)']);
const has = docker('exec', DB, 'psql', '-U', 'qorlla', '-d', 'qorlla_meet', '-tAc', "select to_regclass('public.meetings') is not null").stdout.trim();
if (has !== 't') {
  for (const f of ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql']) {
    const r = spawnSync('docker', ['exec', '-i', DB, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'qorlla', '-d', 'qorlla_meet'], { input: fs.readFileSync(path.join(root, 'qorlla-meet-video', 'sql', f)), encoding: 'utf8' });
    if (r.status !== 0) { console.error('Meet schema step failed:', f, r.stderr); process.exit(1); }
  }
}

// idempotent additions are applied on EVERY start, so an existing development database picks them up
{ const r = spawnSync('docker', ['exec', '-i', DB, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'qorlla', '-d', 'qorlla_meet'], { input: fs.readFileSync(path.join(root, 'qorlla-meet-video', 'sql', 'v4_7_recording_consent.sql')), encoding: 'utf8' });
  if (r.status !== 0) { console.error('Recording-consent migration failed:', r.stderr); process.exit(1); } }
{ const r = spawnSync('docker', ['exec', '-i', DB, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'qorlla', '-d', 'qorlla_meet'], { input: fs.readFileSync(path.join(root, 'qorlla-meet-video', 'sql', 'v4_8_collab.sql')), encoding: 'utf8' });
  if (r.status !== 0) { console.error('Collaboration migration failed:', r.stderr); process.exit(1); } }
{ const r = spawnSync('docker', ['exec', '-i', DB, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'qorlla', '-d', 'qorlla_meet'], { input: fs.readFileSync(path.join(root, 'qorlla-meet-video', 'sql', 'v4_9_recording_storage.sql')), encoding: 'utf8' });
  if (r.status !== 0) { console.error('Recording-storage migration failed:', r.stderr); process.exit(1); } }

const children = [];
const run = (name, cmd, args, cwd, env) => { const c = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(c); for (const s of [c.stdout, c.stderr]) s.on('data', (d) => process.stdout.write(String(d).split('\n').filter(Boolean).map((l) => `[${name}] ${l}\n`).join(''))); c.on('exit', (code) => { console.log(`[${name}] exited (${code})`); }); return c; };
run('meet', process.execPath, ['server/index.js'], path.join(root, 'qorlla-meet-video'), { PORT: String(MEET_PORT), DATABASE_URL: `postgres://qorlla:${secrets.dbPassword}@127.0.0.1:${DB_PORT}/qorlla_meet`, JWT_SECRET: secrets.jwt, QORLLA_BRIDGE_SECRET: secrets.bridge, RECOVERY_ESCROW_KEY: secrets.escrow, NODE_ENV: 'development', RECORDING_MASTER_KEYS: JSON.stringify({ dev1: secrets.recordingKey }), RECORDING_ACTIVE_KEY_ID: 'dev1', RECORDING_STORE_DIR: path.join(state, 'recordings'), RETURN_ORIGINS: process.env.RETURN_ORIGINS || `http://localhost:${MAIN_PORT},http://127.0.0.1:${MAIN_PORT}` });
run('main', process.execPath, ['server.js'], root, { PORT: String(MAIN_PORT), DATA_DIR: path.join(state, 'data'), MEET_PROBE_URL: `http://127.0.0.1:${MEET_PORT}` });
console.log(`\nQorlla is starting:\n  app   http://localhost:${MAIN_PORT}/qorlla.html\n  Meet  http://localhost:${MEET_PORT}/   (New meeting opens it automatically)\n  Ctrl+C stops both. Meet's database keeps its data in the Docker volume qorlla-meet-dev-data.\n`);
const stop = () => { for (const c of children) try { c.kill(); } catch (e) { /* already gone */ } process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
