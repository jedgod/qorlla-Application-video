// QVE-02 / QVE-11 evidence: the engine's Redis link over TLS (rediss://) with a PRIVATE certificate authority and the least-privilege ACL user. Single machine, a disposable Redis container, certificates generated here.
// What it shows: TLS works with the authority trusted via NODE_EXTRA_CA_CERTS (no engine code change); without that trust the link is REFUSED, never silently downgraded; plaintext to the TLS port, and a wrong password,
// are refused; at engine level a Redis that cannot be trusted leaves the node serving (degraded) but never connected. It does NOT show: a real certificate chain, mutual TLS, Redis across hosts, Sentinel/cluster.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import tls from 'node:tls';
import { isolatedDb, wait } from './helpers.mjs';

const NAME = 'qorlla-voice-test-redis-tls', PORT = 26391, PW = 'tlspw' + Math.random().toString(36).slice(2, 10);
const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8' }), ssl = (...a) => spawnSync('openssl', a, { encoding: 'utf8' });
const BUS = pathToFileURL(path.resolve(import.meta.dirname, '../src/bus.mjs')).href;
let dir, ready = false, db;
before(async () => {
  if (docker('image', 'inspect', 'redis:7-alpine').status !== 0 || ssl('version').status !== 0) return;
  dir = mkdtempSync(path.join(tmpdir(), 'qv-tls-')); const f = (n) => path.join(dir, n);
  for (const step of [['genrsa', '-out', f('ca.key'), '2048'], ['req', '-x509', '-new', '-nodes', '-key', f('ca.key'), '-sha256', '-days', '2', '-subj', '/CN=Qorlla Test CA', '-out', f('ca.crt')],
    ['genrsa', '-out', f('server.key'), '2048'], ['req', '-new', '-key', f('server.key'), '-subj', '/CN=localhost', '-out', f('server.csr')]]) if (ssl(...step).status !== 0) return;
  writeFileSync(f('san.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  if (ssl('x509', '-req', '-in', f('server.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f('server.crt'), '-days', '2', '-sha256', '-extfile', f('san.cnf')).status !== 0) return;
  docker('rm', '-f', NAME);
  if (docker('run', '-d', '--name', NAME, '-p', `127.0.0.1:${PORT}:6380`, '-v', `${dir}:/tls:ro`, 'redis:7-alpine', 'redis-server', '--port', '0', '--tls-port', '6380', '--tls-cert-file', '/tls/server.crt', '--tls-key-file', '/tls/server.key', '--tls-ca-cert-file', '/tls/ca.crt', '--tls-auth-clients', 'no', '--requirepass', 'adminpw').status !== 0) return;
  const cli = (...a) => docker('exec', NAME, 'redis-cli', '--tls', '--cacert', '/tls/ca.crt', '-p', '6380', '-a', 'adminpw', '--no-auth-warning', ...a);
  for (let i = 0; i < 50 && !String(cli('ping').stdout).includes('PONG'); i++) await wait(100);
  ready = String(cli('ACL', 'SETUSER', 'voice', 'on', '>' + PW, 'resetchannels', '&qorlla:voice:v1:signals', '-@all', '+publish', '+subscribe', '+ping', '+hello', '+auth', '+client|setinfo', '+client|setname', '+quit').stdout).includes('OK');
  // the host side of the published port must really accept TLS before any test relies on it
  const reachable = () => new Promise((res) => { const s = tls.connect({ host: '127.0.0.1', port: PORT, servername: 'localhost', ca: readFileSync(f('ca.crt')) }, () => { s.end(); res(true); }); s.on('error', () => res(false)); s.setTimeout(1500, () => { s.destroy(); res(false); }); });
  for (let i = 0; i < 50 && ready && !(await reachable()); i++) await wait(200);
  db = await isolatedDb();
});
after(async () => { docker('rm', '-f', NAME); if (dir) rmSync(dir, { recursive: true, force: true }); if (db) await db.drop(); });
const skip = (t) => { if (!ready) { t.skip('docker, the redis image or openssl is unavailable'); return true; } return false; };

/** Runs two RedisBus instances in a FRESH Node process (NODE_EXTRA_CA_CERTS is read at startup) and reports whether they connected and exchanged a message. */
function bus(url, extra = {}) {
  const code = `import { RedisBus } from '${BUS}'; const got = [], errs = []; const mk = (id) => new RedisBus({ url: ${JSON.stringify(url)}, instanceId: id, onDelivery: (m) => got.push(m.payload), logger: { error: (...x) => errs.push(x.join(' ').slice(0, 120)) } });
    const a = mk('a'), b = mk('b'); a.start().catch(() => {}); b.start().catch(() => {}); await new Promise((r) => setTimeout(r, 3500)); let sent = false;
    if (a.up && b.up) { await a.publish('x', null, { hi: 1 }); sent = true; await new Promise((r) => setTimeout(r, 400)); }
    console.log(JSON.stringify({ aUp: a.up, bUp: b.up, sent, received: got.length, why: [...new Set(errs)].slice(0, 2) })); process.exit(0);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30000, env: { ...process.env, NODE_EXTRA_CA_CERTS: '', ...extra } });
  return JSON.parse(String(r.stdout).trim().split('\n').pop() || '{}');
}

test('TLS with the private authority trusted: both ends connect and a message crosses; the link is encrypted (the plaintext port is closed)', async (t) => {
  if (skip(t)) return;
  const r = bus(`rediss://voice:${PW}@localhost:${PORT}`, { NODE_EXTRA_CA_CERTS: path.join(dir, 'ca.crt') }); assert.deepEqual({ ...r, why: undefined }, { aUp: true, bUp: true, sent: true, received: 1, why: undefined }, JSON.stringify(r.why));
  const plain = bus(`redis://voice:${PW}@localhost:${PORT}`); assert.equal(plain.aUp, false, 'plaintext to the TLS port is refused'); assert.equal(plain.bUp, false);
});

test('without trust in the authority the link is refused (never silently downgraded); a wrong password is refused over TLS too', async (t) => {
  if (skip(t)) return;
  const untrusted = bus(`rediss://voice:${PW}@localhost:${PORT}`); assert.equal(untrusted.aUp, false, 'an untrusted certificate is not accepted'); assert.equal(untrusted.sent, false);
  const wrong = bus(`rediss://voice:wrong${PW}@localhost:${PORT}`, { NODE_EXTRA_CA_CERTS: path.join(dir, 'ca.crt') }); assert.equal(wrong.aUp, false, 'a wrong password is refused');
});

test('engine level: with the authority trusted the node reports Redis up; without it the node still serves (degraded) but is never connected, and says so', async (t) => {
  if (skip(t) || !db) return;
  const start = async (extra) => {
    const port = 4670 + Math.floor(Math.random() * 20), env = { ...process.env, NODE_EXTRA_CA_CERTS: '', PORT: String(port), DATABASE_URL: process.env.VOICE_TEST_DATABASE_URL || undefined, VOICE_ADMIN_SECRET: 'z'.repeat(40), VOICE_ALLOWED_ORIGIN: 'https://app.test', VOICE_JWKS_URL: 'http://127.0.0.1:1/jwks.json', REDIS_URL: `rediss://voice:${PW}@localhost:${PORT}`, ...extra };
    const { testDbUrl } = await import('./helpers.mjs'); env.DATABASE_URL = testDbUrl() + '?options=' + encodeURIComponent('-c search_path=' + db.schema);
    const child = spawn(process.execPath, ['src/server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), env, stdio: 'ignore' });
    let body = null; for (let i = 0; i < 60 && !body; i++) { await wait(250); body = await fetch(`http://127.0.0.1:${port}/readyz`).then((x) => x.json()).catch(() => null); }
    if (body) await wait(2500); body = await fetch(`http://127.0.0.1:${port}/readyz`).then((x) => x.json()).catch(() => null); child.kill(); await wait(300); return body;
  };
  const trusted = await start({ NODE_EXTRA_CA_CERTS: path.join(dir, 'ca.crt') }); assert.deepEqual([trusted.ok, trusted.redis, trusted.degraded], [true, 'up', []]);
  const untrusted = await start({}); assert.deepEqual([untrusted.ok, untrusted.redis, untrusted.degraded], [true, 'down', ['redis']], 'serving, but visibly degraded: an operator alert fires');
});
