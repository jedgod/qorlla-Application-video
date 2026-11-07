// BROWSER E2E: real Chromium + a virtual authenticator (CDP) performing real navigator.credentials ceremonies against the real
// administration service, through a web tier that uses the REAL main-app auth.js (sign-up, session cookie, CSRF, logout).
// Needs SUBACC_TEST_ADMIN_URL and a Playwright-compatible Chromium (the version cached for the main app is used).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { chromium } from 'playwright-core';
import { createTestDb, newCustomer, seedSubscription, skip } from './helpers/db.js';
import { StepUpService } from '../src/stepup.js';
import { createStaff } from '../src/staff.js';
import { DirectoryAdmin } from '../src/directory.js';
import { AdminService } from '../src/admin.js';
import { createAdminServer } from '../src/adminServer.js';
import { createAdminClient, sessionHashOf } from '../src/adminClient.js';
import { createCsrf } from '../src/csrf.js';

const require = createRequire(import.meta.url);
const createAuth = require('../../auth.js');
const HERE = dirname(fileURLToPath(import.meta.url));
const KEY = 'e'.repeat(40);
const PASSWORD = 'correct-horse-battery-9';
let seq = 0;

describe('browser E2E: passkey step-up through the real auth.js (Chromium)', { skip, timeout: 240_000 }, () => {
  let db, browser, web, adminHttp, base, port, dataDir, stepUp, auth;
  before(async () => {
    db = await createTestDb(); dataDir = await mkdtemp(join(tmpdir(), 'subacc-e2e-'));
    web = createServer(); await new Promise((r) => web.listen(0, '127.0.0.1', r)); port = web.address().port; base = `http://localhost:${port}`;   // RP id "localhost" is a secure context
    const adminPool = db.poolFor('admin');
    stepUp = new StepUpService({ pool: adminPool, rpID: 'localhost', origins: [base] });
    const staff = createStaff({ pool: adminPool });
    adminHttp = createServer(createAdminServer({ keys: [KEY], pool: adminPool, stepUp, staff,
      directoryAdmin: new DirectoryAdmin({ pool: adminPool, authorizeStaff: staff.authorize }), adminService: new AdminService({ pool: adminPool, authorize: staff.authorize }), logger: { error() {} } }));
    await new Promise((r) => adminHttp.listen(0, '127.0.0.1', r));
    const client = createAdminClient({ baseUrl: `http://127.0.0.1:${adminHttp.address().port}`, key: KEY });

    // ---- the web tier: real auth.js; every admin call is signed for the verified session; the web tier holds NO admin database role ----
    auth = createAuth({ dataDir, mailer: { enabled: false, configured: false, baseUrl: '' } });
    const app = express();
    app.post('/api/auth/logout', async (req, _res, next) => {                                    // logout revokes the step-up grants of THAT session at once
      const user = auth.getUser(req), h = sessionHashOf(req);
      if (user && h) await client.call('sessionRevoke', { userId: user.id, sessionHash: h }).catch(() => {});
      next();
    });
    app.use('/api/auth', auth.router);
    const csrf = createCsrf();                                                                   // the committed auth.js has no CSRF support: the admin proxy brings its own
    app.use('/api/admin', express.json({ limit: '100kb' }));
    app.get('/api/admin/csrf', auth.requireUser, (req, res) => res.set('Cache-Control', 'no-store').json({ token: csrf.tokenFor(req) }));
    const forward = (name, pick) => [auth.requireUser, csrf.require, async (req, res) => {
      const r = await client.call(name, { userId: req.user.id, sessionHash: sessionHashOf(req), ...pick(req) });
      res.status(r.status).json(r.body);
    }];
    const body = (req) => ({ body: req.body });
    app.post('/api/admin/stepup/passkey/register/begin', ...forward('registerBegin', body));
    app.post('/api/admin/stepup/passkey/register/finish', ...forward('registerFinish', body));
    app.post('/api/admin/stepup/passkey/assert/begin', ...forward('assertBegin', body));
    app.post('/api/admin/stepup/passkey/assert/finish', ...forward('assertFinish', body));
    app.post('/api/admin/override', ...forward('overrideSet', (req) => ({ customerId: req.body.customerId, params: { feature: req.body.feature }, body: { value: req.body.value, reason: req.body.reason, expiresAt: req.body.expiresAt } })));
    app.get('/qorlla-stepup.js', async (_req, res) => res.type('text/javascript').send(await readFile(join(HERE, '..', 'public', 'qorlla-stepup.js'), 'utf8')));
    app.get('/', (_req, res) => res.type('html').send('<!doctype html><title>step-up</title><script type="module">import * as su from "/qorlla-stepup.js"; window.su = su; window.ready = true;</script>'));
    web.on('request', app);
    browser = await chromium.launch({ headless: true });
  });
  after(async () => { await browser?.close(); web?.close(); adminHttp?.close(); await db.drop(); await rm(dataDir, { recursive: true, force: true }); });

  // ---- helpers ---------------------------------------------------------------------------------------------------------------
  async function newSession({ origin = base, authenticator = true, user } = {}) {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await page.goto(origin + '/'); await page.waitForFunction(() => window.ready === true);
    let cdp = null; let authenticatorId = null;
    if (authenticator) {
      cdp = await ctx.newCDPSession(page); await cdp.send('WebAuthn.enable');
      ({ authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }));
    }
    const s = { ctx, page, cdp, authenticatorId, user };
    if (!user) {
      const username = `e2e${++seq}x${randomBytes(3).toString('hex')}`;
      const reg = await page.evaluate(async ({ username, password }) => { const r = await fetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) }); return { status: r.status, body: await r.json() }; }, { username, password: PASSWORD });
      assert.equal(reg.status, 201, JSON.stringify(reg.body));
      s.user = { id: reg.body.user.id, username };
    } else {
      const login = await page.evaluate(async ({ username, password }) => { const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) }); return r.status; }, { username: user.username, password: PASSWORD });
      assert.equal(login, 200);
    }
    s.csrf = await page.evaluate(async () => (await (await fetch('/api/admin/csrf')).json()).token);
    return s;
  }
  const run = (s, fn, args = {}) => s.page.evaluate(async ({ fn, args }) => { try { return { ok: true, value: await window.su[fn](args) }; } catch (e) { return { ok: false, name: e.name, message: e.message, status: e.status }; } }, { fn, args: { csrf: s.csrf, ...args } });
  const override = (s, customerId, extra = {}) => s.page.evaluate(async ({ csrf, customerId, extra }) => {
    const r = await fetch('/api/admin/override', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ customerId, feature: 'meetings.cloud_recording', value: true, reason: 'browser e2e test grant', expiresAt: new Date(Date.now() + 864e5).toISOString(), ...extra }) });
    return { status: r.status, body: await r.json() };
  }, { csrf: s.csrf, customerId, extra });
  const staffAndPasskey = async (s) => {
    await db.owner.query(`INSERT INTO platform_staff (user_id, roles, all_customers, granted_by) VALUES ($1,'{billing_admin}',true,'dba')`, [s.user.id]);
    const token = await stepUp.createEnrollmentToken({ userId: s.user.id, createdBy: 'ops' });
    const r = await run(s, 'registerPasskey', { enrollmentToken: token, userName: s.user.username });
    assert.equal(r.ok, true, JSON.stringify(r));
  };
  const customer = async () => { const c = newCustomer(); await seedSubscription(db.owner, c, { plan: 'basic' }); return c; };
  const overrides = async (c) => Number((await db.owner.query('SELECT count(*) AS n FROM entitlement_overrides WHERE customer_id=$1', [c])).rows[0].n);

  test('a real passkey is registered in the browser; the credential is stored; a privileged action WITHOUT a fresh step-up is refused and changes nothing', async () => {
    const s = await newSession(); const c = await customer();
    try {
      await staffAndPasskey(s);
      assert.equal(await stepUp.hasFactor(s.user.id), true);
      assert.equal(Number((await db.owner.query('SELECT count(*) AS n FROM webauthn_credentials WHERE user_id=$1', [s.user.id])).rows[0].n), 1);
      const r = await override(s, c);
      assert.equal(r.status, 403); assert.equal(r.body.error, 'stepup_required');
      assert.equal(await overrides(c), 0);
    } finally { await s.ctx.close(); }
  });

  test('after a real passkey step-up the action succeeds exactly once; the proof is spent', async () => {
    const s = await newSession(); const c = await customer();
    try {
      await staffAndPasskey(s);
      const up = await run(s, 'stepUp', { action: 'override.set' }); assert.equal(up.ok, true, JSON.stringify(up));
      assert.equal((await override(s, c)).status, 200); assert.equal(await overrides(c), 1);
      const second = await override(s, c, { value: false }); assert.equal(second.status, 403); assert.equal(second.body.error, 'stepup_required');
      const c2 = await customer(); assert.equal((await override(s, c2)).status, 403, 'and it is not a standing permission for other customers either');
    } finally { await s.ctx.close(); }
  });

  test('the proof belongs to ONE session: the same user signed in elsewhere cannot spend it, and logging out kills it', async () => {
    const a = await newSession(); const c = await customer();
    try {
      await staffAndPasskey(a);
      await run(a, 'stepUp', { action: 'override.set' });
      const b = await newSession({ user: a.user, authenticator: false });                         // a second login of the same account
      try { const r = await override(b, c); assert.equal(r.status, 403); assert.equal(r.body.error, 'stepup_required'); } finally { await b.ctx.close(); }
      const out = await a.page.evaluate(async (csrf) => (await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: '{}' })).status, a.csrf);
      assert.equal(out, 200);
      const again = await newSession({ user: a.user, authenticator: false });
      try { const r = await override(again, c); assert.equal(r.body.error, 'stepup_required', 'the grant died with the old session'); } finally { await again.ctx.close(); }
      assert.equal(await overrides(c), 0);
    } finally { await a.ctx.close(); }
  });

  test('user verification is required: a authenticator that cannot verify the user yields no proof and no grant', async () => {
    const s = await newSession(); const c = await customer();
    try {
      await staffAndPasskey(s);
      await s.cdp.send('WebAuthn.setUserVerified', { authenticatorId: s.authenticatorId, isUserVerified: false });
      const up = await run(s, 'stepUp', { action: 'override.set' });
      assert.equal(up.ok, false, 'the ceremony does not complete');
      assert.equal(Number((await db.owner.query(`SELECT count(*) AS n FROM stepup_grants WHERE user_id=$1`, [s.user.id])).rows[0].n), 0);
      assert.equal((await override(s, c)).status, 403);
      await s.cdp.send('WebAuthn.setUserVerified', { authenticatorId: s.authenticatorId, isUserVerified: true });
      assert.equal((await run(s, 'stepUp', { action: 'override.set' })).ok, true, 'and works once the user is verified');
    } finally { await s.ctx.close(); }
  });

  test('a valid passkey of a user who is NOT platform staff still cannot administer billing', async () => {
    const s = await newSession(); const c = await customer();
    try {
      const token = await stepUp.createEnrollmentToken({ userId: s.user.id, createdBy: 'ops' });
      assert.equal((await run(s, 'registerPasskey', { enrollmentToken: token, userName: s.user.username })).ok, true);
      assert.equal((await run(s, 'stepUp', { action: 'override.set' })).ok, true, 'the ceremony itself succeeds');
      assert.equal((await override(s, c)).status, 403, 'but staff authorisation is read from the database, not from the proof');
      assert.equal(await overrides(c), 0);
    } finally { await s.ctx.close(); }
  });

  test('a passkey cannot be enrolled with a session alone, a bad token, or a token issued for someone else', async () => {
    const s = await newSession(); const other = await newSession();
    try {
      for (const bad of [undefined, 'x'.repeat(40)]) { const r = await run(s, 'registerPasskey', { enrollmentToken: bad, userName: s.user.username }); assert.equal(r.ok, false); assert.equal(r.status, 403); }
      const forOther = await stepUp.createEnrollmentToken({ userId: other.user.id, createdBy: 'ops' });
      assert.equal((await run(s, 'registerPasskey', { enrollmentToken: forOther, userName: s.user.username })).ok, false, "someone else's token");
      assert.equal(await stepUp.hasFactor(s.user.id), false);
    } finally { await s.ctx.close(); await other.ctx.close(); }
  });

  test('the browser itself refuses the ceremony on the wrong origin (the passkey is bound to its relying party)', async () => {
    const s = await newSession({ origin: `http://127.0.0.1:${port}` });                           // same server, but 127.0.0.1 is not the RP id "localhost"
    try {
      await db.owner.query(`INSERT INTO platform_staff (user_id, roles, all_customers, granted_by) VALUES ($1,'{billing_admin}',true,'dba')`, [s.user.id]);
      const token = await stepUp.createEnrollmentToken({ userId: s.user.id, createdBy: 'ops' });
      const r = await run(s, 'registerPasskey', { enrollmentToken: token, userName: s.user.username });
      assert.equal(r.ok, false); assert.match(`${r.name} ${r.message}`, /Security|rp|relying|origin|not valid/i);
      assert.equal(await stepUp.hasFactor(s.user.id), false);
    } finally { await s.ctx.close(); }
  });

  test('CSRF: a state-changing admin call without the token never reaches the administration service', async () => {
    const s = await newSession(); const c = await customer();
    try {
      await staffAndPasskey(s); await run(s, 'stepUp', { action: 'override.set' });
      const r = await s.page.evaluate(async (customerId) => { const x = await fetch('/api/admin/override', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customerId, feature: 'meetings.cloud_recording', value: true, reason: 'no csrf token here', expiresAt: new Date(Date.now() + 864e5).toISOString() }) }); return x.status; }, c);
      assert.equal(r, 403); assert.equal(await overrides(c), 0);
      assert.equal((await override(s, c)).status, 200, 'and the unspent proof still works with the token');
    } finally { await s.ctx.close(); }
  });
});
