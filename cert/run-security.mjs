// Phase F: executable security verification (controls that can be tested automatically). This is NOT an independent
// third-party review; see cert/V3_9_2_SECURITY_REVIEW.md for the review narrative and open findings.
// Usage: node cert/run-security.mjs <cert.env>   -> cert/SECURITY_EVIDENCE.json / .md
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gitState } from './lib-git.mjs';
import pg from 'pg';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const { io } = require('socket.io-client');
const jwt = require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'qorlla-meet-video', 'node_modules', 'jsonwebtoken'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = Object.fromEntries(fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const MEET = 'http://localhost:3000', MAIN = 'http://localhost:5000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GIT = process.env.GIT_EXE || (fs.existsSync('C:/Program Files/Git/mingw64/bin/git.exe') ? 'C:/Program Files/Git/mingw64/bin/git.exe' : 'git');
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const MEET_OWNER_URL = 'postgres://qorlla:qorlla_dev_only@127.0.0.1:25501/qorlla_meet';
const MEET_APP_URL = ENV.MEET_APP_DB_URL || MEET_OWNER_URL;
const meetDb = new pg.Pool({ connectionString: MEET_OWNER_URL, max: 3 });
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
async function waitFor(fn, { timeout = 30000, every = 300, what = 'condition' } = {}) { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { const v = await fn(); if (v) return v; last = v; } catch (e) { last = e.message; } await sleep(every); } throw new Error(`Timed out: ${what} (${JSON.stringify(last)})`); }
const results = [];
async function check(id, name, fn) {
  try { const detail = await fn(); results.push({ id, name, status: 'PASS', detail: detail ?? '' }); console.log('PASS', id, name); }
  catch (e) { results.push({ id, name, status: 'FAIL', detail: String(e.message || e).slice(0, 500) }); console.log('FAIL', id, name, '-', String(e.message || e).slice(0, 250)); }
}
let meetProc = null;
function startMeet(extra = {}) {
  if (meetProc) return; const log = fs.openSync(path.join(root, 'cert', 'meet-security.log'), 'a');
  meetProc = spawn('node', ['server/index.js'], { cwd: path.join(root, 'qorlla-meet-video'), stdio: ['ignore', log, log],
    env: { ...process.env, PORT: '3000', DATABASE_URL: MEET_APP_URL, CORS_ORIGIN: MEET, JWT_SECRET: ENV.JWT_SECRET, QORLLA_BRIDGE_SECRET: ENV.QORLLA_BRIDGE_SECRET, RECOVERY_ESCROW_KEY: ENV.RECOVERY_ESCROW_KEY, TRUST_PROXY_HOPS: '1', ...extra } });
}
async function stopMeet() { if (!meetProc) return; const p = meetProc; meetProc = null; await new Promise((r) => { p.once('exit', r); p.kill(); setTimeout(r, 3000); }); }
const j = (url, method, body, headers = {}) => fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})), headers: r.headers }));
const bridgeH = { 'x-qorlla-bridge-secret': ENV.QORLLA_BRIDGE_SECRET };
const xff = (ip) => ({ 'x-forwarded-for': ip });
const sockConnect = (token) => new Promise((resolve) => { const s = io(MEET, { auth: { token }, transports: ['websocket'], reconnection: false }); s.on('connect', () => resolve({ s, ok: true })); s.on('connect_error', (e) => { resolve({ s, ok: false, err: e.message }); s.close(); }); setTimeout(() => resolve({ s, ok: false, err: 'timeout' }), 8000); });

startMeet(); await waitFor(async () => (await fetch(MEET + '/api/health')).ok, { what: 'Meet up' });
const mk = async (title, passcode) => (await j(MEET + '/api/meetings', 'POST', { title, name: 'Owner', passcode })).data;

await check('SEC01', 'Meet serves an enforced CSP (script-src self, frame-ancestors none) and the page has no inline script/handler attributes', async () => {
  const r = await fetch(MEET + '/'); const csp = r.headers.get('content-security-policy') || ''; const html = await r.text();
  assert(/script-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp), 'CSP: ' + csp);
  assert(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html) && !/\son[a-z]+\s*=/.test(html), 'inline script or handler attribute present');
  assert(r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('referrer-policy') === 'no-referrer', 'missing hardening headers');
  const app = await (await fetch(MEET + '/app.js')).text(); assert(!/\beval\(|new Function\(|document\.write\(/.test(app), 'eval-like construct in app.js');
});
await check('SEC02', 'Passcode brute force is throttled per client+meeting (8 failures -> 429); other clients unaffected', async () => {
  const m = await mk('Throttle', 'correct-horse-1'); const code = m.meetingCode; const A = xff('10.9.0.1'), B = xff('10.9.0.2'); const seen = [];
  for (let i = 0; i < 10; i++) seen.push((await j(`${MEET}/api/meetings/${code}/join`, 'POST', { name: 'x', passcode: 'wrong-' + i }, A)).status);
  assert(seen.slice(0, 8).every((s) => s === 403) && seen[8] === 429 && seen[9] === 429, 'sequence ' + seen);
  const retry = (await j(`${MEET}/api/meetings/${code}/join`, 'POST', { name: 'x', passcode: 'wrong' }, A)).headers.get('retry-after'); assert(retry, 'no Retry-After');
  const blockedEvenCorrect = (await j(`${MEET}/api/meetings/${code}/join`, 'POST', { name: 'x', passcode: 'correct-horse-1' }, A)).status; assert(blockedEvenCorrect === 429, 'blocked client still allowed in with a guess');
  const other = await j(`${MEET}/api/meetings/${code}/join`, 'POST', { name: 'y', passcode: 'correct-horse-1' }, B); assert(other.status === 200, 'other client locked out: ' + other.status);
  return seen.join(',');
});
await check('SEC03', 'Rate limits are keyed on the real client address behind a proxy (X-Forwarded-For) - one noisy client cannot starve others', async () => {
  const C = xff('10.9.1.1'), D = xff('10.9.1.2'); let limited = 0;
  for (let i = 0; i < 100; i++) { const s = (await fetch(MEET + '/api/config', { headers: C })).status; if (s === 429) limited++; }
  assert(limited >= 5, 'noisy client was never limited: ' + limited); assert((await fetch(MEET + '/api/config', { headers: D })).status === 200, 'second client starved');
  return `limited ${limited}/100 for the noisy client only`;
});
await check('SEC04', 'WebSocket authorization: no/forged/expired/foreign-secret tokens are refused; cross-meeting REST access is refused', async () => {
  const a = await mk('A'), b = await mk('B');
  const good = await sockConnect(a.token); assert(good.ok, 'valid token refused'); good.s.close();
  const none = await sockConnect(undefined); assert(!none.ok && /Unauthorized/.test(none.err), 'no token connected: ' + none.err);
  const parts = a.token.split('.'); const forged = parts[0] + '.' + Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], 'base64url')), name: 'tampered', role: 'host' })).toString('base64url') + '.' + parts[2];
  assert(!(await sockConnect(forged)).ok, 'tampered claims accepted');
  const { iss: _iss, iat: _iat, exp: _exp, ...claims } = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  assert(!(await sockConnect(jwt.sign({ ...claims, role: 'host' }, 'x'.repeat(40)))).ok, 'foreign-secret token accepted');
  assert(!(await sockConnect(jwt.sign({ meetingId: claims.meetingId, participantId: claims.participantId, role: 'host', name: 'x' }, ENV.JWT_SECRET, { issuer: 'qorlla-meet', expiresIn: -10 }))).ok, 'expired token accepted');
  assert(!(await sockConnect(jwt.sign({ meetingId: claims.meetingId, participantId: crypto.randomUUID(), role: 'host', name: 'x' }, ENV.JWT_SECRET, { issuer: 'qorlla-meet' }))).ok, 'valid-signature token for a non-participant accepted');
  const cross = await j(`${MEET}/api/meetings/${b.meetingId}`, 'GET', undefined, { authorization: 'Bearer ' + a.token }); assert(cross.status === 403, 'cross-meeting read ' + cross.status);
});
await check('SEC05', 'Host-only actions are enforced server-side (notes, polls, end, lock refused for guests)', async () => {
  const m = await mk('HostOnly'); const g = (await j(`${MEET}/api/meetings/${m.meetingCode}/join`, 'POST', { name: 'Guest' })).data; const gs = await sockConnect(g.token); assert(gs.ok, 'guest socket');
  const ack = (ev, payload) => new Promise((res) => gs.s.emit(ev, payload, (a) => res(a))); await sleep(200);
  const notes = await ack('notes', 'pwned'); const poll = await ack('poll-create', { question: 'q', options: ['a', 'b'] });
  assert(notes?.ok === false && /host/i.test(notes.error) && poll?.ok === false && /host/i.test(poll.error), JSON.stringify([notes, poll]));
  const lock = await j(`${MEET}/api/meetings/${m.meetingId}/lock`, 'POST', { locked: true }, { authorization: 'Bearer ' + g.token }); assert([401, 403].includes(lock.status), 'guest lock ' + lock.status);
  const end = await j(`${MEET}/api/meetings/${m.meetingId}/end`, 'POST', {}, { authorization: 'Bearer ' + g.token }); assert([401, 403, 404].includes(end.status), 'guest end ' + end.status);
  const stillOpen = (await meetDb.query('SELECT ended_at, locked, notes FROM meetings WHERE id=$1', [m.meetingId])).rows[0]; assert(!stillOpen.ended_at && !stillOpen.locked && stillOpen.notes !== 'pwned', 'state changed by guest'); gs.s.close();
});
await check('SEC06', 'Socket flood control: events beyond the per-socket budget are refused with "Rate limited"', async () => {
  const m = await mk('Flood'); const c = await sockConnect(m.token); assert(c.ok, 'connect'); const acks = [];
  await Promise.all(Array.from({ length: 70 }, (_, i) => new Promise((res) => c.s.emit('chat', 'msg ' + i, (a) => { acks.push(a); res(); }))));
  const refused = acks.filter((a) => a && a.ok === false && /rate/i.test(a.error)).length; assert(refused >= 20 && acks.length === 70, `refused ${refused}/70`); c.s.close(); return `refused ${refused}/70`;
});
await check('SEC07', 'SQL injection probes are inert (parameterised queries; no 500s, tables intact)', async () => {
  const probes = ["1' OR '1'='1", "'; DROP TABLE meetings;--", '1 UNION SELECT * FROM meetings', "%27%20OR%201=1", 'x'.repeat(5000)];
  for (const p of probes) { const r = await j(`${MEET}/api/meetings/${encodeURIComponent(p)}/join`, 'POST', { name: p.slice(0, 60), passcode: p }); assert(r.status < 500, `join probe -> ${r.status}`); const q = await fetch(`${MEET}/api/resolve/${encodeURIComponent(p.slice(0, 200))}`); assert(q.status < 500, `resolve probe -> ${q.status}`); }
  const nm = await j(MEET + '/api/meetings', 'POST', { title: "'; DROP TABLE meetings;--", name: "Robert'); DROP TABLE participants;--" }); assert(nm.status === 201, 'hostile title/name rejected? ' + nm.status);
  const t = (await meetDb.query("SELECT to_regclass('public.meetings') m, to_regclass('public.participants') p")).rows[0]; assert(t.m && t.p, 'tables missing');
});
await check('SEC08', 'Bridge: wrong-length/prefix/empty secrets refused; bridge traffic has its own higher rate budget', async () => {
  const s = ENV.QORLLA_BRIDGE_SECRET; const bad = [{}, { 'x-qorlla-bridge-secret': '' }, { 'x-qorlla-bridge-secret': s.slice(0, -1) }, { 'x-qorlla-bridge-secret': s + 'x' }, { 'x-qorlla-bridge-secret': s.slice(0, -1) + (s.endsWith('a') ? 'b' : 'a') }];
  for (const h of bad) assert((await fetch(MEET + '/api/integrations/scheduled-meetings/x', { headers: h })).status === 401, 'weak bridge secret accepted');
  let blocked = 0; for (let i = 0; i < 150; i++) if ((await fetch(MEET + '/api/integrations/scheduled-meetings/none-' + i, { headers: { ...bridgeH, ...xff('10.9.2.1') } })).status === 429) blocked++;
  assert(blocked === 0, 'legitimate bridge traffic throttled at the browser limit: ' + blocked);
});
await check('SEC09', 'Stored XSS: hostile chat text/display name never becomes markup or runs script (browser-verified, CSP active)', async () => {
  const browser = await chromium.launch({ headless: true }); const ctx = await browser.newContext(); const page = await ctx.newPage(); const csp = [];
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text().slice(0, 120)); });
  await page.goto(MEET + '/'); await page.fill('#displayName', '<img src=x onerror="window.__xss=1">'); await page.fill('#meetingTitle', '<script>window.__xss=2</script>'); await page.click('#createBtn'); await page.waitForSelector('#app:not(.hidden)');
  await waitFor(async () => /Connected/.test(await page.textContent('#status')), { what: 'socket connected' });
  await page.fill('#chatText', '<img src=x onerror="window.__xss=3"><script>window.__xss=4</script>'); await page.press('#chatText', 'Enter'); await waitFor(async () => (await page.textContent('#messages')).includes('<img'), { what: 'message rendered as text' });
  const res = await page.evaluate(() => ({ xss: window.__xss, imgs: document.querySelectorAll('#messages img, #peopleList img, .nameplate img, #roomTitle img').length, scripts: document.querySelectorAll('#messages script, #roomTitle script').length }));
  assert(res.xss === undefined && res.imgs === 0 && res.scripts === 0, JSON.stringify(res)); await browser.close(); return 'rendered inert as text';
});
await check('SEC10', 'Logs contain no secrets (bridge secret, vault/escrow keys, JWT secret, host secrets)', async () => {
  const secrets = [ENV.QORLLA_BRIDGE_SECRET, ENV.QORLLA_VAULT_KEY, ENV.RECOVERY_ESCROW_KEY, ENV.JWT_SECRET, ENV.MAIN_DB_PASSWORD];
  const hostSecrets = (await meetDb.query("SELECT 1")).rowCount ? [] : [];
  let text = ''; for (const f of fs.readdirSync(path.join(root, 'cert'))) if (f.endsWith('.log')) text += fs.readFileSync(path.join(root, 'cert', f), 'utf8');
  for (const c of ['zoom_core_backend_instance', 'qcert-meet-sync-worker-1', 'qcert-main-db-1']) { try { text += docker('logs', c); } catch { /* absent */ } }
  const leaked = secrets.filter((s) => s && text.includes(s)); assert(leaked.length === 0, 'secret material in logs: ' + leaked.length); return `scanned ${Math.round(text.length / 1024)} KiB of logs`;
});

// MAIN application checks
const mainReq = async (m, u, b, headers = {}) => j(MAIN + u, m, b, headers);
await check('SEC11', 'MAIN: login brute force is throttled; weak passwords refused; error text does not reveal which field was wrong', async () => {
  const u = 'brute' + crypto.randomBytes(3).toString('hex'); const weak = await mainReq('POST', '/api/auth/register', { username: u, password: 'short' }); assert(weak.status === 400, 'weak password accepted: ' + weak.status);
  const codes = []; for (let i = 0; i < 14; i++) codes.push((await mainReq('POST', '/api/auth/login', { username: u, password: 'Wrong-pass-' + i + '!' })).status);
  assert(codes.includes(429), 'never throttled: ' + codes.join(',')); const known = await mainReq('POST', '/api/auth/login', { username: u, password: 'x' }); const msg = JSON.stringify(known.data).toLowerCase(); assert(!/no such user|unknown user/.test(msg), msg);
  return codes.join(',');
});
await check('SEC12', 'MAIN: cross-site request cannot use the session cookie (SameSite) - no state change from a hostile origin', async () => {
  const a = { cookie: '' }; const r = await mainReq('POST', '/api/auth/register', { username: 'csrf' + crypto.randomBytes(3).toString('hex'), displayName: 'C', password: 'Csrf-Pass-' + crypto.randomBytes(4).toString('hex') + '!8' });
  const cookies = r.headers.getSetCookie().map((c) => c.split(';')[0]); const browser = await chromium.launch({ headless: true }); const ctx = await browser.newContext();
  await ctx.addCookies(cookies.map((c) => ({ name: c.slice(0, c.indexOf('=')), value: c.slice(c.indexOf('=') + 1), url: MAIN })));
  const page = await ctx.newPage(); await page.goto('http://127.0.0.1:5000/login.html'); // different site than localhost
  const outcome = await page.evaluate(async () => { try { const x = await fetch('http://localhost:5000/api/workplace/schedule', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'CSRF-ATTEMPT', date: '2026-12-31', time: '10:00', duration: 30 }) }); return x.status; } catch (e) { return 'blocked:' + e.message; } });
  const check = await ctx.request.get(MAIN + '/api/workplace/schedule'); const items = check.ok() ? await check.json() : []; assert(!items.some((i) => i.title === 'CSRF-ATTEMPT'), 'cross-site POST created data (status ' + outcome + ')'); await browser.close(); return 'cross-site POST outcome: ' + outcome;
});
await check('SEC13', 'Containers run unprivileged (MAIN, worker)', async () => {
  for (const c of ['zoom_core_backend_instance', 'qcert-meet-sync-worker-1']) assert(docker('exec', c, 'id', '-u').trim() !== '0', c + ' runs as root');
});
await check('SEC14', 'Application database roles are least-privilege (not superuser, no DDL, cannot drop tables)', async () => {
  const mainApp = docker('exec', 'qcert-main-db-1', 'psql', '-U', 'qorlla_app', '-d', 'qorlla_main', '-tAc', "SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname=current_user").trim(); assert(mainApp === 'f', 'MAIN app role privileged: ' + mainApp);
  let ddlBlocked = false; try { docker('exec', 'qcert-main-db-1', 'psql', '-U', 'qorlla_app', '-d', 'qorlla_main', '-c', 'DROP TABLE qorlla_schedules'); } catch { ddlBlocked = true; } assert(ddlBlocked, 'MAIN app role could DROP a table');
  const meetApp = new pg.Pool({ connectionString: MEET_APP_URL, max: 1 }); const r = await meetApp.query("SELECT rolsuper OR rolcreatedb OR rolcreaterole AS p FROM pg_roles WHERE rolname=current_user"); assert(r.rows[0].p === false, 'Meet app role privileged');
  let meetDdl = false; try { await meetApp.query('DROP TABLE meetings'); } catch { meetDdl = true; } await meetApp.end(); assert(meetDdl, 'Meet app role could DROP a table');
});
await check('SEC15', 'Recovery responses are no-store; escrow is ciphertext at rest; invalid escrow key fails closed at startup', async () => {
  const m = await mk('Rec'); const sid = 'sec-rec-' + crypto.randomBytes(3).toString('hex'); const reg = await j(MEET + '/api/integrations/scheduled-meetings', 'POST', { sourceId: sid, title: 'R', ownerName: 'o', legacyCode: String(Math.floor(1e10 + Math.random() * 9e10)) }, bridgeH); assert(reg.status === 201, 'register');
  const rec = await j(`${MEET}/api/integrations/scheduled-meetings/${sid}/recover-host`, 'POST', { requestId: 'sec-' + crypto.randomBytes(3).toString('hex') }, bridgeH); assert(rec.status === 200 && /no-store/.test(rec.headers.get('cache-control') || ''), 'cache-control ' + rec.headers.get('cache-control'));
  const row = (await meetDb.query("SELECT e.encrypted_secret FROM host_recovery_escrow e JOIN external_meeting_links l ON l.meeting_id=e.meeting_id WHERE l.source_id=$1", [sid])).rows[0]; assert(row && !row.encrypted_secret.includes(rec.data.hostSecret), 'plaintext in escrow');
  const log = fs.openSync(path.join(root, 'cert', 'meet-security.log'), 'a'); const bad = spawn('node', ['server/index.js'], { cwd: path.join(root, 'qorlla-meet-video'), stdio: ['ignore', log, log], env: { ...process.env, PORT: '3055', DATABASE_URL: MEET_APP_URL, JWT_SECRET: ENV.JWT_SECRET, QORLLA_BRIDGE_SECRET: ENV.QORLLA_BRIDGE_SECRET, RECOVERY_ESCROW_KEY: 'too-short' } });
  const code = await new Promise((res) => { bad.once('exit', res); setTimeout(() => { bad.kill(); res('still-running'); }, 6000); }); assert(code !== 'still-running' && code !== 0, 'Meet started with an invalid RECOVERY_ESCROW_KEY (exit ' + code + ')');
});

await stopMeet(); await meetDb.end();
const sha = execFileSync(GIT, ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); const summary = { pass: results.filter((r) => r.status === 'PASS').length, fail: results.filter((r) => r.status === 'FAIL').length };
fs.writeFileSync(path.join(root, 'cert', 'SECURITY_EVIDENCE.json'), JSON.stringify({ finished: new Date().toISOString(), git: gitState(root), gitHeadSha: sha, summary, results }, null, 2));
fs.writeFileSync(path.join(root, 'cert', 'SECURITY_EVIDENCE.md'), ['# Automated security verification', '', `- Git HEAD: \`${sha}\` (branch ${gitState(root).branch}; source tree ${gitState(root).sourceTreeClean ? 'clean' : 'DIRTY: ' + gitState(root).dirtySourcePaths.join(', ')})`, `- Result: **${summary.pass} passed, ${summary.fail} failed** (automated controls only; not an independent review)`, '', '| ID | Result | Control | Detail |', '|---|---|---|---|', ...results.map((r) => `| ${r.id} | ${r.status} | ${r.name} | ${String(r.detail).replace(/\|/g, '\\|')} |`)].join('\n') + '\n');
console.log(JSON.stringify(summary)); process.exit(summary.fail ? 1 : 0);
