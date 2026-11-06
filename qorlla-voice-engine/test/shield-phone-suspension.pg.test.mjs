// A5.5 Phase B1: the Shield's decisions for Qorlla Meet's TELEPHONE callers (accountless guests): the registered host's and organization's CURRENT standing is enforced at authorize and at recheck, ownership that is
// missing or inconsistent never allows silently, and a concurrent suspension has a defined order. Real engine, real PostgreSQL schema, real workload credentials.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { SignJWT, importPKCS8, exportJWK, importSPKI } from 'jose';
import { isolatedDb, identityProvider } from './helpers.mjs';
import { harness } from './harness.mjs';

const ISSUER = 'qorlla-workload';
let db, h, engine, jwks, keys, pool2;
const uuid = () => crypto.randomUUID(), tag = () => crypto.randomBytes(3).toString('hex'), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function key(kid) { const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }); const pem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }); return { kid, pem, priv: await importPKCS8(pem, 'ES256'), jwk: { ...(await exportJWK(await importSPKI(kp.publicKey.export({ type: 'spki', format: 'pem' }), 'ES256'))), kid, alg: 'ES256', use: 'sig' } }; }
const token = (who, o = {}) => new SignJWT({ ...(o.cnf ? { cnf: { 'x5t#S256': o.cnf } } : {}) }).setProtectedHeader({ alg: 'ES256', kid: keys[who].kid }).setIssuer(ISSUER).setSubject(o.sub ?? 'svc:' + who).setAudience('qorlla-shield').setIssuedAt().setExpirationTime('60s').setJti(crypto.randomUUID()).sign(keys[who].priv);
const call = async (who, method, p, body, o = {}) => { const r = await fetch(engine.base + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (o.token ?? await token(who, o)) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const q = (text, p) => db.pool.query(text, p);
const meetingOf = async ({ host = 'acct-host-' + tag(), org = 'org-' + tag(), withOrg = true, withHost = true, hostOrg = org, guest = true } = {}) => {
  if (withOrg) await q('INSERT INTO shield_orgs(org_id) VALUES($1) ON CONFLICT DO NOTHING', [org]);
  if (withHost) await q('INSERT INTO shield_principals(account_id, org_id, verified) VALUES($1,$2,true) ON CONFLICT (account_id) DO UPDATE SET org_id=$2, suspended=false', [host, hostOrg]);
  const id = uuid(), r = await call('meet', 'POST', '/v1/shield/meet/register', { meetingId: id, orgId: withOrg ? org : null, hostAccountId: withHost ? host : null, guestEnabled: guest, endsAt: new Date(Date.now() + 3600e3).toISOString() }); assert.equal(r.status, 200, JSON.stringify(r.body));
  return { id, host, org };
};
const authorize = (m, pid = uuid(), extra = {}) => call('meet', 'POST', '/v1/shield/meet/authorize', { meetingId: m.id, participantId: pid, role: 'guest', admission: 'admitted', ...extra });
const recheck = (m, pids) => call('meet', 'POST', '/v1/shield/meet/recheck', { participants: pids.map((p) => ({ meetingId: m.id, participantId: p })) });
const suspendHost = (m) => call('ops', 'POST', `/v1/shield/admin/principals/${m.host}/suspend`, {}), restoreHost = (m) => call('ops', 'POST', `/v1/shield/admin/principals/${m.host}/restore`, {});
const suspendOrg = (m) => call('ops', 'POST', `/v1/shield/admin/orgs/${m.org}/suspend`, {}), restoreOrg = (m) => call('ops', 'POST', `/v1/shield/admin/orgs/${m.org}/restore`, {});

before(async () => {
  db = await isolatedDb(); if (!db) return;
  keys = { meet: await key('wm'), ops: await key('wo') };
  jwks = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [keys.meet.jwk, keys.ops.jwk] })); }); await new Promise((r) => jwks.listen(0, '127.0.0.1', r));
  const idp = await identityProvider(); h = harness({ db, idp });
  engine = await h.replica({ env: { SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_WORKLOAD_JWKS_URL: 'http://127.0.0.1:' + jwks.address().port + '/', SHIELD_WORKLOAD_ISSUER: ISSUER, SHIELD_WORKLOAD_ALLOWED: 'svc:meet=meet.register|meet.signal|alerts.report;svc:ops=shield.admin|shield.suspend|alerts.report|alerts.read' } });
  pool2 = await db.admin.connect(); await pool2.query('SET search_path=' + db.schema);                                                                                                    // a second session in the same database, for the ordering tests
});
after(async () => { try { pool2?.release(); } catch { /* gone */ } if (h) await h.closeAll().catch(() => {}); if (jwks) await new Promise((r) => jwks.close(r)); if (db) await db.drop(); setTimeout(() => process.exit(process.exitCode || 0), 1500).unref(); });
const skip = (t) => !db && t.skip('needs PostgreSQL (VOICE_TEST_DATABASE_URL)');

test('B1 authorize: a suspended HOST and a suspended ORGANIZATION each deny with their own reason, for accountless guests; restoring them admits again', async (t) => {
  if (skip(t)) return; const m = await meetingOf(); assert.equal((await authorize(m)).status, 200, 'control');
  assert.equal((await suspendHost(m)).status, 200); let a = await authorize(m); assert.deepEqual([a.status, a.body.allow, a.body.reason], [403, false, 'HOST_SUSPENDED']);
  assert.equal((await restoreHost(m)).status, 200); assert.equal((await authorize(m)).status, 200, 'restored');
  assert.equal((await suspendOrg(m)).status, 200); a = await authorize(m); assert.deepEqual([a.status, a.body.allow, a.body.reason], [403, false, 'ORG_SUSPENDED']);
  assert.equal((await restoreOrg(m)).status, 200); assert.equal((await authorize(m)).status, 200, 'restored');
  const deny = (await q("SELECT count(*)::int n FROM shield_events WHERE action='meet.signal' AND decision='DENY' AND reason IN ('HOST_SUSPENDED','ORG_SUSPENDED')")).rows[0].n; assert.ok(deny >= 2, 'both denials are audited');
});

test('B1 authorize: the suspended host asking for ITSELF keeps the existing SUSPENDED answer', async (t) => {
  if (skip(t)) return; const m = await meetingOf(); await suspendHost(m);
  const a = await authorize(m, uuid(), { accountId: m.host, role: 'host' }); assert.deepEqual([a.status, a.body.allow, a.body.reason], [403, false, 'SUSPENDED']);
});

test('B1 ownership that is missing or inconsistent never allows SILENTLY: unknown host, host of another organization, and an ownerless meeting (allowed, but audited and flagged)', async (t) => {
  if (skip(t)) return;
  const unknown = await meetingOf({ withHost: false, host: 'acct-ghost-' + tag() }); await call('meet', 'POST', '/v1/shield/meet/register', { meetingId: unknown.id, orgId: unknown.org, hostAccountId: 'acct-ghost-' + tag(), guestEnabled: true, endsAt: new Date(Date.now() + 3600e3).toISOString() });
  let a = await authorize(unknown); assert.deepEqual([a.status, a.body.reason], [403, 'HOST_UNKNOWN'], 'a registered host the Shield has never heard of');
  const inconsistent = await meetingOf({ hostOrg: 'org-other-' + tag() }); a = await authorize(inconsistent); assert.deepEqual([a.status, a.body.reason], [403, 'OWNER_INCONSISTENT']);
  const ownerless = await meetingOf({ withHost: false, withOrg: false }); a = await authorize(ownerless, uuid()); assert.equal(a.status, 200); assert.equal(a.body.ownership, 'none', 'the answer says there was no owner to check');
  assert.equal((await q("SELECT count(*)::int n FROM shield_events WHERE action='meet.signal' AND reason='guest:OWNERLESS'")).rows[0].n >= 1, true, 'and the allow is audited as ownerless');
  const ended = await meetingOf(); await call('meet', 'POST', '/v1/shield/meet/end', { meetingId: ended.id }); a = await authorize(ended); assert.equal(a.body.reason, 'MEETING_UNKNOWN_OR_ENDED', 'existing protections keep their precedence');
  const noGuests = await meetingOf({ guest: false }); a = await authorize(noGuests); assert.equal(a.body.reason, 'GUEST_NOT_ALLOWED');
});

test('B1 recheck: every participant of a suspended host\'s or organization\'s meeting is revoked (accountless guests included); other meetings are untouched; recovery restores nothing it should not', async (t) => {
  if (skip(t)) return; const a = await meetingOf(), b = await meetingOf(), pa = [uuid(), uuid(), uuid()], pb = [uuid()];
  for (const p of pa) assert.equal((await authorize(a, p)).status, 200); assert.equal((await authorize(b, pb[0])).status, 200);
  assert.deepEqual((await recheck(a, pa)).body.revoke, [], 'nothing to revoke yet');
  await suspendHost(a); let r = await recheck(a, pa); assert.deepEqual(r.body.revoke.map((x) => x.participantId).sort(), [...pa].sort()); assert.ok(r.body.revoke.every((x) => x.reason === 'HOST_SUSPENDED'));
  assert.deepEqual((await recheck(b, pb)).body.revoke, [], 'another meeting is unaffected');
  await restoreHost(a); await suspendOrg(a); r = await recheck(a, pa); assert.ok(r.body.revoke.length === 3 && r.body.revoke.every((x) => x.reason === 'ORG_SUSPENDED'));
});

test('B1 ORDER with a concurrent suspension is defined: an authorize that waits behind an in-flight suspension sees it (denied); one that already read allow is revoked by the next recheck; the suspension\'s commit is the dividing line', async (t) => {
  if (skip(t)) return;
  // (1) the suspension is in flight (row updated, not committed): authorize BLOCKS on the row and then sees the suspension
  const m = await meetingOf(); await pool2.query('BEGIN'); await pool2.query(`UPDATE shield_principals SET suspended=true WHERE account_id=$1`, [m.host]);
  let settled = false; const pending = authorize(m).then((r) => { settled = true; return r; }); await sleep(400); assert.equal(settled, false, 'the authorize waits for the in-flight suspension instead of reading stale state');
  await pool2.query('COMMIT'); const a = await pending; assert.deepEqual([a.status, a.body.reason], [403, 'HOST_SUSPENDED']);
  // (2) an authorize read the host FIRST (holds its share lock): the suspension waits for it; the authorize is allowed (it was before the suspension's commit) and the next recheck revokes it
  const m2 = await meetingOf(), pid = uuid(); await pool2.query('BEGIN'); await pool2.query(`SELECT 1 FROM shield_principals WHERE account_id=$1 FOR SHARE`, [m2.host]);
  let done = false; const susp = suspendHost(m2).then((r) => { done = true; return r; }); await sleep(400); assert.equal(done, false, 'the suspension waits for the authorize that is reading the host');
  await pool2.query('COMMIT'); assert.equal((await susp).status, 200); assert.equal((await authorize(m2, pid)).status, 403, 'any authorize after the commit is denied');
  assert.equal((await recheck(m2, [pid])).body.revoke[0].reason, 'HOST_SUSPENDED', 'and an earlier allow is covered by the recheck');
});

test('B1 RACE: authorizes racing a suspension - none that STARTED after the suspension returned is allowed, and every earlier allow is revoked by recheck', async (t) => {
  if (skip(t)) return; const m = await meetingOf(), N = 24; const early = [], late = [];
  const racers = Array.from({ length: N }, async (_v, i) => { await sleep(i * 8); const pid = uuid(), r = await authorize(m, pid); if (r.status === 200) early.push(pid); });
  await sleep(60); const s = await suspendHost(m); assert.equal(s.status, 200); const suspendedAt = Date.now();
  await Promise.all(racers); for (let i = 0; i < 5; i++) { const pid = uuid(), r = await authorize(m, pid); if (r.status === 200) late.push(pid); }
  assert.deepEqual(late, [], 'nothing is allowed once the suspension has returned (' + (Date.now() - suspendedAt) + ' ms later)');
  const r = await recheck(m, early); assert.deepEqual(r.body.revoke.map((x) => x.participantId).sort(), [...early].sort(), 'every allow that raced the suspension is revoked');
});

test('B1 PRESERVED PROTECTIONS: a replayed token and a certificate-claiming token are still refused', async (t) => {
  if (skip(t)) return; const m = await meetingOf(), tok = await token('meet'), body = { meetingId: m.id, participantId: uuid(), role: 'guest', admission: 'admitted' };
  assert.equal((await call('meet', 'POST', '/v1/shield/meet/authorize', body, { token: tok })).status, 200); assert.equal((await call('meet', 'POST', '/v1/shield/meet/authorize', body, { token: tok })).status, 401);
  assert.ok([401, 403].includes((await call('meet', 'POST', '/v1/shield/meet/authorize', body, { cnf: 'A'.repeat(43) })).status));
});
