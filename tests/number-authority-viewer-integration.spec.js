const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Number Authority VIEWER: integration tests against a REAL, ISOLATED development stack (own PostgreSQL container and volume, own ports, own secrets, test identities only).
// They are skipped unless the stack is described by environment variables, so the default suite is unaffected:
//   VIEWER_STACK_MAIN=http://localhost:3400  VIEWER_STACK_MEET=http://localhost:3500  VIEWER_STACK_MAIL=http://localhost:3325
//   VIEWER_STACK_DATA=<repo>/.dev-stack/data  VIEWER_STACK_DB=qviewer-dev-db
// The stack must be FRESH and started with PHONE_ADMIN_USERS=adm_test and PHONE_NUMBER_VIEWER_USERS=viewer_ok,viewer_unver,viewer_susp,viewer_revoke
// (scripts/dev-stack.mjs with MAIN_PORT, MEET_PORT, VOICE_PORT, MEET_DB_PORT, DEV_DB_CONTAINER, DEV_DB_VOLUME set). Public numbers, PSTN and carriers stay off.
const MAIN = process.env.VIEWER_STACK_MAIN, MEET = process.env.VIEWER_STACK_MEET, MAIL = process.env.VIEWER_STACK_MAIL, DATA = process.env.VIEWER_STACK_DATA, DB = process.env.VIEWER_STACK_DB;
test.skip(!MAIN || !MAIL || !DATA || !DB, 'needs the isolated viewer stack (see the header of this file)');
test.describe.configure({ mode: 'serial' });

const PASSWORD = 'Viewer-pass-9917!x';
const AUDIT = () => path.join(DATA, 'auth', 'number-authority-viewer-audit.jsonl');
const psql = (sql) => { const r = spawnSync('docker', ['exec', DB, 'psql', '-U', 'qorlla', '-d', 'qorlla_meet', '-tAc', sql], { encoding: 'utf8' }); if (r.status !== 0) throw new Error('psql: ' + r.stderr); return r.stdout.trim(); };
const dbWrites = () => psql('select (select count(*) from qphone_numbers)||\'/\'||(select count(*) from qphone_provisioning_requests)||\'/\'||(select count(*) from qphone_audit)||\'/\'||(select count(*) from qphone_usage)');

// A tiny HTTP client with a cookie jar: one per signed-in identity.
function client() {
  const jar = {};
  const api = async (method, url, body, headers = {}) => {
    const r = await fetch((url.startsWith('http') ? '' : MAIN) + url, { method, redirect: 'manual', headers: { 'content-type': 'application/json', cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; '), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie ? r.headers.getSetCookie() : []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    let json = null; try { json = await r.json(); } catch (e) { /* not JSON */ }
    return { status: r.status, json, headers: r.headers };
  };
  return { api, jar };
}
async function verifyByMail(c, email) {
  for (let i = 0; i < 20; i++) {
    const html = await (await fetch(MAIL + '/')).text(); const m = new RegExp('To: (?:<b>)?' + email.replace(/[.+]/g, '\\$&') + '[\\s\\S]*?verify=([a-f0-9]{64})').exec(html);
    if (m) { const r = await c.api('POST', '/api/auth/verify', { token: m[1] }); expect(r.status).toBe(200); return; }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('no verification mail for ' + email);
}
const people = {};
async function person(name, { verify = true } = {}) {
  const c = client(), email = name.replace(/_/g, '') + '@example.test';
  let r = await c.api('POST', '/api/auth/register', { username: name, displayName: name, password: PASSWORD, email });
  if (r.status === 409 || r.status === 400) r = await c.api('POST', '/api/auth/login', { username: name, password: PASSWORD });
  expect([200, 201], name + ' sign-in: ' + JSON.stringify(r.json)).toContain(r.status);
  let me = (await c.api('GET', '/api/auth/me')).json.user;
  if (verify && !me.emailVerified) { await verifyByMail(c, email); me = (await c.api('GET', '/api/auth/me')).json.user; }
  c.id = me.id; c.name = name; people[name] = c; return c;
}
const overview = async (c) => (await c.api('GET', '/api/phone/overview')).json;
const diag = (c, h) => c.api('GET', '/api/phone/telephony/diagnostics', undefined, h);
// Only a viewer or administrator receives Meet's audit rows in the diagnostics: that key is the observable proof that Meet treated the caller as privileged.
const privileged = (r) => r.status === 200 && Array.isArray(r.json && r.json.audit);

test('test identities: viewer_ok verified, viewer_unver unverified, an administrator, and an ordinary customer', async () => {
  await person('adm_test'); await person('viewer_ok'); await person('viewer_unver', { verify: false }); await person('viewer_susp'); await person('viewer_revoke'); await person('cust_plain');
  expect((await people.viewer_unver.api('GET', '/api/auth/me')).json.user.emailVerified).toBe(false);
  expect((await people.viewer_ok.api('GET', '/api/auth/me')).json.user.emailVerified).toBe(true);
});

test('verified viewer: authorized GETs succeed, flagged viewer and not administrator', async () => {
  const c = people.viewer_ok, ov = await overview(c);
  expect(ov.numberViewer).toBe(true); expect(ov.admin).toBe(false);
  expect(privileged(await diag(c))).toBe(true);
});

test('unverified viewer, ordinary customer: no Number Authority access', async () => {
  for (const n of ['viewer_unver', 'cust_plain']) { const c = people[n], ov = await overview(c); expect(ov.numberViewer, n).toBe(false); expect(ov.admin, n).toBe(false); expect(privileged(await diag(c)), n).toBe(false); expect((await c.api('GET', '/api/phone/numbers/requests')).status, n).toBe(403); }
});

test('administrator is an administrator, never a viewer', async () => {
  const c = people.adm_test, ov = await overview(c); expect(ov.admin).toBe(true); expect(ov.numberViewer).toBe(false); expect(privileged(await diag(c))).toBe(true);
});

test('suspended viewer: access denied immediately, existing session included', async () => {
  const c = people.viewer_susp; expect(privileged(await diag(c))).toBe(true);
  const s = await people.adm_test.api('POST', '/api/admin/accounts/' + c.id + '/suspend', { suspended: true }); expect(s.status).toBe(200);
  expect((await c.api('GET', '/api/phone/overview')).status).toBe(401);
  const login = await client().api('POST', '/api/auth/login', { username: 'viewer_susp', password: PASSWORD }); expect(login.status).not.toBe(200);
});

test('session revocation: after sign-out the same cookie reads nothing', async () => {
  const c = people.viewer_revoke; expect(privileged(await diag(c))).toBe(true);
  const stolen = { ...c.jar }; expect((await c.api('POST', '/api/auth/logout', {})).status).toBe(200);
  const replay = client(); Object.assign(replay.jar, stolen); expect((await replay.api('GET', '/api/phone/telephony/diagnostics')).status).toBe(401);
});

test('viewer mutations all fail with 403 and write nothing', async () => {
  const c = people.viewer_ok, id = '00000000-0000-0000-0000-000000000001', before = dbWrites();
  const attempts = [['POST', '/api/phone/numbers/provision', { country: 'US', kind: 'personal' }], ['POST', '/api/phone/numbers/' + id + '/state', { state: 'active' }], ['POST', '/api/phone/numbers/' + id + '/reassign', { to: 'x' }],
    ['POST', '/api/phone/numbers/' + id + '/caller-id', { verified: true }], ['POST', '/api/phone/usage/' + id + '/adjust', { kind: 'refund', amountMicros: 1, reason: 'x' }], ['PUT', '/api/phone/limits/' + c.id, { monthlyLimitMicros: 1 }],
    ['POST', '/api/phone/provider/test-connection', {}], ['POST', '/api/phone/calls', { to: '+12025550100' }], ['GET', '/api/phone/numbers/available?country=US']];
  for (const [m, p, b] of attempts) { const r = await c.api(m, p, b); expect(r.status, m + ' ' + p).toBe(403); }
  expect(dbWrites()).toBe(before);
});

test('administrator authorization is preserved: an admin passes the permission check (and is then refused for bad input or a closed gate, with no write)', async () => {
  const c = people.adm_test, id = '00000000-0000-0000-0000-000000000001', before = dbWrites();
  const adj = await c.api('POST', '/api/phone/usage/' + id + '/adjust', { kind: 'bogus', amountMicros: 1, reason: 'x' }); expect(adj.status).toBe(400); expect(adj.json.code).toBe('INVALID_KIND');
  const lim = await c.api('PUT', '/api/phone/limits/u_x', { monthlyLimitMicros: -1 }); expect(lim.status).toBe(400);
  const prov = await c.api('POST', '/api/phone/numbers/provision', { country: 'US', kind: 'personal' }); expect([403, 503]).toContain(prov.status);   // numbers/PSTN gates are OFF: nothing can be bought
  expect(dbWrites()).toBe(before);
});

test('no bypass: forged headers, query parameters, alternate paths and the Meet bridge itself do not widen access', async () => {
  const cust = people.cust_plain;
  for (const h of [{ 'x-qorlla-viewer': '1' }, { 'x-qorlla-admin': '1' }, { 'x-qorlla-actor': people.adm_test.id, 'x-qorlla-admin': '1', 'x-qorlla-viewer': '1' }]) expect(privileged(await diag(cust, h)), JSON.stringify(h)).toBe(false);
  for (const p of ['/api/phone/telephony/diagnostics?admin=1&viewer=1&actor=' + people.adm_test.id, '/api/phone/telephony/diagnostics/', '/api/phone/telephony/diagnostics?viewerRead=true']) expect(privileged(await cust.api('GET', p)), p).toBe(false);
  const lst = await cust.api('GET', '/api/phone/numbers?kind=dialin&owner=' + people.adm_test.id);
  expect(lst.status === 403 || (Array.isArray(lst.json) && lst.json.length === 0), 'no inventory leaks to an ordinary account (gate closed: 403; open: only its own numbers)').toBe(true);
  if (MEET) for (const h of [{}, { 'x-qorlla-actor': 'u_x', 'x-qorlla-viewer': '1' }, { 'x-qorlla-actor': 'u_x', 'x-qorlla-admin': '1', authorization: 'Bearer guess' }]) {
    const r = await fetch(MEET + '/api/integrations/telephony/numbers/requests', { headers: h }); expect([401, 403, 404], 'direct Meet ' + JSON.stringify(h)).toContain(r.status);
  }
  expect((await client().api('GET', '/api/phone/telephony/diagnostics')).status).toBe(401);          // authentication preserved
  const sc = (await client().api('POST', '/api/auth/login', { username: 'viewer_ok', password: PASSWORD })).headers.get('set-cookie') || ''; expect(sc).toMatch(/HttpOnly/i); expect(sc).toMatch(/SameSite/i);   // session cookie attributes preserved
});

test('audit: viewer reads are recorded, without secrets; an administrator read is not a viewer read', async () => {
  const c = people.viewer_ok; await diag(c);
  const lines = fs.readFileSync(AUDIT(), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); const mine = lines.filter((l) => l.username === 'viewer_ok');
  expect(mine.length).toBeGreaterThan(0); expect(mine[mine.length - 1]).toMatchObject({ event: 'number_authority_view', route: 'GET /diagnostics', userId: c.id });
  const raw = fs.readFileSync(AUDIT(), 'utf8'); for (const secret of [PASSWORD, ...Object.values(c.jar)]) if (secret.length > 8) expect(raw.includes(secret)).toBe(false);
  expect(lines.some((l) => l.username === 'adm_test' || l.username === 'cust_plain' || l.username === 'viewer_unver')).toBe(false);
});

test('audit failure fails closed: if the read cannot be audited it is refused (503) and administrators are unaffected', async () => {
  const f = AUDIT(), keep = f + '.keep'; fs.renameSync(f, keep); fs.mkdirSync(f);       // a directory where the file should be: appending fails
  try {
    const r = await diag(people.viewer_ok); expect(r.status).toBe(503); expect(r.json.code).toBe('AUDIT_UNAVAILABLE'); expect(privileged(r)).toBe(false);
    expect(privileged(await diag(people.adm_test))).toBe(true);
  } finally { fs.rmdirSync(f); fs.renameSync(keep, f); }
  expect(privileged(await diag(people.viewer_ok))).toBe(true);
});

test('browser panel: viewer sees inactive labels, a read-only Number Authority view and no mutation controls', async ({ page }) => {
  const login = await page.request.post(MAIN + '/api/auth/login', { data: { username: 'viewer_ok', password: PASSWORD } }); expect(login.status()).toBe(200);
  await page.goto(MAIN + '/qorlla.html#home'); await page.locator('.nav-item[data-view=phone]').click();
  await page.locator('#phTab-settings').click();
  await expect(page.locator('#qpNoNumber')).toContainText('No number assigned'); await expect(page.locator('#qpNoNumber')).toContainText('carrier setup pending');
  await expect(page.locator('#qpReqNum')).toBeHidden();                                                // no "Request number" for a viewer
  await page.locator('#phSettingsBtn').click(); await expect(page.locator('#psPage')).toBeVisible();
  await expect(page.locator('#psBody .feat-note').first()).toContainText('Not Active');
  await page.locator('#psNav-admin').click(); await expect(page.locator('#psViewerNote')).toContainText('read-only');
  await expect(page.locator('#psBody button')).toHaveCount(0); await expect(page.locator('#qpReqSend')).toHaveCount(0); await expect(page.locator('#psOpenAdmin')).toHaveCount(0);
  await page.screenshot({ path: path.join(DATA, '..', 'viewer-panel.png') });
});
