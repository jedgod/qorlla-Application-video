// Starts the REAL Meet server (server/index.js) as a child process against disposable PostgreSQL databases.
// Needs SUBACC_TEST_ADMIN_URL (a superuser URL of a throwaway server). Each call creates and drops its own databases.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import pg from 'pg';
// Meet's own manifest is deliberately left untouched: the test-only socket client comes from the subscription package's devDependencies.
const { io: ioClient } = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'qorlla-subscription-access', 'package.json'))('socket.io-client');

const HERE = dirname(fileURLToPath(import.meta.url));
const MEET = join(HERE, '..', '..');
export const ADMIN_URL = process.env.SUBACC_TEST_ADMIN_URL;
export const skip = ADMIN_URL ? false : 'set SUBACC_TEST_ADMIN_URL (superuser URL of a disposable PostgreSQL) to run the Meet integration tests';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const SECRET = 'b'.repeat(40);
export const JWT = 'j'.repeat(40);

const withDb = (url, name) => { const u = new URL(url); u.pathname = '/' + name; return u.toString(); };

export async function createMeetDb() {
  const name = 'meet_' + randomBytes(4).toString('hex');
  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 }); admin.on('error', () => {});
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ connectionString: withDb(ADMIN_URL, name), max: 4 }); pool.on('error', () => {});
  for (const f of ['schema.sql', 'v3_migration.sql', '008_subscription.sql']) await pool.query(await readFile(join(MEET, 'sql', f), 'utf8'));
  return { name, url: withDb(ADMIN_URL, name), pool, async drop() { await pool.end().catch(() => {}); await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {}); await admin.end().catch(() => {}); } };
}

const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); s.on('error', rej); });

/** @returns {{ base, port, logs: string[], stop(): Promise<void>, exited: Promise<number|null> }} */
export async function startMeet({ meetUrl, env = {} }) {
  const port = await freePort();
  const logs = [];
  const proc = spawn(process.execPath, [join(MEET, 'server', 'index.js')], {
    cwd: MEET, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), DATABASE_URL: meetUrl, JWT_SECRET: JWT, QORLLA_BRIDGE_SECRET: SECRET, API_RATE_LIMIT: '1000000', BRIDGE_RATE_LIMIT: '1000000',
      JOIN_FAIL_PER_CLIENT: '100000', JOIN_FAIL_PER_MEETING: '100000', SOCKET_EVENT_BUDGET: '100000', NODE_ENV: 'test', ...env },
  });
  proc.stdout.on('data', (d) => logs.push(String(d))); proc.stderr.on('data', (d) => logs.push(String(d)));
  const exited = new Promise((r) => proc.on('exit', (code) => r(code)));
  const base = `http://127.0.0.1:${port}`;
  const up = await Promise.race([
    (async () => { for (let i = 0; i < 150; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) return true; } catch { /* not yet */ } await sleep(100); } return false; })(),
    exited.then(() => false),
  ]);
  return {
    base, port, logs, up, exited,
    async stop() { if (proc.exitCode === null) { proc.kill('SIGTERM'); await Promise.race([exited, sleep(3000)]); if (proc.exitCode === null) proc.kill('SIGKILL'); } },
  };
}

// ---- HTTP helpers -------------------------------------------------------------------------------------------------------------
export const http = (base) => {
  const j = async (method, path, body, headers = {}) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  return {
    j,
    anonymous: (title = 'Standup', name = 'Host') => j('POST', '/api/meetings', { title, name }),
    bridge: (body) => j('POST', '/api/integrations/scheduled-meetings', body, { 'x-qorlla-bridge-secret': SECRET }),
    join: (meetingId, name, hostSecret) => j('POST', `/api/meetings/${meetingId}/join`, { name, ...(hostSecret ? { hostSecret } : {}) }),
    get: (meetingId, token) => j('GET', `/api/meetings/${meetingId}`, undefined, { authorization: 'Bearer ' + token }),
  };
};

let seq = 0;
export const sourceId = () => `src-${Date.now()}-${++seq}`;

/** Connects a socket with a join token. Resolves {socket} on connect or {error} on a refusal. */
export function connectSocket(base, token) {
  return new Promise((resolve) => {
    const socket = ioClient(base, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    const events = [];
    socket.onAny((e, ...a) => events.push([e, ...a]));
    socket.once('connect', () => resolve({ socket, events }));
    socket.once('connect_error', (e) => { socket.close(); resolve({ error: e.message, events }); });
  });
}
