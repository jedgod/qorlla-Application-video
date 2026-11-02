// Contract test against the REAL MAIN authentication module (auth.js + portal-token.js): MAIN signs in, issues the portal cookies,
// publishes the JWKS and answers session introspection; the portal verifies all of it. Nothing is mocked on the MAIN side.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createLocalJWKSet } from 'jose';
import { freshDatabase, testConfig, startApp, ORIGIN } from './helpers.mjs';

const require = createRequire(import.meta.url);

describe('MAIN <-> portal identity contract (real MAIN auth module)', () => {
  let db, main, mainServer, portal, tmp, secret;
  const setCookies = (r) => r.headers.getSetCookie();
  const cookieValue = (cookies, name) => { const c = cookies.find((x) => x.startsWith(name + '=')); return c ? c.split(';')[0].slice(name.length + 1) : null; };
  const attrs = (cookies, name) => (cookies.find((x) => x.startsWith(name + '=')) || '').toLowerCase();
  const mainFetch = (p, opts = {}) => fetch(`http://127.0.0.1:${mainServer.address().port}${p}`, { redirect: 'manual', ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'main-auth-')); secret = 'i'.repeat(40);
    process.env.PUBLIC_URL = ORIGIN; process.env.MAIN_AUTH_ISSUER = ORIGIN; process.env.PORTAL_INTROSPECTION_SECRET = secret; delete process.env.ENCRYPT_KEY;
    const express = require('express'); const createAuth = require('../../auth.js');
    main = createAuth({ dataDir: tmp, mailer: { isValidAddress: (e) => /@/.test(e), enabled: false } });
    const app = express(); app.use('/api/auth', main.router);
    mainServer = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
    db = await freshDatabase();
    const base = `http://127.0.0.1:${mainServer.address().port}/api/auth/internal/session`;
    const cfg = testConfig({ env: { MAIN_INTROSPECTION_URL: base, PORTAL_INTROSPECTION_SECRET: secret } }, {});
    portal = await startApp({ pool: db.pool, cfg, jwks: async (...a) => createLocalJWKSet(main.portalTokens.jwks())(...a) });
  });
  after(async () => { await portal.close(); await new Promise((r) => mainServer.close(r)); await db.drop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  async function signUp() {
    const u = 'ct' + crypto.randomBytes(4).toString('hex');
    const r = await mainFetch('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: u, displayName: 'Contract', password: 'Contract-pass-' + crypto.randomBytes(4).toString('hex') + '!7' }) });
    assert.equal(r.status, 201); const cookies = setCookies(r);
    return { user: (await r.json()).user, cookies, qs: cookieValue(cookies, 'qs'), jwt: cookieValue(cookies, 'qorlla_portal_session'), csrf: cookieValue(cookies, 'qorlla_csrf'), username: u };
  }

  test('sign-in issues an HttpOnly Secure SameSite JWT cookie and a readable CSRF cookie; session cookie stays opaque', async () => {
    const s = await signUp();
    assert.ok(s.qs && s.jwt && s.csrf);
    const jwtAttr = attrs(s.cookies, 'qorlla_portal_session'), csrfAttr = attrs(s.cookies, 'qorlla_csrf');
    assert.match(jwtAttr, /httponly/); assert.match(jwtAttr, /secure/); assert.match(jwtAttr, /samesite=lax/); assert.match(jwtAttr, /max-age=900/);
    assert.doesNotMatch(csrfAttr, /httponly/); assert.match(csrfAttr, /secure/); assert.match(csrfAttr, /max-age=900/);
    const claims = JSON.parse(Buffer.from(s.jwt.split('.')[1], 'base64url').toString());
    assert.equal(claims.iss, ORIGIN); assert.equal(claims.aud, 'qorlla-workplace'); assert.equal(claims.sub, s.user.id.replace(/^u_/, '')); assert.ok(claims.exp - claims.iat <= 900);
    assert.equal(claims.sid, crypto.createHash('sha256').update(s.qs).digest('hex'), 'sid is the hash of the session, never the session token'); assert.ok(!s.jwt.includes(s.qs));
    assert.equal(claims.csrf, crypto.createHash('sha256').update(s.csrf).digest('hex'));
  });
  test('the portal accepts MAIN\'s real token, creates the workspace for that account, and serves only that account\'s data', async () => {
    const s = await signUp(); const session = { jwt: s.jwt, csrf: s.csrf };
    const c = portal.client(session);
    assert.equal((await c.get('/api/v1/notes')).status, 403, 'authenticated but no workspace yet');
    const w = await c.post('/api/v1/workspaces', { name: 'From MAIN' }); assert.equal(w.status, 201);
    assert.equal((await c.post('/api/v1/notes', { title: 'hello from MAIN identity' })).status, 201);
    const rows = (await db.pool.query('SELECT user_id FROM portal.members WHERE workspace_id=$1', [w.body.workspace_id])).rows;
    assert.deepEqual(rows.map((r) => r.user_id), [s.user.id.replace(/^u_/, '')], 'membership is keyed on the SAME account id MAIN uses - no duplicate portal users');
  });
  test('logout at MAIN clears the portal cookies and revokes the token before its 15 minutes are up', async () => {
    const s = await signUp(); const c = portal.client({ jwt: s.jwt, csrf: s.csrf }); assert.equal((await c.get('/api/v1/me')).status, 200);
    const out = await mainFetch('/api/auth/logout', { method: 'POST', headers: { cookie: `qs=${s.qs}` } }); assert.equal(out.status, 200);
    const cleared = setCookies(out); assert.match(attrs(cleared, 'qorlla_portal_session'), /max-age=0/); assert.match(attrs(cleared, 'qorlla_csrf'), /max-age=0/);
    await new Promise((r) => setTimeout(r, 5200));
    const after = await c.get('/api/v1/me'); assert.equal(after.status, 401); assert.match(after.body.error, /Session ended/);
  });
  test('a failed sign-in never issues portal cookies', async () => {
    const s = await signUp(); const second = await mainFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: s.username, password: 'x' }) });
    assert.equal(second.status, 401);                                    // (sanity: wrong password never yields cookies)
    assert.equal(setCookies(second).filter((x) => x.startsWith('qorlla_portal_session')).length, 0);
  });
  test('token renewal needs a live MAIN session and a same-origin request', async () => {
    const s = await signUp();
    const ok = await mainFetch('/api/auth/portal-token', { method: 'POST', headers: { cookie: `qs=${s.qs}`, origin: `http://127.0.0.1:${mainServer.address().port}`, host: `127.0.0.1:${mainServer.address().port}` } }); assert.equal(ok.status, 200);
    const fresh = cookieValue(setCookies(ok), 'qorlla_portal_session'); assert.ok(fresh); assert.notEqual(fresh, s.jwt);
    assert.equal((await mainFetch('/api/auth/portal-token', { method: 'POST' })).status, 401, 'no session => no token');
    assert.equal((await mainFetch('/api/auth/portal-token', { method: 'POST', headers: { cookie: `qs=${s.qs}`, origin: 'https://evil.example' } })).status, 403, 'cross-origin renewal refused');
  });
  test('introspection endpoint is secret-protected and answers only about hashed session ids', async () => {
    const s = await signUp(); const sid = crypto.createHash('sha256').update(s.qs).digest('hex');
    const url = `/api/auth/internal/session/${sid}`;
    assert.equal((await mainFetch(url)).status, 401); assert.equal((await mainFetch(url, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const good = await (await mainFetch(url, { headers: { authorization: 'Bearer ' + secret } })).json(); assert.equal(good.active, true); assert.equal(good.sub, s.user.id.replace(/^u_/, ''));
    assert.equal((await (await mainFetch(`/api/auth/internal/session/${'0'.repeat(64)}`, { headers: { authorization: 'Bearer ' + secret } })).json()).active, false);
    assert.equal((await mainFetch(`/api/auth/internal/session/${s.qs}`, { headers: { authorization: 'Bearer ' + secret } })).status, 200, 'raw token as id is just an unknown id');
    assert.equal((await (await mainFetch(`/api/auth/internal/session/${s.qs}`, { headers: { authorization: 'Bearer ' + secret } })).json()).active, false, 'a stolen raw session token is not accepted as a session id');
  });
  test('key rotation: old tokens keep verifying for 24 h via the retired public key; new tokens use the new key id', async () => {
    const s = await signUp(); const oldKid = JSON.parse(Buffer.from(s.jwt.split('.')[0], 'base64url').toString()).kid;
    const newKid = main.portalTokens.rotate(); assert.notEqual(oldKid, newKid);
    assert.deepEqual(main.portalTokens.jwks().keys.map((k) => k.kid), [newKid, oldKid]);
    assert.ok(main.portalTokens.jwks().keys.every((k) => !('d' in k) && !('p' in k) && !('q' in k)), 'JWKS never contains private key material');
    assert.equal((await portal.client({ jwt: s.jwt, csrf: s.csrf }).get('/api/v1/me')).status, 200);
    const s2 = await signUp(); assert.equal(JSON.parse(Buffer.from(s2.jwt.split('.')[0], 'base64url').toString()).kid, newKid);
  });
});
