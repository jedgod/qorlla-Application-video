// Shared harness for the v1.2-v1.5 tests: engine replicas on real PostgreSQL (isolated schema), a disposable real Redis (our own docker container, never anyone else's), and tiny clients.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createStore } from '../src/store.mjs';
import { makeAuthenticator } from '../src/auth.mjs';
import { createVoiceApp } from '../src/app.mjs';
import { PROTOCOL } from '../src/tickets.mjs';
import { wait } from './helpers.mjs';

export const ORIGIN = 'https://app.qorlla.test', ADMIN = 'a'.repeat(40);
export const SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
export const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(25); } return null; };

const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
/** A disposable Redis in a docker container of our own (qorlla-voice-test-redis, 127.0.0.1:26379). Returns null if docker or the image is unavailable. */
export function redisContainer() {
  const NAME = 'qorlla-voice-test-redis', PORT = 26379;
  if (docker('version', '--format', '{{.Server.Version}}').status !== 0) return null;
  if (docker('image', 'inspect', 'redis:7-alpine').status !== 0) return null;
  docker('rm', '-f', NAME);
  if (docker('run', '-d', '--name', NAME, '-p', `127.0.0.1:${PORT}:6379`, 'redis:7-alpine').status !== 0) return null;
  const ping = async () => { for (let i = 0; i < 50; i++) { if (docker('exec', NAME, 'redis-cli', 'ping').stdout.includes('PONG')) return true; await wait(100); } return false; };
  return { url: `redis://127.0.0.1:${PORT}`, ping, stop: () => docker('stop', '-t', '0', NAME), start: () => docker('start', NAME), remove: () => docker('rm', '-f', NAME) };
}

export function harness({ db, idp }) {
  const devices = new Map(), replicas = [];
  const device = (account, name = 'd1') => { const k = account + ':' + name; if (!devices.has(k)) devices.set(k, randomUUID()); return devices.get(k); };
  async function replica({ redisUrl, env: extra = {}, maintenanceMs = 150, outbox = true, maintenance = true, instanceId } = {}) {
    const env = { VOICE_JWKS_URL: idp.jwksUrl, VOICE_JWT_ISSUER: 'qorlla-main', VOICE_JWT_AUDIENCE: 'qorlla-voice', VOICE_ALLOWED_ORIGIN: ORIGIN, VOICE_ADMIN_SECRET: ADMIN, VOICE_RING_SECONDS: '5', VOICE_OUTBOX_INTERVAL_MS: '100', ...(redisUrl ? { REDIS_URL: redisUrl } : {}), ...extra };
    const voice = createVoiceApp({ store: createStore(db.pool), db: db.pool, authenticate: makeAuthenticator(env), env, maintenanceMs, outbox, maintenance, instanceId });
    const port = await voice.listen(0, '127.0.0.1'), base = 'http://127.0.0.1:' + port, sockets = [];
    const api = async (account, method, path, body, o = {}) => {
      const headers = { 'content-type': 'application/json', origin: ORIGIN, ...(o.headers || {}) }; if (account) headers.authorization = 'Bearer ' + await idp.token(account);
      const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
    };
    const admin = (method, path, body) => fetch(base + '/v1/voice/admin' + path, { method, headers: { 'content-type': 'application/json', 'x-voice-admin-secret': ADMIN }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    /** Opens a signaling socket as one device of an account (the ticket is bound to that device). Collects every message in `inbox`. */
    async function connect(account, name = 'd1', { resumeAfter } = {}) {
      const deviceId = device(account, name), t = (await api(account, 'POST', '/v1/voice/ws-ticket', { deviceId })).body.ticket;
      const ws = new WebSocket('ws://127.0.0.1:' + port + '/v1/voice/ws', [PROTOCOL, 'ticket.' + t], { origin: ORIGIN }), inbox = [];
      ws.on('message', (m) => inbox.push(JSON.parse(m.toString())));
      await new Promise((res, rej) => { ws.once('open', res); ws.once('unexpected-response', (_q, r) => rej(new Error('http_' + r.statusCode))); ws.once('error', (e) => rej(e)); });
      const c = { ws, inbox, deviceId, account, closed: new Promise((r) => ws.once('close', (code) => r(code))), send: (m) => ws.send(JSON.stringify(m)), of: (type, pred = () => true) => inbox.filter((m) => m.type === type && pred(m)), close: () => { try { ws.close(); } catch { /* gone */ } } };
      sockets.push(c); await until(() => c.of('ready')[0]); if (resumeAfter !== undefined) c.send({ type: 'resume', after: resumeAfter }); return c;
    }
    const dial = (from, ext, name = 'd1', key) => api(from, 'POST', '/v1/voice/calls', { extension: ext, idempotencyKey: key || 'key-' + randomUUID(), deviceId: device(from, name) });
    const answer = (callId, account, name = 'd1') => api(account, 'POST', `/v1/voice/calls/${callId}/answer`, { deviceId: device(account, name) });
    const handle = { voice, base, port, env, api, admin, connect, dial, answer, device, instanceId: voice.instanceId, sockets, async stop() { sockets.forEach((s) => s.close()); await voice.close(); } };
    replicas.push(handle); return handle;
  }
  async function people(r, names) { const out = {}; for (const n of names) out[n] = (await r.admin('POST', '/identities', { accountId: n })).body.identity.extension; return out; }
  return { device, replica, people, closeAll: async () => { for (const r of replicas) await r.stop().catch(() => {}); } };
}
