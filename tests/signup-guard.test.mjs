// node --test tests/signup-guard.test.mjs
// Real auth router on a real HTTP server (temporary data folder). Addresses are simulated with X-Forwarded-For, which is honoured here
// only because THIS test turns "trust proxy" on, exactly as server.js does for its own reverse proxy.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const require = createRequire(import.meta.url);
const guard = require('../signup-guard.js');

describe('helpers', () => {
  test('subnetOf: IPv4 -> /24, IPv6 -> /48 (including ::, mapped addresses), junk -> null', () => {
    assert.equal(guard.subnetOf('203.0.113.77'), '203.0.113.0/24');
    assert.equal(guard.subnetOf('::ffff:203.0.113.77'), '203.0.113.0/24');
    assert.equal(guard.subnetOf('2001:db8:abcd:1234:5678::1'), '2001:db8:abcd::/48');
    assert.equal(guard.subnetOf('2001:db8::1'), '2001:db8:0::/48');
    assert.equal(guard.subnetOf('2001:0db8:00aa:0000:0000:0000:0000:0001'), '2001:db8:aa::/48');
    assert.equal(guard.subnetOf('not an ip'), null); assert.equal(guard.subnetOf(''), null); assert.equal(guard.subnetOf(undefined), null);
  });
  test('isLocalAddress: loopback, private and link-local are local; public addresses are not', () => {
    for (const a of ['127.0.0.1', '::1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.1.1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1']) assert.equal(guard.isLocalAddress(a), true, a);
    for (const a of ['203.0.113.5', '8.8.8.8', '172.32.0.1', '2001:db8::1']) assert.equal(guard.isLocalAddress(a), false, a);
  });
  test('isAllowedNetwork matches a subnet entry or an exact address', () => {
    assert.equal(guard.isAllowedNetwork('198.51.100.45', ['198.51.100.0/24']), true);
    assert.equal(guard.isAllowedNetwork('198.51.100.45', ['198.51.100.45']), true);
    assert.equal(guard.isAllowedNetwork('198.51.101.45', ['198.51.100.0/24']), false);
    assert.equal(guard.isAllowedNetwork('198.51.100.45', []), false);
  });
  test('isDisposableEmail: listed domains and their subdomains; ordinary and empty addresses are not', () => {
    const s = guard.disposableSet(['Throwaway.example']);
    for (const e of ['a@mailinator.com', 'A@MAILINATOR.COM', 'x@sub.mailinator.com', 'x@throwaway.example']) assert.equal(guard.isDisposableEmail(e, s), true, e);
    for (const e of ['a@gmail.com', 'a@university.edu', '', undefined, 'no-at-sign', 'a@notmailinator.com', 'a@mailinator.com.evil.test']) assert.equal(guard.isDisposableEmail(e, s), false, String(e));
  });
});

describe('POST /register', () => {
  let server, base, dir;
  before(async () => {
    process.env.REGISTER_PER_SUBNET_PER_HOUR = '3'; process.env.REGISTER_LIMIT_PRIVATE = '0'; process.env.REGISTER_ALLOW_NETWORKS = '198.51.100.0/24';
    dir = mkdtempSync(path.join(os.tmpdir(), 'signup-guard-'));
    const createAuth = require('../auth.js');
    const mailer = { enabled: false, isValidAddress: (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e), send: async () => ({ status: 'not_configured' }), baseUrl: 'http://x' };
    const app = express(); app.set('trust proxy', true);
    const auth = createAuth({ dataDir: dir, mailer, onAccountChange() {}, onAuthenticated() {} });
    app.use('/api/auth', auth.router || auth);
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); });

  let n = 0;
  const reg = async (ip, extra = {}) => {
    const r = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ username: 'user' + (++n) + 'x', password: 'a-long-enough-password', ...extra }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  test('the 4th account in an hour from one /24 is refused; a different /24 is unaffected', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await reg('203.0.113.' + (10 + i))).status, 201, 'account ' + (i + 1));
    const blocked = await reg('203.0.113.200'); assert.equal(blocked.status, 429); assert.match(blocked.body.error, /Too many accounts/);
    assert.equal((await reg('203.0.114.5')).status, 201, 'neighbouring network');
  });

  test('failed attempts (taken username, bad email) do not use up the allowance', async () => {
    const ip = '203.0.120.9';
    assert.equal((await reg(ip, { username: 'dup-name' })).status, 201);
    for (let i = 0; i < 5; i++) assert.equal((await reg(ip, { username: 'dup-name' })).status, 409);
    for (let i = 0; i < 5; i++) assert.equal((await reg(ip, { email: 'nope' })).status, 400);
    assert.equal((await reg(ip)).status, 201); assert.equal((await reg(ip)).status, 201);
    assert.equal((await reg(ip)).status, 429, 'now three real accounts exist');
  });

  test('an IPv6 /48 is one network', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await reg(`2001:db8:aaaa:${i}::1`)).status, 201);
    assert.equal((await reg('2001:db8:aaaa:ffff::9')).status, 429);
    assert.equal((await reg('2001:db8:bbbb::1')).status, 201);
  });

  test('allow-listed networks and local addresses are never limited', async () => {
    for (let i = 0; i < 8; i++) assert.equal((await reg('198.51.100.' + (20 + i))).status, 201, 'campus ' + i);
    for (let i = 0; i < 8; i++) assert.equal((await reg('10.0.0.' + (1 + i))).status, 201, 'private ' + i);
  });

  test('disposable e-mail addresses are refused with a clear message; e-mail stays optional', async () => {
    const r = await reg('203.0.130.1', { email: 'bot@mailinator.com' }); assert.equal(r.status, 400); assert.match(r.body.error, /permanent email/);
    assert.equal((await reg('203.0.130.1', { email: 'real@university.edu' })).status, 201);
    assert.equal((await reg('203.0.130.2')).status, 201, 'no e-mail at all');
  });
});
