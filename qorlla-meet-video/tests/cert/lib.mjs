// Shared helpers of the M1.3 certification suites (tests/cert/*.cert.mjs). Each suite prints PASS/FAIL lines and writes a JSON evidence file (EVIDENCE_DIR, default docs/evidence/m13).
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import pg from 'pg';
import { createRelayAuthority } from '../../server/relay-authority.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..', '..'), SQL = join(ROOT, 'sql');
export const PG_URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25690/postgres';
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];

export function secrets() {
  const f = join(HERE, '.relay-secrets.env'); if (!existsSync(f)) { console.error('start the hardened relay first:  LAN_IP=<lan> tests/cert/relay-hardened-up.sh'); process.exit(2); }
  return Object.fromEntries(readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
}
const S = secrets();
export const CERT = {
  lan: S.LAN_IP, realm: 'qorlla.cert', turnPort: 34791, tlsPort: 34792, relayIp: '172.29.98.10', redisIp: '172.29.98.5',
  redis: { host: '127.0.0.1', port: 36391, password: S.RELAY_REDIS_PASSWORD }, cli: { host: '127.0.0.1', port: 35791, password: S.RELAY_CLI_PASSWORD },
  turnUrl: `turn:${S.LAN_IP}:34791?transport=udp`,
};
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 20000, step = 200) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await wait(step); } return null; }
export const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' }, timeout: 60000 }).trim();
export const pctl = (xs, p) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil(p / 100 * a.length) - 1)]; };

export function reporter(suite) {
  const results = [], notes = [], metrics = {};
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: String(detail) }); console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '   [' + detail + ']' : '')); return !!ok; };
  const note = (t) => { notes.push(t); console.log('  OBSERVED ' + t); };
  const finish = () => {
    const dir = process.env.EVIDENCE_DIR || join(ROOT, 'docs', 'evidence', 'm13'); mkdirSync(dir, { recursive: true });
    const failed = results.filter((r) => !r.ok); const out = { suite, at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, failed: failed.map((f) => f.name), metrics, notes, results, run: process.env.CERT_RUN || '1' };
    writeFileSync(join(dir, `${suite}.run${out.run}.json`), JSON.stringify(out, null, 1)); console.log(`\n${suite}: ${out.passed}/${out.total} passed` + (failed.length ? '\nFAILED:\n  ' + failed.map((f) => f.name).join('\n  ') : '')); process.exit(failed.length ? 1 : 0);
  };
  return { check, note, finish, metrics };
}

/** A fresh database with every migration applied. */
export async function newDb() {
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 }), name = 'm13_' + Math.random().toString(36).slice(2, 8);
  await admin.query('CREATE DATABASE ' + name); const url = PG_URL.replace(/\/[^/]*$/, '/' + name), pool = new pg.Pool({ connectionString: url, max: 6 });
  for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8'));
  return { pool, url, drop: async () => { await pool.end().catch(() => {}); await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {}); await admin.end().catch(() => {}); } };
}
export const authority = (db, extra = {}) => createRelayAuthority({ db, redis: CERT.redis, cli: CERT.cli, realm: CERT.realm, ttlSeconds: 300, ...extra });

/** A real Meet server (ASCS + relay on, hardened relay) on `dbUrl`. */
export async function bootMeet({ port, dbUrl, env = {}, expectExit = false }) {
  const e = { ...process.env, PORT: String(port), DATABASE_URL: dbUrl, JWT_SECRET: 'cert-secret-cert-secret-cert-secret-0123456789', ASCS_ENABLED: 'true', ASCS_RELAY_ENABLED: 'true', ASCS_LEASE_MS: '8000', ASCS_SWEEP_MS: '1000',
    RELAY_REDIS_HOST: CERT.redis.host, RELAY_REDIS_PORT: String(CERT.redis.port), RELAY_REDIS_PASSWORD: CERT.redis.password, RELAY_CLI_HOST: CERT.cli.host, RELAY_CLI_PORT: String(CERT.cli.port), RELAY_CLI_PASSWORD: CERT.cli.password,
    RELAY_REALM: CERT.realm, RELAY_TURN_URLS: CERT.turnUrl, QORLLA_BRIDGE_SECRET: 'cert-bridge-secret-cert-bridge-secret-0123456789', RELAY_CREDENTIAL_TTL_SECONDS: '300', API_RATE_LIMIT: '100000', MEETING_RATE_LIMIT: '100000', SOCKET_EVENT_BUDGET: '100000', ...env };
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: e, stdio: ['ignore', 'pipe', 'pipe'] }); let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  for (let i = 0; i < 240 && !log.includes('listening'); i++) { await wait(250); if (child.exitCode !== null) break; }
  if (expectExit) { const code = child.exitCode ?? (await Promise.race([exited, wait(5000).then(() => null)])); try { child.kill(); } catch { /* gone */ } return { exited: code !== null, code, log }; }
  if (!log.includes('listening')) { try { child.kill(); } catch { /* gone */ } throw new Error('Meet did not start: ' + log.slice(-500)); }
  (globalThis.__meetLogs ||= []).push({ port, log: () => log });
  return { base: `http://127.0.0.1:${port}`, pid: child.pid, log: () => log, kill: (sig = 'SIGKILL') => child.kill(sig), stop: async () => { child.kill(); await Promise.race([exited, wait(3000)]); } };
}
export const http = (base) => async (method, path, token, body, extraHeaders = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000) });
  const text = await r.text(); let b; try { b = JSON.parse(text); } catch { b = text; } return { status: r.status, body: b };
};
export function playwright() { return createRequire(join(process.env.PLAYWRIGHT_DIR || process.cwd(), 'package.json'))('playwright'); }

// ---- raw media pair through the relay (presenter -> viewer), for suites that obtain credentials from Meet's own API
import { TurnClient } from '../lib/turn-client.mjs';
export const OPS_SECRET = 'cert-bridge-secret-cert-bridge-secret-0123456789';
const fromApi = (r) => ({ username: r.iceServers[0].username, password: r.iceServers[0].credential, realm: CERT.realm });
export const credFromApi = fromApi;
export async function openAlloc(cred, proto = 'udp') { const c = await TurnClient.open({ host: CERT.lan, port: proto === 'tls' ? CERT.tlsPort : CERT.turnPort, proto, tlsInsecure: true }); const r = await c.allocate(cred); return { c, r }; }
/** presenter A -> viewer B at ~64-100 packets/s; returns { rx, flowing(ms), stop() } */
export async function mediaPair(pcred, vcred) {
  const a = await openAlloc(pcred), b = await openAlloc(vcred); if (!a.r.ok || !b.r.ok) { a.c.close(); b.c.close(); throw new Error('pair allocation failed: ' + a.r.code + '/' + b.r.code); }
  for (const x of [a, b]) { const p = await x.c.createPermission(CERT.relayIp); if (!p.ok) throw new Error('permission ' + p.code); }
  const rx = []; b.c.onData = (d) => rx.push({ seq: d.data.readUInt32BE(0), at: d.at }); let seq = 0;
  const timer = setInterval(() => { const buf = Buffer.alloc(1000); buf.writeUInt32BE(seq++, 0); a.c.send(b.r.relayed.ip, b.r.relayed.port, buf); }, 10);
  return { a, b, rx, flowing: async (ms = 1500) => { const n0 = rx.length; await wait(ms); return rx.length - n0; }, stop: () => { clearInterval(timer); a.c.close(); b.c.close(); } };
}
