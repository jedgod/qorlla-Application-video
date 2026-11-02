import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, addMember, here, ORIGIN } from './helpers.mjs';

describe('authentication & authorization', () => {
  let db, main, app, A, B, wsA, wsB;
  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn();
    app = await startApp({ pool: db.pool, cfg: testConfig({}, main), jwks: main.jwks });
    A = await main.mint(); B = await main.mint();
    wsA = await seedWorkspace(db.pool, A.sub, 'A corp'); wsB = await seedWorkspace(db.pool, B.sub, 'B corp');
    await db.pool.query(`INSERT INTO portal.notes(workspace_id,author_id,title) VALUES($1,$2,'A-secret-note'),($3,$4,'B-secret-note')`, [wsA, A.sub, wsB, B.sub]);
  });
  after(async () => { await app.close(); await main.close(); await db.drop(); });

  test('private endpoints reject anonymous callers with 401 (never development records)', async () => {
    const c = app.client(null);
    for (const p of ['/api/v1/session', '/api/v1/me', '/api/v1/notes', '/api/v1/workspace', '/api/v1/members', '/api/v1/billing', '/api/v1/entitlements', '/api/v1/support/tickets', '/api/v1/reports', '/api/v1/usage']) {
      const r = await c.get(p); assert.equal(r.status, 401, p); assert.ok(!JSON.stringify(r.body).includes('secret-note'));
    }
    assert.equal((await c.post('/api/v1/notes', { title: 'x' })).status, 401);
  });
  test('identity headers and development env vars are never honoured', async () => {
    const r = await fetch(app.base + '/api/v1/notes', { headers: { 'x-user-id': A.sub, 'x-workspace-id': wsA, authorization: 'Bearer ' + A.jwt } });
    assert.equal(r.status, 401);
    const src = ['app.mjs', 'auth.mjs', 'index.mjs', 'config.mjs'].map((f) => fs.readFileSync(path.join(here, '..', 'server', f), 'utf8')).join('\n');
    assert.doesNotMatch(src, /DEV_USER_ID|DEV_WORKSPACE_ID|req\.actor\s*=\s*process\.env/);
  });
  test('public catalogue works without a session', async () => {
    const r = await app.client(null).get('/api/v1/plans'); assert.equal(r.status, 200); assert.ok(Array.isArray(r.body.plans));
    assert.equal((await app.client(null).get('/api/v1/products')).status, 200);
  });
  test('a valid session sees only its own workspace data', async () => {
    const a = app.client(A), b = app.client(B);
    const na = await a.get('/api/v1/notes'); const nb = await b.get('/api/v1/notes');
    assert.deepEqual(na.body.map((n) => n.title), ['A-secret-note']); assert.deepEqual(nb.body.map((n) => n.title), ['B-secret-note']);
    assert.equal((await a.get('/api/v1/session')).body.workspace_id, wsA);
  });
  test('cross-workspace access is forbidden even when the workspace id is guessed', async () => {
    const r = await app.client(A, { workspace: wsB }).get('/api/v1/notes'); assert.equal(r.status, 403);
    assert.equal((await app.client(A, { workspace: wsB }).get('/api/v1/members')).status, 403);
    assert.equal((await app.client(A, { workspace: wsB }).post('/api/v1/notes', { title: 'planted' })).status, 403);
    assert.equal((await app.client(A, { workspace: 'not-a-uuid' }).get('/api/v1/notes')).status, 400);
    assert.equal(Number((await db.pool.query(`SELECT count(*) FROM portal.notes WHERE title='planted'`)).rows[0].count), 0);
  });
  test('a valid MAIN identity with no membership gets 403 but can read an empty /me', async () => {
    const C = await main.mint(); const c = app.client(C);
    assert.equal((await c.get('/api/v1/notes')).status, 403);
    const me = await c.get('/api/v1/me'); assert.equal(me.status, 200); assert.deepEqual(me.body.workspaces, []);
  });
  test('a signed-in user can create their first workspace and gets the Basic plan', async () => {
    const D = await main.mint(); const d = app.client(D);
    const w = await d.post('/api/v1/workspaces', { name: 'Mine' }); assert.equal(w.status, 201); assert.equal(w.body.role, 'owner');
    assert.equal((await d.get('/api/v1/workspace')).body.plan, 'basic');
    assert.deepEqual((await d.get('/api/v1/notes')).body, []);
  });
  test('expired, wrong-issuer, wrong-audience, forged-key, over-age, alg=none and garbage tokens are rejected', async () => {
    const cases = {
      expired: await main.mint({ iat: Math.floor(Date.now() / 1000) - 3600, expIn: 60 }),
      wrongIssuer: await main.mint({ iss: 'https://evil.example' }),
      wrongAudience: await main.mint({ aud: 'other-app' }),
      forgedKey: await main.mint({ key: main.other.privateKey }),
      tooOld: await main.mint({ iat: Math.floor(Date.now() / 1000) - 20 * 60, expIn: 3600 })
    };
    for (const [name, s] of Object.entries(cases)) { await seedWorkspace(db.pool, s.sub); assert.equal((await app.client(s).get('/api/v1/notes')).status, 401, name); }
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: A.sub, iss: ORIGIN, aud: 'qorlla-workplace', sid: A.sid })).toString('base64url')}.`;
    assert.equal((await fetch(app.base + '/api/v1/notes', { headers: { cookie: `qorlla_portal_session=${none}` } })).status, 401);
    assert.equal((await fetch(app.base + '/api/v1/notes', { headers: { cookie: 'qorlla_portal_session=garbage' } })).status, 401);
  });
  test('logout / revoked MAIN session ends portal access immediately, not at token expiry', async () => {
    const E = await main.mint(); await seedWorkspace(db.pool, E.sub); const e = app.client(E);
    assert.equal((await e.get('/api/v1/notes')).status, 200);
    main.sessions.set(E.sid, false);                       // MAIN logout / password change drops the session
    await new Promise((r) => setTimeout(r, 5200));         // introspection answers are cached for 5 s
    const r = await e.get('/api/v1/notes'); assert.equal(r.status, 401); assert.match(r.body.error, /Session ended/);
  });
  test('fails closed (503) when MAIN introspection is down, and when auth is not configured at all', async () => {
    const F = await main.mint(); await seedWorkspace(db.pool, F.sub);
    main.server.down = true; assert.equal((await app.client(F).get('/api/v1/notes')).status, 503); main.server.down = false;
    const unconfigured = await startApp({ pool: db.pool, cfg: testConfig({ env: { MAIN_AUTH_ISSUER: '', MAIN_AUTH_JWKS_URL: '' } }, main), jwks: null });
    assert.equal((await unconfigured.client(A).get('/api/v1/notes')).status, 503);
    assert.equal((await unconfigured.client(null).get('/api/v1/health')).status, 200); await unconfigured.close();
  });
  test('writes need same Origin plus a double-submit CSRF token bound to the signed token', async () => {
    const c = app.client(A);
    assert.equal((await c.post('/api/v1/notes', { title: 'ok-1' })).status, 201);
    assert.equal((await c.post('/api/v1/notes', { title: 'x' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await c.post('/api/v1/notes', { title: 'x' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
    const noOrigin = await fetch(app.base + '/api/v1/notes', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `qorlla_portal_session=${A.jwt}; qorlla_csrf=${A.csrf}`, 'x-csrf-token': A.csrf }, body: '{"title":"x"}' });
    assert.equal(noOrigin.status, 403);
    assert.equal((await c.post('/api/v1/notes', { title: 'x' }, { 'x-csrf-token': 'wrong' })).status, 403);
    // attacker injects BOTH cookie and header with their own value: equal to each other but not the hash inside the JWT
    const injected = await fetch(app.base + '/api/v1/notes', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: `qorlla_portal_session=${A.jwt}; qorlla_csrf=attacker`, 'x-csrf-token': 'attacker' }, body: '{"title":"x"}' });
    assert.equal(injected.status, 403);
    assert.equal(Number((await db.pool.query(`SELECT count(*) FROM portal.notes WHERE title='x'`)).rows[0].count), 0);
  });
  test('role matrix: member cannot bill or manage; billing role bills but cannot manage members; admin manages; last owner protected', async () => {
    const owner = await main.mint(), adm = await main.mint(), bill = await main.mint(), mem = await main.mint();
    const ws = await seedWorkspace(db.pool, owner.sub); await db.pool.query(`UPDATE portal.subscriptions SET plan_slug='pro',status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [ws]); await addMember(db.pool, ws, adm.sub, 'admin'); await addMember(db.pool, ws, bill.sub, 'billing'); await addMember(db.pool, ws, mem.sub, 'member');
    const newUser = crypto.randomUUID();
    assert.equal((await app.client(mem).post('/api/v1/members', { user_id: newUser, role: 'member' })).status, 403);
    assert.equal((await app.client(bill).post('/api/v1/members', { user_id: newUser, role: 'member' })).status, 403);
    assert.equal((await app.client(adm).post('/api/v1/members', { user_id: newUser, role: 'member' })).status, 201);
    assert.equal((await app.client(mem).get('/api/v1/billing/invoices')).status, 403);
    assert.equal((await app.client(bill).get('/api/v1/billing/invoices')).status, 200);
    assert.equal((await app.client(mem).post('/api/v1/billing/checkout', { plan: 'pro', interval: 'month' })).status, 403);
    assert.equal((await app.client(adm).patch('/api/v1/members/' + mem.sub, { role: 'owner' })).status, 403, 'only owners promote owners');
    assert.equal((await app.client(owner).patch('/api/v1/members/' + owner.sub, { role: 'member' })).status, 409, 'last owner protected');
    assert.equal((await app.client(adm).patch('/api/v1/workspace', { name: 'Renamed' })).status, 200);
    assert.equal((await app.client(mem).patch('/api/v1/workspace', { name: 'Hacked' })).status, 403);
    assert.equal((await app.client(owner).get('/api/v1/workspace')).body.name, 'Renamed');
  });
  test('structured request logs never contain cookies, tokens, query strings or bodies', async () => {
    const lines = []; const { createLogger } = await import('../server/log.mjs'); const { createApp } = await import('../server/app.mjs');
    const { app: a2 } = createApp({ pool: db.pool, cfg: testConfig({}, main), jwks: main.jwks, log: createLogger((l) => lines.push(l)) });
    const s = await new Promise((r) => { const x = a2.listen(0, '127.0.0.1', () => r(x)); });
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/v1/notes?token=secret123`, { headers: { cookie: `qorlla_portal_session=${A.jwt}; qorlla_csrf=${A.csrf}` } });
    assert.equal(res.status, 200); s.close();
    const all = lines.join('\n'); assert.ok(lines.every((l) => JSON.parse(l).ts)); assert.ok(!all.includes(A.jwt) && !all.includes(A.csrf) && !all.includes('secret123'));
  });
});
