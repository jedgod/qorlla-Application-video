// Phase E: nginx reverse-proxy certification (HTTP + HTTPS, WebSockets, two-browser A/V, cookies, upstream failures,
// internal bridge isolation). Requires the stack from cert/README.md to be up (MAIN, worker, main DB, Meet DB).
// Usage: node cert/run-proxy-cert.mjs <cert.env>   -> writes cert/PROXY_EVIDENCE.json and cert/PROXY_EVIDENCE.md
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = process.argv[2];
if (!envFile) throw new Error('Usage: node cert/run-proxy-cert.mjs <cert.env>');
const ENV = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed test certificate only

const P = { mainHttp: 18080, meetHttp: 18081, mainTls: 18443, meetTls: 18444 };
const MAIN_S = `https://localhost:${P.mainTls}`, MEET_S = `https://localhost:${P.meetTls}`;
const MAIN_H = `http://localhost:${P.mainHttp}`, MEET_H = `http://localhost:${P.meetHttp}`;
const MEET_DIRECT = 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GIT = process.env.GIT_EXE || (fs.existsSync('C:/Program Files/Git/mingw64/bin/git.exe') ? 'C:/Program Files/Git/mingw64/bin/git.exe' : 'git');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: root, ...opts });
const docker = (...a) => sh('docker', a);
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
async function waitFor(fn, { timeout = 60000, every = 500, what = 'condition' } = {}) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; last = v; } catch (e) { last = e.message; } await sleep(every); }
  throw new Error(`Timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}
const results = [];
async function check(id, name, fn) {
  const t0 = new Date().toISOString();
  try { const detail = await fn(); results.push({ id, name, status: 'PASS', startedAt: t0, detail: detail ?? '' }); console.log('PASS', id, name); }
  catch (e) { const d = String(e.message || e) + (e.cause ? ' [cause: ' + (e.cause.code || e.cause.message) + ']' : ''); results.push({ id, name, status: 'FAIL', startedAt: t0, detail: d.slice(0, 600) }); console.log('FAIL', id, name, '-', d.slice(0, 300)); }
}

// ---------- environment for the proxy deployment ----------
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qproxy-'));
const certDir = path.join(scratch, 'certs'); fs.mkdirSync(certDir);
sh('docker', ['run', '--rm', '-v', `${certDir.replace(/\\/g, '/')}:/out`, 'alpine/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '/out/server.key', '-out', '/out/server.pem', '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
const proxyEnv = path.join(scratch, 'proxy.env');
fs.writeFileSync(proxyEnv, fs.readFileSync(envFile, 'utf8').trimEnd() + '\n' + [
  `PUBLIC_URL=${MAIN_S}`, `MEET_PUBLIC_URL=${MEET_S}/`,
  `PROXY_MAIN_PORT=${P.mainHttp}`, `PROXY_MEET_PORT=${P.meetHttp}`, `PROXY_MAIN_TLS_PORT=${P.mainTls}`, `PROXY_MEET_TLS_PORT=${P.meetTls}`,
  `PROXY_TLS_CONF=./deploy/nginx/tls.conf`, `PROXY_CERT_DIR=${certDir.replace(/\\/g, '/')}`].join('\n') + '\n');
const compose = (...a) => docker('compose', '--env-file', proxyEnv, '-p', 'qcert', ...a);
compose('up', '-d', '--build', '--force-recreate', 'workspace-signaling-engine', 'dashboard-client-proxy');
await waitFor(async () => (await fetch(`${MAIN_H}/api/health`)).ok, { timeout: 90000, what: 'MAIN through nginx' });

let meetProc = null;
function startMeet() {
  if (meetProc) return;
  const log = fs.openSync(path.join(root, 'cert', 'meet-proxy.log'), 'a');
  meetProc = spawn('node', ['server/index.js'], { cwd: path.join(root, 'qorlla-meet-video'), stdio: ['ignore', log, log],
    env: { ...process.env, PORT: '3000', DATABASE_URL: 'postgres://qorlla:qorlla_dev_only@127.0.0.1:25501/qorlla_meet', CORS_ORIGIN: MEET_S, JWT_SECRET: ENV.JWT_SECRET, QORLLA_BRIDGE_SECRET: ENV.QORLLA_BRIDGE_SECRET, RECOVERY_ESCROW_KEY: ENV.RECOVERY_ESCROW_KEY } });
}
async function stopMeet() { if (!meetProc) return; const p = meetProc; meetProc = null; await new Promise((r) => { p.once('exit', r); p.kill(); setTimeout(r, 3000); }); }
startMeet(); await waitFor(async () => (await fetch(`${MEET_DIRECT}/api/health`)).ok, { what: 'Meet up' });
await waitFor(async () => (await fetch(`${MEET_H}/api/health`)).ok, { what: 'Meet through nginx' });

class Main {
  constructor(base) { this.base = base; this.cookie = ''; }
  async req(method, url, body) {
    const r = await fetch(this.base + url, { method, headers: { 'content-type': 'application/json', cookie: this.cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie?.() || []; if (sc.length) this.cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; } return { status: r.status, data, setCookie: sc, headers: r.headers };
  }
}
const host = new Main(MAIN_S);
const reg = await host.req('POST', '/api/auth/register', { username: 'prx' + crypto.randomBytes(4).toString('hex'), displayName: 'Proxy Host', password: 'Proxy-Pass-' + crypto.randomBytes(5).toString('hex') + '!7' });
assert(reg.status === 201, 'register via TLS proxy failed: ' + reg.status);
const meetJoin = (base, id, body) => fetch(`${base}/api/meetings/${encodeURIComponent(id)}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

// ---------- tests ----------
await check('P01', 'HTTP routing: MAIN pages, assets and API through nginx', async () => {
  for (const u of ['/', '/login.html', '/index.html', '/qorlla.html', '/chat.html', '/Qorlla-Logo.jpg', '/api/health', '/meet-config.js']) { const r = await fetch(MAIN_H + u); assert(r.status === 200, `${u} -> ${r.status}`); }
  const cfg = await (await fetch(MAIN_H + '/meet-config.js')).text(); assert(cfg.includes(MEET_S), 'meet-config.js: ' + cfg);
});
await check('P02', 'HTTPS routing: MAIN over TLS 1.2+/HSTS; legacy TLS refused', async () => {
  for (const u of ['/', '/login.html', '/api/health']) { const r = await fetch(MAIN_S + u); assert(r.status === 200, `${u} -> ${r.status}`); }
  const r = await fetch(MAIN_S + '/'); assert(/max-age=\d+/.test(r.headers.get('strict-transport-security') || ''), 'no HSTS');
  const proto = await new Promise((res, rej) => { const s = tls.connect({ port: P.mainTls, host: 'localhost', rejectUnauthorized: false }, () => { res(s.getProtocol()); s.end(); }); s.on('error', rej); });
  assert(/TLSv1\.[23]/.test(proto), 'negotiated ' + proto);
  const legacyRefused = await new Promise((res) => { const s = tls.connect({ port: P.mainTls, host: 'localhost', rejectUnauthorized: false, maxVersion: 'TLSv1.1', minVersion: 'TLSv1' }, () => { res(false); s.end(); }); s.on('error', () => res(true)); });
  assert(legacyRefused, 'TLS 1.1 was accepted'); return 'negotiated ' + proto;
});
await check('P03', 'Meet reachable through nginx over HTTP and HTTPS', async () => {
  for (const base of [MEET_H, MEET_S]) { const r = await fetch(base + '/'); const t = await r.text(); assert(r.status === 200 && t.includes('Qorlla'), `${base} -> ${r.status}`); assert((await fetch(base + '/api/health')).status === 200, 'health'); assert((await fetch(base + '/app.js')).status === 200, 'app.js'); }
});
await check('P04', 'Internal bridge/recovery/readiness endpoints are NOT reachable through the public Meet proxy', async () => {
  const hdr = { 'x-qorlla-bridge-secret': ENV.QORLLA_BRIDGE_SECRET, 'content-type': 'application/json' };
  const probes = [['GET', '/api/integrations/scheduled-meetings/x'], ['POST', '/api/integrations/scheduled-meetings'], ['POST', '/api/integrations/scheduled-meetings/x/recover-host'], ['POST', '/api/integrations/scheduled-meetings/x/ack-host'], ['PATCH', '/api/integrations/scheduled-meetings/x'], ['POST', '/api/integrations/scheduled-meetings/x/cancel'], ['GET', '/api/ready']];
  for (const base of [MEET_H, MEET_S]) for (const [m, u] of probes) { const r = await fetch(base + u, { method: m, headers: hdr, body: m === 'GET' ? undefined : '{}' }); assert(r.status === 404, `${m} ${base}${u} -> ${r.status} (must be 404 even with the correct secret)`); }
  const control = await fetch(MEET_DIRECT + '/api/ready', { headers: hdr }); assert(control.status === 200, 'control: bridge works directly on the private port');
  return `${probes.length * 2} probes blocked; direct private access still works`;
});

const shots = path.join(root, 'cert', 'screenshots'); fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'] });
const newCtx = (loggedIn) => browser.newContext({ ignoreHTTPSErrors: true, baseURL: MAIN_S, permissions: ['camera', 'microphone'] }).then(async (ctx) => {
  if (loggedIn) await ctx.addCookies(host.cookie.split('; ').map((c) => ({ name: c.slice(0, c.indexOf('=')), value: c.slice(c.indexOf('=') + 1), url: MAIN_S })));
  return ctx;
});
const flowing = (p) => p.evaluate(() => [...document.querySelectorAll('.tile video')].filter((v) => v.srcObject && v.videoWidth > 0 && !v.paused).length);

let sched = null;
await check('P06', 'Scheduled, passcode-protected meeting: join from MAIN through the public proxy routes, then leave back to MAIN', async () => {
  const r = await host.req('POST', '/api/workplace/schedule', { title: 'Proxy passcode', date: '2026-12-02', time: '09:00', duration: 30, passcode: 'proxy-pass-1' });
  assert(r.status === 201, 'schedule ' + r.status);
  sched = await waitFor(async () => (await host.req('GET', '/api/workplace/schedule')).data.find((s) => s.id === r.data.id && s.syncStatus === 'synced'), { timeout: 90000, what: 'schedule synced' });
  const ctx = await newCtx(true); const page = await ctx.newPage();
  await page.goto('/'); await page.click('[data-view="schedule"]');
  await page.locator('.card.ev', { hasText: 'Proxy passcode' }).first().locator('button', { hasText: 'Join' }).click();
  await page.fill('#nm', 'Proxy Guest'); await page.click('#dlgGo');
  await page.waitForURL(new RegExp(`localhost:${P.meetTls}`)); assert(!/passcode=/.test(page.url()), 'passcode in URL');
  await page.waitForSelector('#joinBtn'); await page.fill('#joinPasscode', 'wrong-pass'); await page.click('#joinBtn');
  await page.waitForFunction(() => document.querySelector('#landingError').textContent.length > 0); assert(/passcode/i.test(await page.textContent('#landingError')), 'no passcode error');
  await page.fill('#joinPasscode', 'proxy-pass-1'); await page.click('#joinBtn'); await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
  await page.screenshot({ path: path.join(shots, 'P06-proxy-passcode.png') });
  await page.click('#leaveBtn'); await page.waitForURL(new RegExp(`localhost:${P.mainTls}`), { timeout: 15000 }); await ctx.close();
});
await check('P12', 'Passcode enforced through the proxy API (wrong/missing 403, correct 200)', async () => {
  const code = sched.meetCode;
  const w = await meetJoin(MEET_S, code, { name: 'x', passcode: 'nope-nope' }); const m = await meetJoin(MEET_S, code, { name: 'x' }); const ok = await meetJoin(MEET_S, code, { name: 'x', passcode: 'proxy-pass-1' });
  assert(w.status === 403 && m.status === 403 && ok.status === 200, `${w.status}/${m.status}/${ok.status}`);
});

let hostPage, guestPage, c1, c2; const wsEvents = [];
await check('P07', 'Two browsers over HTTPS: WebSocket upgrade, real media both ways, chat both ways', async () => {
  c1 = await newCtx(false); c2 = await newCtx(false); hostPage = await c1.newPage(); guestPage = await c2.newPage();
  for (const [who, pg] of [['host', hostPage], ['guest', guestPage]]) pg.on('websocket', (ws) => { const rec = { who, url: ws.url(), closed: false, frames: 0 }; wsEvents.push(rec); ws.on('framereceived', () => rec.frames++); ws.on('close', () => { rec.closed = true; }); });
  await hostPage.goto(MEET_S + '/'); await hostPage.fill('#displayName', 'Alice'); await hostPage.fill('#meetingTitle', 'Proxy call'); await hostPage.click('#createBtn'); await hostPage.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
  const code = await waitFor(async () => (await hostPage.textContent('#roomId')).trim(), { what: 'room code' }); assert(/^\d{12}$/.test(code), 'code ' + code);
  await guestPage.goto(MEET_S + '/'); await guestPage.fill('#displayName', 'Bob'); await guestPage.fill('#meetingId', code); await guestPage.click('#joinBtn'); await guestPage.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
  await waitFor(async () => (await flowing(hostPage)) >= 2 && (await flowing(guestPage)) >= 2, { timeout: 40000, what: 'video flowing both ways' });
  await hostPage.fill('#chatText', 'hi bob'); await hostPage.press('#chatText', 'Enter'); await waitFor(async () => (await guestPage.textContent('#messages')).includes('hi bob'), { what: 'chat h->g' });
  await guestPage.fill('#chatText', 'hi alice'); await guestPage.press('#chatText', 'Enter'); await waitFor(async () => (await hostPage.textContent('#messages')).includes('hi alice'), { what: 'chat g->h' });
  const sock = wsEvents.filter((w) => w.url.includes(`:${P.meetTls}/socket.io/`) && w.url.startsWith('wss://')); assert(sock.length >= 2, 'no wss socket.io upgrades seen through the proxy: ' + JSON.stringify(wsEvents.map((w) => w.url)));
  await hostPage.screenshot({ path: path.join(shots, 'P07-proxy-host.png') }); await guestPage.screenshot({ path: path.join(shots, 'P07-proxy-guest.png') });
  return `wss connections: ${sock.length}`;
});
await check('P11', 'Persistent connection survives past nginx default 60s idle (3600s proxy timeout) with no reconnect', async () => {
  const before = wsEvents.filter((w) => w.closed).length; await sleep(75000);
  assert(wsEvents.filter((w) => w.closed).length === before, 'a websocket closed during idle');
  await hostPage.fill('#chatText', 'after idle'); await hostPage.press('#chatText', 'Enter'); await waitFor(async () => (await guestPage.textContent('#messages')).includes('after idle'), { what: 'chat after 75s idle' });
});
await check('P08', 'Session reconnection: network drop, page refresh and meeting rejoin', async () => {
  await c2.setOffline(true); await sleep(4000); await c2.setOffline(false);
  await guestPage.fill('#chatText', 'back online'); await guestPage.press('#chatText', 'Enter'); await waitFor(async () => (await hostPage.textContent('#messages')).includes('back online'), { timeout: 40000, what: 'chat after reconnect' });
  await guestPage.reload(); await guestPage.waitForSelector('#app:not(.hidden)', { timeout: 30000 });
  await waitFor(async () => (await guestPage.textContent('#messages')).includes('hi bob'), { what: 'history restored after refresh' });
  await guestPage.fill('#chatText', 'rejoined'); await guestPage.press('#chatText', 'Enter'); await waitFor(async () => (await hostPage.textContent('#messages')).includes('rejoined'), { timeout: 30000, what: 'chat after rejoin' });
  await waitFor(async () => (await flowing(hostPage)) >= 2, { timeout: 40000, what: 'media renegotiated after rejoin' });
});
await c1?.close(); await c2?.close();
await check('P09', 'Authentication cookies through the proxy: HttpOnly, SameSite, Secure on HTTPS', async () => {
  const u = 'ck' + crypto.randomBytes(3).toString('hex'); const pw = 'Cookie-Pass-' + crypto.randomBytes(4).toString('hex') + '!5';
  const a = new Main(MAIN_S); await a.req('POST', '/api/auth/register', { username: u, displayName: 'C', password: pw });
  const l = await a.req('POST', '/api/auth/login', { username: u, password: pw }); const c = (l.setCookie.join(';;')).toLowerCase();
  assert(l.status === 200 && /httponly/.test(c) && /samesite=(lax|strict)/.test(c) && /secure/.test(c), 'cookie flags: ' + l.setCookie.join(' | ').replace(/=[^;]+/, '=<redacted>'));
  assert((await a.req('GET', '/api/auth/me')).data.user?.username === u, 'session did not persist through proxy');
  await a.req('POST', '/api/auth/logout'); assert((await a.req('GET', '/api/auth/me')).data.user === null, 'logout did not end session');
});
await check('P10', 'Upstream failures: Meet down -> fast 502; MAIN down -> fast 502; both recover without nginx restart', async () => {
  await stopMeet(); let t0 = Date.now(); let r = await fetch(MEET_S + '/'); const dt = Date.now() - t0; assert(r.status === 502 && dt < 8000, `Meet down -> ${r.status} in ${dt}ms`);
  startMeet(); await waitFor(async () => (await fetch(MEET_S + '/api/health')).status === 200, { timeout: 30000, what: 'Meet recovers behind nginx' });
  docker('stop', 'zoom_core_backend_instance'); t0 = Date.now(); r = await fetch(MAIN_S + '/api/health'); const dt2 = Date.now() - t0; assert([502, 503, 504].includes(r.status) && dt2 < 8000, `MAIN down -> ${r.status} in ${dt2}ms`);
  docker('start', 'zoom_core_backend_instance'); await waitFor(async () => (await fetch(MAIN_S + '/api/health')).status === 200, { timeout: 60000, what: 'MAIN recovers behind nginx' });
  return `Meet 502 in ${dt}ms; MAIN ${r.status} in ${dt2}ms`;
});

await browser.close(); await stopMeet();
const finished = new Date().toISOString();
const summary = { pass: results.filter((r) => r.status === 'PASS').length, fail: results.filter((r) => r.status === 'FAIL').length };
const sha = sh(GIT, ['rev-parse', 'HEAD']).trim();
fs.writeFileSync(path.join(root, 'cert', 'PROXY_EVIDENCE.json'), JSON.stringify({ finished, gitHeadSha: sha, ports: P, nginx: 'nginx:alpine via docker compose (nginx.conf + deploy/nginx/*)', summary, results }, null, 2));
fs.writeFileSync(path.join(root, 'cert', 'PROXY_EVIDENCE.md'), [`# nginx proxy certification`, ``, `- Finished: ${finished}`, `- Git HEAD: \`${sha}\``, `- Ports (host): MAIN http ${P.mainHttp} / tls ${P.mainTls}; Meet http ${P.meetHttp} / tls ${P.meetTls}`, `- Result: **${summary.pass} passed, ${summary.fail} failed**`, ``, `| ID | Result | Check | Detail |`, `|---|---|---|---|`, ...results.map((r) => `| ${r.id} | ${r.status} | ${r.name} | ${String(r.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`)].join('\n') + '\n');
console.log(JSON.stringify(summary)); process.exit(summary.fail ? 1 : 0);
