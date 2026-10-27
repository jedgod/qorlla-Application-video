const { test, expect, request: pwRequest } = require('@playwright/test');
const { io } = require('socket.io-client');
const { spawn } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');

// Real MAIN processes (own data directory, own port) so restarts are real. Default rate limits are in force (no test override).
let nextPort = 5310 + Math.floor(Math.random() * 400);
async function start(dir, extraEnv = {}) {
  const port = nextPort++; const env = { ...process.env, PORT: String(port), DATA_DIR: dir, ...extraEnv }; delete env.GUEST_RATE_LIMIT_MAX; delete env.DATABASE_URL;
  const logPath = path.join(dir, 'server.log'); const fd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', fd, fd] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch (e) { /* not up yet */ } await new Promise((r) => setTimeout(r, 150)); }
  return { base, port, logPath, log: () => fs.readFileSync(logPath, 'utf8'), stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }) };
}
const ctx = (base, extra = {}) => pwRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base, ...extra } });
const mkFull = async (base, passcode) => { const a = await ctx(base); const body = await (await a.post('/api/meetings/create', { data: { topic: 'Lockout', hostId: 'usr_x', passcode } })).json(); return { id: body.meeting.meetingId, hostKey: body.hostKey }; };
const attempt = (api, id, passcode, extra = {}) => api.post('/api/guest/sessions', { data: { meetingId: id, displayName: 'G', passcode, ...extra } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qorlla-srv-'));

test.describe.configure({ mode: 'serial' });

test('restart persistence on a real server: four failures survive, the fifth locks, a restart cannot clear it, a correct passcode is refused while locked', async () => {
  test.setTimeout(120000);
  const dir = tmp(); let s = await start(dir); const m = await mkFull(s.base, 'right-code'); await new Promise((r) => setTimeout(r, 900));   // snapshot debounce
  const g = await ctx(s.base);
  for (let i = 0; i < 4; i++) expect((await attempt(g, m.id, 'bad' + i)).status()).toBe(403);
  await s.stop(); s = await start(dir); const g2 = await ctx(s.base);
  expect((await attempt(g2, m.id, 'bad-5th')).status()).toBe(429);                       // fifth failure (counted across the restart) locks
  expect((await attempt(g2, m.id, 'right-code')).status()).toBe(429);                    // correct passcode refused while locked
  await s.stop(); s = await start(dir); const g3 = await ctx(s.base);
  const r = await attempt(g3, m.id, 'right-code'); expect(r.status()).toBe(429); expect((await r.json()).error).toMatch(/locked/i);
  expect((await attempt(g3, m.id, undefined, { hostKey: m.hostKey })).status()).toBe(201);   // the host is never locked out of their own meeting
  await s.stop();
});

test('REST and WebSocket enforce one policy: sockets cannot be used to guess, and a guest and an account share the same budget', async () => {
  test.setTimeout(120000);
  const dir = tmp(); const s = await start(dir); const m = await mkFull(s.base, 'door-code');
  const acct = await ctx(s.base); const username = ('ws' + Math.random().toString(36).slice(2, 8));
  expect((await acct.post('/api/auth/register', { data: { username, displayName: 'WS', password: 'Socket-pass-9917!x' } })).status()).toBe(201);
  const cookie = (await acct.storageState()).cookies.map((c) => c.name + '=' + c.value).join('; ');
  const sock = io(s.base, { transports: ['websocket'], forceNew: true, extraHeaders: { cookie } }); await new Promise((r) => sock.once('connect', r));
  for (let i = 0; i < 12; i++) {                                                             // socket join has no passcode path: always refused, never counts
    const denied = new Promise((r) => sock.once('error_response', r)); sock.emit('join_room', { meetingId: m.id, userName: 'x', passcode: 'door-code' }); expect((await denied).code).toBe('passcode_required');
  }
  const g = await ctx(s.base);
  expect((await attempt(g, m.id, 'g1')).status()).toBe(403); expect((await attempt(acct, m.id, 'a1')).status()).toBe(403);
  expect((await attempt(g, m.id, 'g2')).status()).toBe(403); expect((await attempt(acct, m.id, 'a2')).status()).toBe(403);
  expect((await attempt(g, m.id, 'g3')).status()).toBe(429);                                  // 5th failure overall, across guest and account
  expect((await attempt(acct, m.id, 'door-code')).status()).toBe(429);
  const denied = new Promise((r) => sock.once('error_response', r)); sock.emit('join_room', { meetingId: m.id, userName: 'x' }); expect((await denied).code).toBe('passcode_required');
  sock.close(); await s.stop();
});

test('host recovery: host-only, authenticated, rate limited, audited; clears only the lock and never exposes the passcode', async () => {
  test.setTimeout(120000);
  const s = await start(tmp()); const m = await mkFull(s.base, 'recover-me'); const url = `/api/meetings/${encodeURIComponent(m.id)}`;
  const attacker = await ctx(s.base); for (let i = 0; i < 5; i++) await attempt(attacker, m.id, 'guess' + i);
  expect((await attempt(attacker, m.id, 'recover-me')).status()).toBe(429);
  expect((await (await ctx(s.base)).post(`${url}/passcode-lockout/clear`, { data: {} })).status()).toBe(401);                    // anonymous
  const bystander = await ctx(s.base); const gm = await mkFull(s.base); expect((await attempt(bystander, gm.id, undefined)).status()).toBe(201);
  expect((await bystander.post(`${url}/passcode-lockout/clear`, { data: {} })).status()).toBe(403);                              // a guest of another meeting
  const host = await ctx(s.base); expect((await attempt(host, m.id, undefined, { hostKey: m.hostKey })).status()).toBe(201);
  const evil = await pwRequest.newContext({ baseURL: s.base, extraHTTPHeaders: { origin: 'https://evil.example', cookie: (await host.storageState()).cookies.map((c) => c.name + '=' + c.value).join('; ') } });
  expect((await evil.post(`${url}/passcode-lockout/clear`, { data: {} })).status()).toBe(403);                                   // cross-site request
  expect((await bystander.get(`${url}/passcode-security`)).status()).toBe(403);
  const status = await (await host.get(`${url}/passcode-security`)).json(); expect(status.locked).toBe(true); expect(status.events.some((e) => e.kind === 'locked')).toBe(true); expect(status.events.some((e) => e.kind === 'clear_rejected')).toBe(true);
  const cleared = await host.post(`${url}/passcode-lockout/clear`, { data: {} }); expect(cleared.status()).toBe(200);
  const text = await cleared.text(); expect(text).not.toMatch(/recover-me|passcode":|hash/i); expect(JSON.parse(text)).toEqual({ cleared: true, wasLocked: true });
  expect((await attempt(attacker, m.id, 'recover-me')).status()).toBe(201);                                                      // the same passcode still works: it was never changed
  const after = await (await host.get(`${url}/passcode-security`)).json(); expect(after.locked).toBe(false); expect(after.events.map((e) => e.kind).filter((k) => k !== 'clear_rejected')).toEqual(['cleared_by_host', 'locked']);
  expect(JSON.stringify(after)).not.toMatch(/127\.0\.0\.1|::1|usr_/);                                                            // events hold no addresses
  for (let i = 0; i < 2; i++) expect((await host.post(`${url}/passcode-lockout/clear`, { data: {} })).status()).toBe(200);
  const fourth = await host.post(`${url}/passcode-lockout/clear`, { data: {} }); expect(fourth.status()).toBe(429); expect(Number(fourth.headers()['retry-after'])).toBeGreaterThan(0);   // 3 per hour, durable
  await s.stop();
});

test('a corrupt lockout file fails closed: the join is refused with 503 and no session is issued', async () => {
  const dir = tmp(); let s = await start(dir); const m = await mkFull(s.base, 'safe-code'); const g = await ctx(s.base);
  expect((await attempt(g, m.id, 'nope')).status()).toBe(403);
  fs.writeFileSync(path.join(dir, 'auth', 'passcode-lockout.json'), '\u0000\u0000garbage');
  const r = await attempt(g, m.id, 'safe-code'); expect(r.status()).toBe(503); expect(r.headers()['set-cookie']).toBeUndefined();
  expect((await g.get('/api/guest/sessions/me')).status()).toBe(401);
  await s.stop();
});

test('invitation abuse: header-injection addresses are refused, recipient limits hold, the endpoint is rate limited, links carry no secrets', async () => {
  const s = await start(tmp()); const m = await mkFull(s.base); const host = await ctx(s.base); await attempt(host, m.id, undefined, { hostKey: m.hostKey });
  const url = `/api/meetings/${encodeURIComponent(m.id)}/invite`;
  expect((await host.post(url, { data: { emails: ['a@example.com\r\nBcc: victim@example.com'] } })).status()).toBe(400);
  expect((await host.post(url, { data: { emails: ['a@example.com,b@example.com'] } })).status()).toBe(400);
  expect((await host.post(url, { data: { emails: Array.from({ length: 21 }, (_, i) => `u${i}@example.com`) } })).status()).toBe(400);
  const ok = await host.post(url, { data: { emails: ['a@example.com'] } }); expect(ok.status()).toBe(503);                      // no SMTP: honest refusal
  expect(await ok.text()).not.toContain(m.hostKey);
  for (let i = 0; i < 6; i++) await host.post(url, { data: { emails: [] } });
  expect((await host.post(url, { data: { emails: ['a@example.com'] } })).status()).toBe(429);                                   // 10 per hour
  await s.stop();
});

test('cross-origin and cookie posture of the guest endpoints', async () => {
  const s = await start(tmp()); const m = await mkFull(s.base);
  const pre = await (await pwRequest.newContext({ baseURL: s.base })).fetch('/api/guest/sessions', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  expect(pre.headers()['access-control-allow-credentials']).toBeUndefined();                                                    // cookies are never granted to another origin
  const evil = await pwRequest.newContext({ baseURL: s.base, extraHTTPHeaders: { origin: 'https://evil.example' } });
  expect((await attempt(evil, m.id, undefined)).status()).toBe(403);
  const g = await ctx(s.base); const r = await attempt(g, m.id, undefined); expect(r.headers()['set-cookie']).toMatch(/HttpOnly.*SameSite=Strict|SameSite=Strict.*HttpOnly/);
  expect(r.headers()['cache-control']).toContain('no-store');
  await s.stop();
});

test('passwords: recovery codes are single use, and changing the password ends the other sessions', async () => {
  const s = await start(tmp()); const a = await ctx(s.base); const username = 'pw' + Math.random().toString(36).slice(2, 8);
  const reg = await a.post('/api/auth/register', { data: { username, displayName: 'PW', password: 'First-pass-9917!x' } }); expect(reg.status()).toBe(201);
  const codes = (await reg.json()).recoveryCodes; const code = typeof codes[0] === 'string' ? codes[0] : codes[0].code;
  const phone = await ctx(s.base); expect((await phone.post('/api/auth/login', { data: { username, password: 'First-pass-9917!x' } })).status()).toBe(200);
  expect((await (await phone.get('/api/auth/me')).json()).user).toBeTruthy();
  expect((await a.post('/api/auth/password', { data: { currentPassword: 'First-pass-9917!x', password: 'Second-pass-9917!x' } })).status()).toBe(200);
  expect((await (await phone.get('/api/auth/me')).json()).user).toBeNull();                                                                  // the other device was signed out
  const anon = await ctx(s.base);
  expect((await anon.post('/api/auth/recover', { data: { username, code, password: 'Third-pass-9917!x' } })).status()).toBe(200);
  expect((await anon.post('/api/auth/recover', { data: { username, code, password: 'Fourth-pass-9917!x' } })).status()).toBe(401); // reuse refused
  expect((await (await ctx(s.base)).post('/api/auth/login', { data: { username, password: 'Third-pass-9917!x' } })).status()).toBe(200);
  await s.stop();
});

test('overlong passcodes are refused before hashing and never consume an attempt', async () => {
  const s = await start(tmp()); const m = await mkFull(s.base, 'short-code'); const g = await ctx(s.base);
  for (let i = 0; i < 12; i++) { const r = await attempt(g, m.id, 'x'.repeat(129 + i)); expect(r.status()).toBe(400); expect((await r.json()).error).toMatch(/not valid/); }
  expect((await attempt(g, m.id, 'y'.repeat(128))).status()).toBe(403);                  // exactly 128 is hashed and is simply wrong
  for (let i = 0; i < 3; i++) expect((await attempt(g, m.id, 'wrong' + i)).status()).toBe(403);
  expect((await attempt(g, m.id, 'short-code')).status()).toBe(201);                      // budget intact: 12 overlong requests cost nothing
  await s.stop();
});

test('recovery: rejected requests are audited (store + structured log) without using the allowance; logs hold no secrets', async () => {
  test.setTimeout(120000);
  const s = await start(tmp()); const m = await mkFull(s.base, 'audit-code-9'); const url = `/api/meetings/${encodeURIComponent(m.id)}`;
  const attacker = await ctx(s.base); for (let i = 0; i < 5; i++) await attempt(attacker, m.id, 'guess' + i);
  const bystander = await ctx(s.base); const other = await mkFull(s.base); await attempt(bystander, other.id, undefined);
  const host = await ctx(s.base); await attempt(host, m.id, undefined, { hostKey: m.hostKey });
  const evil = await pwRequest.newContext({ baseURL: s.base, extraHTTPHeaders: { origin: 'https://evil.example', cookie: (await host.storageState()).cookies.map((c) => c.name + '=' + c.value).join('; ') } });
  for (let i = 0; i < 4; i++) {                                                         // four rejected requests of three kinds, none of them may use up the allowance
    expect((await (await ctx(s.base)).post(`${url}/passcode-lockout/clear`, { data: {} })).status()).toBe(401);
    expect((await bystander.post(`${url}/passcode-lockout/clear`, { data: {} })).status()).toBe(403);
    expect((await evil.post(`${url}/passcode-lockout/clear`, { data: {} })).status()).toBe(403);
  }
  for (let i = 0; i < 3; i++) expect((await host.post(`${url}/passcode-lockout/clear`, { data: {} })).status()).toBe(200);   // allowance untouched
  expect((await host.post(`${url}/passcode-lockout/clear`, { data: {} })).status()).toBe(429);
  const events = (await (await host.get(`${url}/passcode-security`)).json()).events;
  const reasons = new Set(events.filter((e) => e.kind === 'clear_rejected').map((e) => e.reason)); for (const r of ['unauthenticated', 'not_host', 'origin_rejected', 'rate_limited']) expect(reasons.has(r), r).toBe(true);
  const audit = s.log().split(String.fromCharCode(10)).filter((l) => l.startsWith('{"audit":"passcode_lockout_clear"')).map((l) => JSON.parse(l));
  expect(audit.length).toBeGreaterThanOrEqual(15); expect(audit.filter((a) => a.outcome === 'cleared').length).toBe(3);
  for (const a of audit) { expect(a.meeting).toBe(m.id); expect(a.at).toMatch(/^[0-9]{4}-/); expect(a.reason).toBeTruthy(); expect(['cleared', 'rejected', 'failed']).toContain(a.outcome); }
  expect(audit.some((a) => a.actor && a.actor.startsWith('guest:'))).toBe(true);
  const log = s.log(); expect(log).not.toContain('audit-code-9'); expect(log).not.toContain(m.hostKey);
  await s.stop();
});
