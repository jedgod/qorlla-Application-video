const { test, expect, request: pwRequest } = require('@playwright/test');
const { spawn } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { startSmtpSink } = require('./support/smtp-sink');

// Application-level password-reset checks through the REAL endpoints, with a local SMTP sink standing in for a mail server. This validates token
// expiry, single use, concurrent redemption and session invalidation. It does NOT certify delivery through a real email provider.
let nextPort = 5750 + Math.floor(Math.random() * 140);   // 5750-5889
async function boot(sink) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qorlla-reset-')); const port = nextPort++;
  const env = { ...process.env, PORT: String(port), DATA_DIR: dir, SMTP_URL: `smtp://127.0.0.1:${sink.port}`, SMTP_FROM: 'Qorlla <no-reply@test.local>', PUBLIC_URL: `http://127.0.0.1:${port}` };
  delete env.GUEST_RATE_LIMIT_MAX; delete env.DATABASE_URL;
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' }); const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch (e) { /* starting */ } await new Promise((r) => setTimeout(r, 150)); }
  return { dir, base, stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }) };
}
const ctx = (base) => pwRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
const tokenIn = (m) => (/[?&](?:reset|verify)=([0-9a-f]{64})/.exec(m.text) || [])[1];
async function verifiedUser(app, sink, label) {
  const username = label + Math.random().toString(36).slice(2, 7); const email = `${username}@example.test`; const a = await ctx(app.base);
  const reg = await a.post('/api/auth/register', { data: { username, displayName: label, email, password: 'Start-pass-9917!x' } }); expect(reg.status()).toBe(201);
  const mail = await sink.waitFor((m) => m.to.includes(email) && /verify=/.test(m.text)); const token = tokenIn(mail);
  expect((await (await ctx(app.base)).post('/api/auth/verify', { data: { token } })).status()).toBe(200);
  return { username, email, api: a };
}
const forgot = async (app, sink, who) => {
  const before = sink.messages.length;
  expect((await (await ctx(app.base)).post('/api/auth/forgot', { data: { identifier: who.username } })).status()).toBe(200);
  const mail = await sink.waitFor((m) => sink.messages.indexOf(m) >= before && m.to.includes(who.email) && /reset=/.test(m.text)); return tokenIn(mail);
};
const login = (app, username, password) => ctx(app.base).then((c) => c.post('/api/auth/login', { data: { username, password } }).then((r) => ({ c, status: r.status() })));
const reset = (app, token, password) => ctx(app.base).then((c) => c.post('/api/auth/reset', { data: { token, password } }));

test.describe.configure({ mode: 'serial' });

test('verification and reset tokens are single use, never appear in API responses, and an unknown account looks identical', async () => {
  const sink = await startSmtpSink(); const app = await boot(sink);
  const who = await verifiedUser(app, sink, 'single');
  const resp = await (await ctx(app.base)).post('/api/auth/forgot', { data: { identifier: who.username } }); const body = await resp.text();
  expect(JSON.parse(body)).toEqual({ ok: true }); const token = tokenIn(await sink.waitFor((m) => m.to.includes(who.email) && /reset=/.test(m.text)));
  expect(body).not.toContain(token);
  const unknown = await (await ctx(app.base)).post('/api/auth/forgot', { data: { identifier: 'nobody-here' } }); expect(await unknown.text()).toBe(body);   // no account enumeration
  await new Promise((r) => setTimeout(r, 500)); expect(sink.messages.filter((m) => /nobody-here/.test(m.text)).length).toBe(0);
  expect((await reset(app, token, 'Second-pass-9917!x')).status()).toBe(200);
  expect((await reset(app, token, 'Third-pass-9917!x')).status()).toBe(400);                                  // reuse refused
  expect((await login(app, who.username, 'Second-pass-9917!x')).status).toBe(200); expect((await login(app, who.username, 'Third-pass-9917!x')).status).toBe(401);
  await app.stop(); await sink.close();
});

test('an expired reset token is refused (one hour), and a fresh token works', async () => {
  const sink = await startSmtpSink(); const app = await boot(sink); const who = await verifiedUser(app, sink, 'expire');
  const token = await forgot(app, sink, who);
  const file = path.join(app.dir, 'auth', 'tokens.json'); const tokens = JSON.parse(fs.readFileSync(file, 'utf8'));
  const lifetime = Math.max(...tokens.filter((t) => t.purpose === 'reset').map((t) => t.exp)) - Date.now(); expect(lifetime).toBeLessThanOrEqual(3600 * 1000); expect(lifetime).toBeGreaterThan(3500 * 1000);
  for (const t of tokens) if (t.purpose === 'reset') t.exp = Date.now() - 1000;                           // time passes
  fs.writeFileSync(file, JSON.stringify(tokens));
  const late = await reset(app, token, 'Late-pass-9917!x'); expect(late.status()).toBe(400); expect((await late.json()).error).toMatch(/invalid or has expired/);
  expect((await login(app, who.username, 'Start-pass-9917!x')).status).toBe(200);                          // password unchanged
  const token2 = await forgot(app, sink, who); expect(token2).not.toBe(token); expect((await reset(app, token2, 'Fresh-pass-9917!x')).status()).toBe(200);
  await app.stop(); await sink.close();
});

test('concurrent redemption: exactly one of many simultaneous resets wins, and only that password works', async () => {
  const sink = await startSmtpSink(); const app = await boot(sink); const who = await verifiedUser(app, sink, 'race'); const token = await forgot(app, sink, who);
  const passwords = Array.from({ length: 10 }, (_, i) => `Race-pass-${i}-9917!x`);
  const results = await Promise.all(passwords.map((p) => reset(app, token, p).then((r) => ({ p, status: r.status() }))));
  const winners = results.filter((r) => r.status === 200); expect(winners.length).toBe(1); expect(results.filter((r) => r.status === 400).length).toBe(9);
  expect((await login(app, who.username, winners[0].p)).status).toBe(200);
  for (const r of results.filter((x) => x.status !== 200)) expect([401, 429]).toContain((await login(app, who.username, r.p)).status);   // never 200 (429 = the login throttle kicking in)
  await app.stop(); await sink.close();
});

test('a reset ends every existing session, and a new reset request replaces an older unused token', async () => {
  const sink = await startSmtpSink(); const app = await boot(sink); const who = await verifiedUser(app, sink, 'sess');
  const phone = await login(app, who.username, 'Start-pass-9917!x'); const laptop = await login(app, who.username, 'Start-pass-9917!x');
  for (const s of [who.api, phone.c, laptop.c]) expect((await (await s.get('/api/auth/me')).json()).user).toBeTruthy();
  const first = await forgot(app, sink, who); const second = await forgot(app, sink, who);
  expect((await reset(app, first, 'Old-token-9917!x')).status()).toBe(400);                                // superseded by the newer request
  expect((await reset(app, second, 'New-token-9917!x')).status()).toBe(200);
  for (const s of [who.api, phone.c, laptop.c]) expect((await (await s.get('/api/auth/me')).json()).user).toBeNull();   // signed out everywhere
  expect((await login(app, who.username, 'New-token-9917!x')).status).toBe(200);
  await app.stop(); await sink.close();
});

test('weak new passwords are refused without consuming the token', async () => {
  const sink = await startSmtpSink(); const app = await boot(sink); const who = await verifiedUser(app, sink, 'weak'); const token = await forgot(app, sink, who);
  expect((await reset(app, token, 'short')).status()).toBe(400);
  expect((await reset(app, token, 'Strong-pass-9917!x')).status()).toBe(200);
  await app.stop(); await sink.close();
});
