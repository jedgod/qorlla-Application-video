// Security Shield v2.2: the ten certification scenarios, run against a REAL running engine (HTTP + WebSocket) on real PostgreSQL, with real signed credentials.
// Not isolated policy functions: every assertion goes through the same routes a gateway, an edge server or a browser would use.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { isolatedDb, identityProvider } from './helpers.mjs';
import { harness, ADMIN } from './harness.mjs';
import { evaluate, classifyDestination } from '../src/shield.mjs';

let db, idp, h, r, wk, workloadIdp;
const A = '+14155552671', B = '+12025550123', DEST = '+16502530000', GB = '+442071838750', END = () => new Date(Date.now() + 3600e3).toISOString();

async function workloadProvider() {
  const { publicKey, privateKey } = await generateKeyPair('ES256'), jwk = { ...(await exportJWK(publicKey)), kid: 'w1', alg: 'ES256', use: 'sig' }, other = await generateKeyPair('ES256');
  const srv = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const token = (sub, o = {}) => new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'w1' }).setSubject(sub).setIssuer(o.iss || 'qorlla-workload').setAudience(o.aud || 'qorlla-shield').setJti(o.jti || randomUUID() + randomUUID())
    .setIssuedAt(o.iat).setExpirationTime(o.exp || '2m').sign(o.wrongKey ? other.privateKey : privateKey);
  return { url: 'http://127.0.0.1:' + srv.address().port + '/jwks.json', token, close: () => new Promise((ok) => srv.close(ok)) };
}
const ALLOWED = 'svc:admin=shield.admin|voice.admin;svc:pstn=pstn.authorize|pstn.consume|pstn.settle;svc:edge=guest.admit;svc:media=media.consume;svc:numbers=numbers.sync';
const ENV = () => ({ SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_WORKLOAD_JWKS_URL: workloadIdp.url, SHIELD_WORKLOAD_ISSUER: 'qorlla-workload', SHIELD_WORKLOAD_ALLOWED: ALLOWED, SHIELD_PSTN_RESERVE_CENTS: '100', SHIELD_NUMBERS_AUTHORITY: 'svc:numbers', SHIELD_GUEST_CLIENT_PER_MIN: '5', SHIELD_GUEST_MEETING_PER_MIN: '20' });

before(async () => {
  db = await isolatedDb(); if (!db) return; idp = await identityProvider(); workloadIdp = await workloadProvider();
  h = harness({ db, idp }); r = await h.replica({ env: ENV() });
  wk = (method, path, body, sub = 'svc:admin', o = {}) => fetch(r.base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (o.token || '') , ...(o.headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  wk = async (method, path, body, sub = 'svc:admin', o = {}) => { const token = o.token ?? await workloadIdp.token(sub, o), res = await fetch((o.base || r.base) + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => ({})) }; };
  const put = async (p, body) => assert.equal((await wk('PUT', '/v1/shield/admin/' + p, body)).status, 200, p + ' ' + JSON.stringify(body));
  for (const o of [{ orgId: 'orgA', pstnEnabled: true, allowedCountries: ['US'], maxActiveCalls: 2, maxCallsHour: 100, spendLimitCents: 100000 }, { orgId: 'orgB', pstnEnabled: true, allowedCountries: ['US'], maxActiveCalls: 2, maxCallsHour: 100, spendLimitCents: 100000 },
    { orgId: 'orgSpend', pstnEnabled: true, allowedCountries: ['US'], maxActiveCalls: 10, maxCallsHour: 100, spendLimitCents: 250 }, { orgId: 'orgVelocity', pstnEnabled: true, allowedCountries: ['US'], maxActiveCalls: 10, maxCallsHour: 2, spendLimitCents: 100000 }, { orgId: 'orgOff', pstnEnabled: false }]) await put('orgs', o);
  for (const [accountId, orgId, verified] of [['alice', 'orgA', true], ['bob', 'orgA', true], ['mallory', 'orgB', true], ['unver', 'orgA', false], ['spender', 'orgSpend', true], ['fast', 'orgVelocity', true], ['nopstn', 'orgOff', true]]) await put('principals', { accountId, orgId, verified });
  for (const [e164, accountId] of [[A, 'alice'], [B, 'bob'], ['+13105550101', 'spender'], ['+13105550102', 'fast'], ['+13105550103', 'unver'], ['+13105550104', 'nopstn']]) await own(e164, accountId);
});
after(async () => { if (h) await h.closeAll(); if (idp) await idp.close(); if (workloadIdp) await workloadIdp.close(); if (db) await db.drop(); });
const skip = (t) => !db && t.skip('no PostgreSQL reachable');
/** A number enters the engine only as an authority event (the real route, real workload credential). */
const own = async (e164, accountId) => { const sid = 'PN' + e164.replace(/\D/g, '').padStart(30, '0'); const payload = { providerNumberId: sid, e164, country: 'US', kind: 'personal', accountId, state: 'active', callerIdVerified: true, hold: false, version: 1 }; const x = await wk('POST', '/v1/shield/numbers/events', { eventId: randomUUID(), providerNumberId: sid, version: 1, type: 'number.changed', payload }, 'svc:numbers'); assert.equal(x.body.result, 'applied', JSON.stringify(x.body)); };
const pstn = (b, sub = 'svc:pstn') => wk('POST', '/v1/shield/pstn/authorize', { requestId: randomUUID(), ...b }, sub);
const events = async () => (await db.pool.query('SELECT * FROM shield_events ORDER BY id')).rows;

test('the pure policy and the destination resolver (the unit layer under the service tests)', () => {
  const base = { action: 'org.access', known: true, suspended: false, orgSuspended: false, verified: true, risk: 0, orgId: 'a', resourceOrgId: 'a', scopes: [] };
  assert.equal(evaluate(base).allow, true); assert.equal(evaluate({ ...base, known: false }).reason, 'UNKNOWN_PRINCIPAL'); assert.equal(evaluate({ ...base, suspended: true }).reason, 'SUSPENDED');
  assert.equal(evaluate({ ...base, resourceOrgId: 'b' }).reason, 'CROSS_TENANT'); assert.equal(evaluate({ ...base, verified: false }).reason, 'IDENTITY_UNVERIFIED'); assert.equal(evaluate({ ...base, risk: 90 }).reason, 'HIGH_RISK');
  assert.equal(evaluate({ ...base, action: 'admin.mutate' }).reason, 'SCOPE_MISSING');
  assert.equal(classifyDestination('+19005551234').reason, 'DESTINATION_CLASS_BLOCKED'); assert.equal(classifyDestination('+18005551234').ok, false); assert.equal(classifyDestination('911').reason, 'EMERGENCY_NUMBER_NOT_SUPPORTED'); assert.equal(classifyDestination('+112').reason, 'EMERGENCY_NUMBER_NOT_SUPPORTED');
  assert.equal(classifyDestination('0044207').ok, false); assert.equal(classifyDestination(DEST).country, 'US');
});

test('SERVICE IDENTITY: unauthenticated, wrongly signed, wrong audience, unlisted, wrong-scope, replayed and over-long workload credentials cannot invoke privileged APIs; the shared secret can be switched off', async (t) => {
  if (skip(t)) return;
  const call = (token, path = '/v1/shield/admin/principals') => fetch(r.base + path, { method: 'PUT', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify({ accountId: 'x1', orgId: 'orgA', verified: true }) }).then((x) => x.status);
  assert.equal(await call(null), 401); assert.equal(await call('garbage'), 401);
  assert.equal(await call(await workloadIdp.token('svc:admin', { wrongKey: true })), 401, 'wrong signing key'); assert.equal(await call(await workloadIdp.token('svc:admin', { aud: 'qorlla-voice' })), 401, 'wrong audience'); assert.equal(await call(await workloadIdp.token('svc:admin', { iss: 'someone-else' })), 401, 'wrong issuer');
  assert.equal(await call(await workloadIdp.token('svc:admin', { exp: '1h' })), 401, 'lifetime above 5 minutes');
  assert.equal(await call(await workloadIdp.token('svc:stranger')), 403, 'valid signature, not on the allow-list');
  assert.equal(await call(await workloadIdp.token('svc:edge')), 403, 'listed workload, wrong scope (guest edge calling the admin API)');
  assert.equal(await call(await workloadIdp.token('svc:pstn')), 403);
  assert.equal(await call(await idp.token('alice')), 401, 'an END-USER token is not a workload credential');
  const jti = randomUUID() + randomUUID(), tk = await workloadIdp.token('svc:admin', { jti });
  assert.equal(await call(tk), 200); assert.equal(await call(tk), 401, 'the same credential presented twice (replay)');
  // the legacy shared secret keeps working on a replica that allows it, and is refused on one that requires workload identity
  assert.equal((await r.admin('GET', '/identities')).status, 200);
  const strict = await h.replica({ env: { ...ENV(), SHIELD_REQUIRE_WORKLOAD_IDENTITY: 'true' } });
  assert.equal((await strict.admin('GET', '/identities')).status, 401, 'shared secret refused when workload identity is required');
  const viaWorkload = await fetch(strict.base + '/v1/voice/admin/identities', { headers: { authorization: 'Bearer ' + await workloadIdp.token('svc:admin') } }); assert.equal(viaWorkload.status, 200, 'the admin API accepts a short-lived workload credential');
  const wrongScope = await fetch(strict.base + '/v1/voice/admin/identities', { headers: { authorization: 'Bearer ' + await workloadIdp.token('svc:pstn') } }); assert.equal(wrongScope.status, 401);
});

test('ACCOUNT TAKEOVER + EMERGENCY SUSPENSION: unknown, suspended and revoked identities lose protected access immediately, including open sockets, outstanding PSTN authorizations and active PSTN calls', async (t) => {
  if (skip(t)) return;
  await r.admin('POST', '/identities', { accountId: 'victim' }); await wk('PUT', '/v1/shield/admin/principals', { accountId: 'victim', orgId: 'orgA', verified: true }); await own('+13105550199', 'victim');
  assert.equal((await r.api('victim', 'GET', '/v1/voice/me')).status, 200);
  assert.equal((await r.api('ghost', 'GET', '/v1/voice/me')).status, 401, 'a valid token for a principal the shield has never heard of fails closed');
  const sock = await r.connect('victim'), outstanding = (await pstn({ accountId: 'victim', destination: DEST, callerId: '+13105550199' })).body, active = (await pstn({ accountId: 'victim', destination: DEST, callerId: '+13105550199' })).body;
  assert.equal(outstanding.allow, true); assert.equal((await wk('POST', '/v1/shield/pstn/consume', { authorizationId: active.authorizationId, accountId: 'victim', destination: DEST, callerId: '+13105550199' }, 'svc:pstn')).body.valid, true);
  const oldToken = await idp.token('victim');
  const s = await wk('POST', '/v1/shield/admin/principals/victim/suspend', {}); assert.equal(s.status, 200); assert.deepEqual(s.body.terminate, [active.authorizationId], 'the gateway is told which live PSTN call to hang up');
  assert.equal(await sock.closed, 4003, 'the open signaling socket was closed');
  const me = await fetch(r.base + '/v1/voice/me', { headers: { authorization: 'Bearer ' + oldToken } }); assert.equal(me.status, 403, 'the old, still unexpired token is refused');
  assert.equal((await wk('POST', '/v1/shield/pstn/consume', { authorizationId: outstanding.authorizationId, accountId: 'victim', destination: DEST, callerId: '+13105550199' }, 'svc:pstn')).body.valid, false, 'the outstanding authorization is dead');
  assert.equal((await pstn({ accountId: 'victim', destination: DEST, callerId: '+13105550199' })).body.reason, 'SUSPENDED');
  assert.deepEqual((await wk('POST', '/v1/shield/pstn/terminations', {}, 'svc:pstn')).body.terminate, [active.authorizationId]);
  assert.equal((await r.api('victim', 'POST', '/v1/shield/authorize', { action: 'org.access', resourceOrgId: 'orgA' })).status, 403);
  // restoring does not resurrect credentials issued before the suspension: only a token minted afterwards works
  assert.equal((await wk('POST', '/v1/shield/admin/principals/victim/restore', {})).status, 200); await r.admin('POST', '/identities/victim/enabled', { enabled: true });
  assert.equal((await fetch(r.base + '/v1/voice/me', { headers: { authorization: 'Bearer ' + oldToken } })).status, 401, 'a credential from before the suspension stays revoked');
  await new Promise((ok) => setTimeout(ok, 1100)); assert.equal((await r.api('victim', 'GET', '/v1/voice/me')).status, 200);
});

test('CALLER-ID SPOOFING + TOLL FRAUD: unowned caller IDs, risky destinations, unlisted countries, emergency numbers, unverified/disabled accounts, concurrency, velocity and spend limits are refused; client-supplied "allowed" flags do nothing', async (t) => {
  if (skip(t)) return;
  const deny = async (b, reason, sub) => { const x = await pstn(b, sub); assert.equal(x.status, 403, JSON.stringify(x.body)); assert.equal(x.body.reason, reason); };
  await deny({ accountId: 'alice', destination: DEST, callerId: B }, 'CALLER_ID_NOT_OWNED');                                    // bob's number
  await deny({ accountId: 'alice', destination: DEST, callerId: '+14155550000' }, 'CALLER_ID_NOT_OWNED');                       // a number nobody registered
  await deny({ accountId: 'alice', destination: '+19005551234', callerId: A }, 'DESTINATION_CLASS_BLOCKED');                    // premium rate
  await deny({ accountId: 'alice', destination: '+18005551234', callerId: A }, 'DESTINATION_CLASS_BLOCKED');
  await deny({ accountId: 'alice', destination: GB, callerId: A }, 'DESTINATION_COUNTRY_NOT_ALLOWED');                         // valid number, country not in the allow-list
  await deny({ accountId: 'alice', destination: '911', callerId: A }, 'EMERGENCY_NUMBER_NOT_SUPPORTED');
  await deny({ accountId: 'alice', destination: 'not a number', callerId: A }, 'DESTINATION_INVALID');
  await deny({ accountId: 'unver', destination: DEST, callerId: '+13105550103' }, 'IDENTITY_UNVERIFIED');
  await deny({ accountId: 'nopstn', destination: DEST, callerId: '+13105550104' }, 'PSTN_DISABLED');
  await deny({ accountId: 'ghost', destination: DEST, callerId: A }, 'UNKNOWN_PRINCIPAL');
  const flag = await pstn({ accountId: 'alice', destination: GB, callerId: A, destinationAllowed: true, international: false }); assert.equal(flag.status, 400, 'client-supplied destinationAllowed is not part of the contract');
  assert.equal((await pstn({ accountId: 'alice', destination: DEST, callerId: A }, 'svc:edge')).status, 403, 'only the PSTN gateway workload may authorize calls');
  // concurrency (orgA allows 2 live calls per account)
  const ok1 = await pstn({ accountId: 'alice', destination: DEST, callerId: A }), ok2 = await pstn({ accountId: 'alice', destination: DEST, callerId: A });
  assert.equal(ok1.body.allow && ok2.body.allow, true); await deny({ accountId: 'alice', destination: DEST, callerId: A }, 'CONCURRENCY_LIMIT');
  // 6 simultaneous requests for a fresh account of orgVelocity/orgSpend never exceed their ceilings (atomic)
  const burst = await Promise.all(Array.from({ length: 6 }, () => pstn({ accountId: 'spender', destination: DEST, callerId: '+13105550101' })));
  assert.equal(burst.filter((x) => x.body.allow).length, 2, 'spend limit 250 cents / reserve 100 = exactly 2'); assert.ok(burst.every((x) => x.body.allow || x.body.reason === 'SPEND_LIMIT'));
  assert.equal((await db.pool.query("SELECT spent_cents FROM shield_orgs WHERE org_id='orgSpend'")).rows[0].spent_cents, '200');
  const fast = []; for (let i = 0; i < 4; i++) fast.push(await pstn({ accountId: 'fast', destination: DEST, callerId: '+13105550102' })); assert.deepEqual(fast.map((x) => x.body.allow), [true, true, false, false]); assert.equal(fast[2].body.reason, 'VELOCITY_LIMIT');
  // settlement releases unused reservation, once
  const settle = await wk('POST', '/v1/shield/pstn/settle', { authorizationId: ok1.body.authorizationId, actualCents: 10 }, 'svc:pstn'); assert.equal(settle.body.settled, true);
  assert.equal((await wk('POST', '/v1/shield/pstn/settle', { authorizationId: ok1.body.authorizationId, actualCents: 10 }, 'svc:pstn')).body.settled, false, 'a second settlement changes nothing');
});

test('REPLAY: a PSTN authorization is single use, bound to account+destination+caller ID, and expires; request IDs cannot be reused; webhook-style workload credentials are one-shot', async (t) => {
  if (skip(t)) return;
  await wk('PUT', '/v1/shield/admin/principals', { accountId: 'rep', orgId: 'orgB', verified: true }); await own('+13105550133', 'rep');
  const requestId = randomUUID(), a = await wk('POST', '/v1/shield/pstn/authorize', { requestId, accountId: 'rep', destination: DEST, callerId: '+13105550133' }, 'svc:pstn'); assert.equal(a.body.allow, true);
  const again = await wk('POST', '/v1/shield/pstn/authorize', { requestId, accountId: 'rep', destination: DEST, callerId: '+13105550133' }, 'svc:pstn'); assert.equal(again.body.allow, false); assert.equal(again.body.reason, 'REPLAYED_REQUEST'); assert.equal(again.body.authorizationId, undefined, 'a replay never re-issues the authorization');
  assert.equal((await wk('POST', '/v1/shield/pstn/authorize', { requestId, accountId: 'rep', destination: '+16502530001', callerId: '+13105550133' }, 'svc:pstn')).body.reason, 'REQUEST_ID_REUSED');
  const c = (over = {}) => wk('POST', '/v1/shield/pstn/consume', { authorizationId: a.body.authorizationId, accountId: 'rep', destination: DEST, callerId: '+13105550133', ...over }, 'svc:pstn');
  assert.equal((await c({ destination: '+16502530001' })).body.valid, false, 'a different destination'); assert.equal((await c({ accountId: 'alice' })).body.valid, false, 'a different account'); assert.equal((await c({ callerId: A })).body.valid, false);
  assert.equal((await c()).body.valid, true); assert.equal((await c()).body.valid, false, 'second use');
  const b = (await pstn({ accountId: 'rep', destination: DEST, callerId: '+13105550133' })).body; await db.pool.query("UPDATE shield_authorizations SET expires_at = now() - interval '1 second' WHERE id=$1", [b.authorizationId]);
  assert.equal((await c({ authorizationId: b.authorizationId })).body.valid, false, 'expired');
  const dual = await Promise.all(Array.from({ length: 5 }, async () => { const x = (await pstn({ accountId: 'rep', destination: DEST, callerId: '+13105550133' })).body; return x.authorizationId; })); const id = dual.find(Boolean);
  const race = await Promise.all(Array.from({ length: 6 }, () => c({ authorizationId: id }))); assert.equal(race.filter((x) => x.body.valid).length, 1, 'concurrent duplicates: exactly one wins');
});

test('GUEST ADMISSION + MEETING PHISHING + MEDIA AUTHORIZATION: ID+passcode only, brute force and enumeration restricted, host approval enforced, one-time meeting-scoped media credential', async (t) => {
  if (skip(t)) return;
  // the limiter counts in fixed 60 s windows: start this test early in a window so a minute boundary cannot reset the counters half way (that made it flaky under load)
  { const sec = (await db.pool.query('SELECT mod(extract(epoch from now())::numeric, 60)::float8 AS s')).rows[0].s; if (sec > 15) await new Promise((ok) => setTimeout(ok, (61 - sec) * 1000)); }
  const meet = (id, o = {}) => wk('PUT', '/v1/shield/admin/meetings', { meetingId: id, orgId: 'orgA', hostAccountId: 'alice', passcode: 'correct-horse-9', guestEnabled: true, requiresApproval: true, maxGuests: 3, endsAt: END(), ...o });
  assert.equal((await meet('m-happy')).status, 200); assert.equal((await meet('m-other')).status, 200); await meet('m-closed', { guestEnabled: false });
  const ask = (b, key = 'edge-' + randomUUID()) => wk('POST', '/v1/shield/guest/request', { meetingId: 'm-happy', passcode: 'correct-horse-9', displayName: 'Guest One', clientKey: key, ...b }, 'svc:edge');
  // uniform refusal: wrong passcode, unknown meeting, disabled guests all look the same
  const wrong = await ask({ passcode: 'wrong-passcode' }), ghost = await ask({ meetingId: 'm-nope' }), closed = await ask({ meetingId: 'm-closed' });
  for (const x of [wrong, ghost, closed]) { assert.equal(x.status, 403); assert.equal(x.body.reason, 'INVALID_MEETING_OR_PASSCODE'); }
  assert.deepEqual(Object.keys(wrong.body).sort(), Object.keys(ghost.body).sort());
  // a guest gets no extension/number/messaging fields and cannot smuggle any in
  const smuggle = await ask({ extension: '5555' }); assert.equal(smuggle.status, 400);
  // one client guessing: limited after 5 a minute, even with the right passcode afterwards
  const k = 'brute-' + randomUUID(); const tries = []; for (let i = 0; i < 7; i++) tries.push((await ask({ passcode: 'guess-' + i }, k)).status); assert.deepEqual(tries.slice(5), [429, 429]); assert.equal((await ask({}, k)).status, 429, 'the right passcode does not bypass the limiter');
  // distributed guessing: many client keys against one meeting hit the per-meeting ceiling
  const spread = []; for (let i = 0; i < 24; i++) spread.push((await ask({ meetingId: 'm-other', passcode: 'guess-' + i })).status); assert.ok(spread.includes(429), 'per-meeting ceiling reached');
  assert.equal((await ask({ meetingId: 'm-other' })).status, 429, 'while attacked, the meeting does not hand out admissions');
  // the happy path
  const req = await ask({}); assert.equal(req.status, 202); assert.equal(req.body.status, 'WAITING'); const { admissionId, claimSecret } = req.body;
  const claim = (b = {}, sub = 'svc:edge') => wk('POST', '/v1/shield/guest/claim', { admissionId, claimSecret, ...b }, sub);
  assert.equal((await claim()).body.status, 'WAITING'); assert.equal((await claim()).body.mediaToken, undefined, 'no media credential before the host approves');
  assert.equal((await claim({ claimSecret: 'x'.repeat(40) })).status, 403, 'wrong claim secret');
  const decide = (account, decision, id = admissionId) => r.api(account, 'POST', `/v1/shield/guest/${id}/decision`, { decision });
  assert.equal((await decide('bob', 'approve')).status, 403, 'a colleague who is not the host'); assert.equal((await decide('mallory', 'approve')).status, 403, 'a member of another organization'); assert.equal((await decide('ghost', 'approve')).status, 401);
  assert.equal((await fetch(r.base + `/v1/shield/guest/${admissionId}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"decision":"approve"}' })).status, 401, 'anonymous');
  assert.equal((await claim({}, 'svc:media')).status, 403, 'the media gateway workload cannot claim');
  assert.equal((await decide('alice', 'approve')).status, 200);
  const issued = await claim(); assert.equal(issued.status, 200); assert.equal(issued.body.status, 'ADMITTED'); assert.deepEqual(issued.body.capabilities, ['meeting.media.join']); const mediaToken = issued.body.mediaToken;
  assert.equal((await claim()).status, 403, 'the claim secret cannot be used twice');
  const consume = (token, meetingId = 'm-happy', sub = 'svc:media') => wk('POST', '/v1/shield/media/consume', { token, meetingId }, sub);
  assert.equal((await consume(mediaToken, 'm-other')).body.valid, false, 'credential is bound to its own meeting'); assert.equal((await consume(mediaToken, 'm-happy', 'svc:edge')).status, 403);
  // privilege escalation: the media credential and the claim secret are useless as Qorlla credentials
  for (const [path, method] of [['/v1/voice/me', 'GET'], ['/v1/voice/calls', 'POST'], ['/v1/voice/ws-ticket', 'POST'], ['/v1/shield/authorize', 'POST']]) assert.equal((await fetch(r.base + path, { method, headers: { authorization: 'Bearer ' + mediaToken, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined })).status, 401, path);
  assert.equal((await fetch(r.base + '/v1/voice/admin/identities', { headers: { authorization: 'Bearer ' + mediaToken } })).status, 401);
  assert.ok(!(await r.admin('GET', '/identities')).body.identities.some((i) => /guest/i.test(i.account_id)), 'a guest never receives a Qorlla extension');
  const first = await consume(mediaToken); assert.equal(first.body.valid, true); assert.equal(first.body.capabilities[0], 'meeting.media.join'); assert.equal((await consume(mediaToken)).body.valid, false, 'media credential is single use');
  // removal by the host revokes everything; so does ending the meeting
  const r2 = (await ask({ displayName: 'Guest Two' })).body; assert.equal((await decide('alice', 'approve', r2.admissionId)).status, 200); const t2 = (await claim({ admissionId: r2.admissionId, claimSecret: r2.claimSecret })).body.mediaToken;
  assert.equal((await decide('alice', 'revoke', r2.admissionId)).status, 200); assert.equal((await consume(t2)).body.valid, false, 'a kicked guest\'s credential is dead');
  const r3 = (await ask({ displayName: 'Guest Three' })).body; assert.equal((await decide('alice', 'deny', r3.admissionId)).status, 200); assert.equal((await claim({ admissionId: r3.admissionId, claimSecret: r3.claimSecret })).status, 403, 'denied at the door');
  const r4 = (await ask({ displayName: 'Guest Four' })).body; await decide('alice', 'approve', r4.admissionId); const t4 = (await claim({ admissionId: r4.admissionId, claimSecret: r4.claimSecret })).body.mediaToken;
  assert.equal((await wk('POST', '/v1/shield/admin/meetings/m-happy/end', {})).status, 200); assert.equal((await consume(t4)).body.valid, false, 'ending the meeting kills outstanding credentials');
  assert.equal((await ask({})).status, 403, 'an ended meeting admits nobody');
  // capacity
  await meet('m-small', { maxGuests: 1 }); const first1 = await ask({ meetingId: 'm-small' }); assert.equal(first1.status, 202); assert.equal((await ask({ meetingId: 'm-small' })).body.reason, 'MEETING_FULL');
  // a meeting that does not require approval still issues a credential only through the claim (never directly)
  await meet('m-open', { requiresApproval: false }); const open = (await ask({ meetingId: 'm-open' })).body; assert.equal(open.status, 'ADMITTED'); assert.equal(open.mediaToken, undefined);
});

test('ORGANIZATION ISOLATION: cross-tenant access, forged organization claims, suspended organizations and missing scopes are denied', async (t) => {
  if (skip(t)) return;
  const authz = (account, body) => r.api(account, 'POST', '/v1/shield/authorize', body);
  assert.equal((await authz('alice', { action: 'org.access', resourceOrgId: 'orgA' })).status, 200);
  const cross = await authz('alice', { action: 'org.access', resourceOrgId: 'orgB' }); assert.equal(cross.status, 403); assert.equal(cross.body.reason, 'CROSS_TENANT');
  assert.equal((await authz('mallory', { action: 'org.access', resourceOrgId: 'orgA' })).body.reason, 'CROSS_TENANT');
  assert.equal((await authz('alice', { action: 'org.access', resourceOrgId: 'orgA', orgId: 'orgB' })).status, 400, 'an organization claim in the body is not part of the contract');
  assert.equal((await authz('alice', { action: 'organization.manage' })).body.reason, 'SCOPE_MISSING'); assert.equal((await authz('unver', { action: 'voice.number.assign' })).body.reason, 'IDENTITY_UNVERIFIED');
  assert.equal((await authz('alice', { action: 'admin.mutate' })).body.reason, 'SCOPE_MISSING');
  // a suspended organization loses everything at once
  await wk('PUT', '/v1/shield/admin/orgs', { orgId: 'orgGone', pstnEnabled: true, allowedCountries: ['US'], spendLimitCents: 1000 }); await wk('PUT', '/v1/shield/admin/principals', { accountId: 'carol', orgId: 'orgGone', verified: true }); await own('+13105550177', 'carol');
  const live = (await pstn({ accountId: 'carol', destination: DEST, callerId: '+13105550177' })).body, call = (await pstn({ accountId: 'carol', destination: DEST, callerId: '+13105550177' })).body;
  await wk('POST', '/v1/shield/pstn/consume', { authorizationId: call.authorizationId, accountId: 'carol', destination: DEST, callerId: '+13105550177' }, 'svc:pstn');
  const sus = await wk('POST', '/v1/shield/admin/orgs/orgGone/suspend', {}); assert.equal(sus.status, 200); assert.deepEqual(sus.body.terminate, [call.authorizationId]);
  assert.equal((await authz('carol', { action: 'org.access', resourceOrgId: 'orgGone' })).status, 403); assert.equal((await pstn({ accountId: 'carol', destination: DEST, callerId: '+13105550177' })).body.reason, 'SUSPENDED');
  assert.equal((await wk('POST', '/v1/shield/pstn/consume', { authorizationId: live.authorizationId, accountId: 'carol', destination: DEST, callerId: '+13105550177' }, 'svc:pstn')).body.valid, false);
  assert.equal((await wk('POST', '/v1/shield/admin/orgs/orgGone/restore', {})).status, 200); assert.equal((await authz('carol', { action: 'org.access', resourceOrgId: 'orgGone' })).status, 200);
});

test('FAIL CLOSED: with the shield disabled, unconfigured, or the database unreachable, nothing is granted; the audit log is append-only and holds no secrets', async (t) => {
  if (skip(t)) return;
  const off = await h.replica({ env: { SHIELD_ENABLED: 'false' } });
  for (const p of ['/v1/shield/pstn/authorize', '/v1/shield/guest/request', '/v1/shield/media/consume', '/v1/shield/admin/principals']) assert.equal((await fetch(off.base + p, { method: p.includes('admin') ? 'PUT' : 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + await workloadIdp.token('svc:admin') }, body: '{}' })).status, 503, p);
  const unconfigured = await h.replica({ env: { SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true' } });
  assert.equal((await fetch(unconfigured.base + '/v1/shield/pstn/authorize', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + await workloadIdp.token('svc:pstn') }, body: '{}' })).status, 401, 'no workload allow-list configured: nobody is let in');
  const dead = new pg.Pool({ connectionString: db.pool.options.connectionString, options: db.pool.options.options }); await dead.end();
  const hd = harness({ db: { pool: dead }, idp }); const broken = await hd.replica({ env: ENV(), maintenance: false, outbox: false });
  assert.notEqual((await broken.api('alice', 'GET', '/v1/voice/me')).status, 200, 'database down: the signed-in user is NOT let through'); assert.ok([401, 403, 503].includes((await broken.api('alice', 'GET', '/v1/voice/me')).status));
  assert.ok((await wk('POST', '/v1/shield/pstn/authorize', { requestId: randomUUID(), accountId: 'alice', destination: DEST, callerId: A }, 'svc:pstn', { base: broken.base })).status >= 401, 'database down: no PSTN authorization'); await hd.closeAll();
  // audit
  for (const sql of ["UPDATE shield_events SET reason='x'", 'DELETE FROM shield_events', 'TRUNCATE shield_events']) await assert.rejects(db.pool.query(sql), /append-only/);
  const log = JSON.stringify(await events()); assert.ok(log.length > 1000);
  for (const secret of ['correct-horse-9', 'wrong-passcode', 'claimSecret', 'mediaToken']) assert.ok(!log.includes(secret), 'audit log must not contain ' + secret);
  assert.ok((await events()).some((e) => e.decision === 'DENY') && (await events()).some((e) => e.decision === 'ALLOW'));
  const stored = JSON.stringify((await db.pool.query('SELECT claim_hash FROM shield_guest_admissions')).rows) + JSON.stringify((await db.pool.query('SELECT token_hash FROM shield_media_tokens')).rows); assert.ok(!/correct-horse/.test(stored)); assert.ok((await db.pool.query('SELECT passcode_hash FROM shield_meetings LIMIT 1')).rows[0].passcode_hash.length === 32, 'passcodes are stored as a scrypt hash, never in clear');
});
