// node --test tests/device-link.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const require = createRequire(import.meta.url);
const store = require('../store.js');
const createDeviceLinks = require('../device-link.js');
const DAY = 86400000;

describe('device-link store', () => {
  let dir, t;
  const make = (o = {}) => createDeviceLinks({ dir, store, now: () => t, ...o });
  before(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'devlink-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));
  const reset = () => { t = 1_800_000_000_000; rmSync(path.join(dir, 'device-links.json'), { force: true }); };

  test('the first sign-up gets a new random cookie; only its hash is stored; the count rises per account; ids and e-mails are never returned', () => {
    reset(); const d = make();
    assert.deepEqual(d.status(undefined), { linked: false, count: 0 });
    const c1 = d.link(undefined, 'u_1', 'alice1'); assert.match(c1, d.COOKIE_RE);
    assert.deepEqual(d.status(c1), { linked: true, count: 1 });
    assert.equal(d.link(c1, 'u_2', 'alice2'), c1, 'same browser keeps its cookie');
    assert.deepEqual(d.status(c1), { linked: true, count: 2 });
    assert.deepEqual(Object.keys(d.status(c1)).sort(), ['count', 'linked']);
    const onDisk = readFileSync(path.join(dir, 'device-links.json'), 'utf8');
    assert.ok(!onDisk.includes(c1), 'the raw cookie value is not stored');
  });

  test('a cookie value the server never issued is ignored (a client cannot choose its own identity or join another device)', () => {
    reset(); const d = make();
    const mine = d.link(undefined, 'u_1', 'bob1');
    const forged = 'A'.repeat(43);
    assert.deepEqual(d.status(forged), { linked: false, count: 0 });
    const issued = d.link(forged, 'u_2', 'bob2'); assert.notEqual(issued, forged); assert.notEqual(issued, mine);
    for (const junk of ['', 'short', 'x'.repeat(44), '../../etc', null, 42, {}]) assert.deepEqual(d.status(junk), { linked: false, count: 0 });
  });

  test('the limit: allowed below it, refused at it, and an administrator override lets exactly one more username through once', () => {
    reset(); const d = make({ maxAccounts: 2 });
    const c = d.link(undefined, 'u_1', 'one1'); d.link(c, 'u_2', 'two2');
    assert.equal(d.allowed(c, 'three3'), false);
    assert.equal(d.allowed(undefined, 'three3'), true, 'no cookie: this is a new browser');
    assert.equal(d.grantOverride({ username: 'Three3', reason: 'Shared family computer', adminId: 'u_admin' }).ok, true);
    assert.equal(d.allowed(c, 'three3'), true); assert.equal(d.allowed(c, 'other4'), false, 'only that username');
    d.link(c, 'u_3', 'three3');
    assert.equal(d.allowed(c, 'three3'), false, 'used once, then gone');
    assert.deepEqual(d.auditTrail().map((e) => e.action), ['override_granted', 'override_used']);
  });

  test('overrides expire after 7 days and need a valid username and a reason', () => {
    reset(); const d = make({ maxAccounts: 1 });
    const c = d.link(undefined, 'u_1', 'one1');
    d.grantOverride({ username: 'late5', reason: 'a good reason', adminId: 'a' });
    t += 8 * DAY; assert.equal(d.allowed(c, 'late5'), false);
    assert.equal(d.grantOverride({ username: 'x', reason: 'ok reason', adminId: 'a' }).ok, false);
    assert.equal(d.grantOverride({ username: 'valid6', reason: ' ', adminId: 'a' }).ok, false);
    assert.equal(d.grantOverride({ username: 'valid6', reason: 'a\r\nb'.repeat(200), adminId: 'a' }).ok, true);
    assert.ok(!/[\r\n]/.test(d.auditTrail().at(-1).detail) && d.auditTrail().at(-1).detail.length <= 300);
  });

  test('retention: a device not seen for 90 days no longer counts and is deleted by prune(); active devices and the audit trail stay', () => {
    reset(); const d = make();
    const old = d.link(undefined, 'u_1', 'old11'); const fresh = d.link(undefined, 'u_2', 'new22');
    d.grantOverride({ username: 'keep33', reason: 'kept in audit', adminId: 'a' });
    t += 60 * DAY; d.link(fresh, 'u_3', 'new33'); t += 40 * DAY;                      // fresh was seen again at day 60; old was last seen 100 days ago
    assert.deepEqual(d.status(old), { linked: false, count: 0 });
    assert.equal(d.prune().removed, 1);
    assert.equal(d.status(fresh).count, 2);
    assert.equal(d.auditTrail().length >= 1, true);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'device-links.json'), 'utf8')).overrides.length, 0, 'expired override removed');
  });

  test('the audit trail is hash-chained: editing a past entry is detected', () => {
    reset(); const d = make();
    d.grantOverride({ username: 'aaa11', reason: 'first reason', adminId: 'a' }); d.grantOverride({ username: 'bbb22', reason: 'second reason', adminId: 'a' });
    assert.equal(d.verifyAudit(), true);
    const f = path.join(dir, 'device-links.json'); const j = JSON.parse(readFileSync(f, 'utf8'));
    j.audit[0].target = 'someone-else'; writeFileSync(f, JSON.stringify(j));
    assert.equal(d.verifyAudit(), false);
  });
});

describe('POST /register with the az_dev cookie', () => {
  let server, base, dir;
  before(async () => {
    process.env.REGISTER_LIMIT_PRIVATE = '1'; process.env.REGISTER_PER_SUBNET_PER_HOUR = '1000'; process.env.REGISTER_ALLOW_NETWORKS = '198.51.100.0/24'; process.env.DEVICE_MAX_ACCOUNTS = '2';
    dir = mkdtempSync(path.join(os.tmpdir(), 'devlink-http-'));
    const createAuth = require('../auth.js');
    const mailer = { enabled: false, isValidAddress: () => true, send: async () => ({ status: 'not_configured' }), baseUrl: 'http://x' };
    const app = express(); app.set('trust proxy', true);
    const auth = createAuth({ dataDir: dir, mailer, onAccountChange() {}, onAuthenticated() {} });
    app.use('/api/auth', auth.router);
    app.post('/override', express.json(), (req, res) => res.json(auth.deviceLinks.grantOverride({ ...req.body, adminId: 'u_admin' })));
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); });

  let n = 0;
  async function reg(ip, cookie, username) {
    const r = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(cookie ? { cookie: 'az_dev=' + cookie } : {}) },
      body: JSON.stringify({ username: username || 'dev' + (++n) + 'user', password: 'a-long-enough-password' }) });
    const set = (r.headers.getSetCookie?.() || []).find((c) => c.startsWith('az_dev='));
    return { status: r.status, body: await r.json().catch(() => null), set, cookie: set ? set.split(';')[0].slice(7) : null };
  }
  const check = async (cookie) => (await fetch(base + '/api/auth/check-linked', { headers: cookie ? { cookie: 'az_dev=' + cookie } : {} })).json();

  test('the first sign-up sets an HttpOnly, SameSite, 90-day cookie scoped to /api/auth; a third from the same browser gets the soft wall', async () => {
    const a = await reg('203.0.113.9'); assert.equal(a.status, 201);
    assert.match(a.set, /HttpOnly/); assert.match(a.set, /SameSite=Lax/); assert.match(a.set, /Max-Age=7776000/); assert.match(a.set, /Path=\/api\/auth/);
    assert.deepEqual(await check(a.cookie), { linked: true, count: 1 });
    const b = await reg('203.0.113.9', a.cookie); assert.equal(b.status, 201); assert.equal(b.cookie, a.cookie, 'the same cookie is kept');
    const c = await reg('203.0.113.9', a.cookie); assert.equal(c.status, 403); assert.equal(c.body.code, 'DEVICE_ACCOUNTS_EXHAUSTED');
    assert.deepEqual(await check(a.cookie), { linked: true, count: 2 }, 'the refused attempt created nothing');
    assert.deepEqual(await check(), { linked: false, count: 0 });
  });

  test('a different network does not matter; a different browser (no cookie) is a new device; an invented cookie value does not help or hurt', async () => {
    const a = await reg('203.0.113.50'); await reg('203.0.113.50', a.cookie);
    assert.equal((await reg('203.0.113.50', a.cookie)).status, 403);
    assert.equal((await reg('203.0.113.50')).status, 201, 'no cookie = another browser on the same network: IP alone never links');
    assert.equal((await reg('203.0.113.51', 'A'.repeat(43))).status, 201);
  });

  test('an administrator override lets that one username through, once', async () => {
    const a = await reg('203.0.113.70'); await reg('203.0.113.70', a.cookie);
    assert.equal((await reg('203.0.113.70', a.cookie, 'family3rd')).status, 403);
    const o = await (await fetch(base + '/override', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'family3rd', reason: 'shared home computer' }) })).json();
    assert.equal(o.ok, true);
    assert.equal((await reg('203.0.113.70', a.cookie, 'family3rd')).status, 201);
    assert.equal((await reg('203.0.113.70', a.cookie, 'family4th')).status, 403);
  });

  test('allow-listed networks are exempt from the wall, and the cookie still works there', async () => {
    const a = await reg('198.51.100.7');
    for (let i = 0; i < 4; i++) assert.equal((await reg('198.51.100.' + (10 + i), a.cookie)).status, 201);
  });
});
