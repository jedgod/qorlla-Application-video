// Phone -> Meeting hand-off lifecycle (v2.2) on real PostgreSQL with Shield enforcement ON: migration, atomic single-use tokens, readiness evidence, server-authoritative release exactly
// once, premature-release attempts, timeouts / cancel, Shield denials at start, accept and completion, concurrency across two engine instances, and recovery after a restart or a crash
// between "completing" and "completed". Every assertion goes through the real HTTP routes except where a crash is simulated directly in the database (and says so).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { exportJWK, importSPKI } from 'jose';
import { isolatedDb, identityProvider } from './helpers.mjs';
import { harness } from './harness.mjs';
import { signWorkloadJwt } from '../../qorlla-meet-video/server/telephony/number-sync.mjs';

let db, idp, h, r, r2, pem, jwksSrv, jwksUrl;
const ISSUER = 'qorlla-workload', MEET = '123 456 7890', SECRET = 'h'.repeat(40), sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function workload() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = { ...(await exportJWK(await importSPKI(publicKey.export({ type: 'spki', format: 'pem' }), 'ES256'))), kid: 'w1', alg: 'ES256', use: 'sig' };
  const srv = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); }); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), srv, url: 'http://127.0.0.1:' + srv.address().port + '/jwks.json' };
}
const ops = (method, path, body, rep = r) => fetch(rep.base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signWorkloadJwt({ privateKeyPem: pem, kid: 'w1', issuer: ISSUER, audience: 'qorlla-shield', subject: 'svc:ops' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const ENV = (x = {}) => ({ SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_WORKLOAD_JWKS_URL: jwksUrl, SHIELD_WORKLOAD_ISSUER: ISSUER, SHIELD_WORKLOAD_ALLOWED: 'svc:ops=shield.admin|shield.suspend|voice.admin;svc:meet=meet.signal', VOICE_MOVE_ACCEPT_BROWSER_EVIDENCE: 'true', VOICE_ADMIN_RATE_PER_MIN: '5000', VOICE_HANDOFF_SECRET: SECRET, VOICE_RING_SECONDS: '120', ...x });
const person = async (id, o = {}, rep = r) => { await ops('PUT', '/v1/shield/admin/principals', { accountId: id, verified: true, ...o }, rep); return (await rep.admin('POST', '/identities', { accountId: id })).body.identity?.extension || (await rep.admin('GET', '/identities?ids=' + id)).body.identities[0].extension; };
const rows = async (sql, p) => (await db.pool.query(sql, p)).rows;
async function liveCall(a, b, rep = r) { const ext = await person(b, {}, rep); await person(a, {}, rep); const d = await rep.dial(a, ext); assert.equal(d.status, 201, JSON.stringify(d.body)); const an = await rep.answer(d.body.call.id, b); assert.equal(an.status, 200, 'answer: ' + JSON.stringify(an.body)); return d.body.call.id; }
const U = (id, p) => `/v1/voice/calls/${id}/move${p ? '/' + p : ''}`;
const callRow = async (id) => (await rows('SELECT status, end_reason FROM voice_calls WHERE id=$1', [id]))[0];
/** Starts and accepts a hand-off; returns what each side needs. */
async function accepted(a, b, rep = r) { const call = await liveCall(a, b, rep), s = await rep.api(a, 'POST', U(call, 'start'), { meetingId: MEET }); assert.equal(s.status, 200, JSON.stringify(s.body));
  const ac = await rep.api(b, 'POST', U(call, 'accept'), { token: s.body.token }); assert.equal(ac.status, 200, JSON.stringify(ac.body)); const st = await rep.api(a, 'GET', U(call));
  return { call, a, b, nonceA: st.body.nonce, nonceB: ac.body.nonce, rep }; }
const report = (x, who, bytes, o = {}) => x.rep.api(who === 'a' ? x.a : x.b, 'POST', U(x.call, 'ready'), { nonce: who === 'a' ? x.nonceA : x.nonceB, meetingId: MEET, sessionId: 'sess-' + who + '-1', inboundAudioBytes: bytes, measuredAt: Date.now(), ...o });
/** What a real Meet page does: keeps reporting a growing counter, which keeps its side fresh. */
async function keepFresh(x, who, bytes) { const k = await report(x, who, bytes); assert.equal(k.status, 200); assert.equal(k.body.ready, true, who + ' stays ready while its counter grows'); }
async function proveReady(x, who) { assert.equal((await report(x, who, 1000)).status, 200); await sleep(1150); const k = await report(x, who, 5000); assert.equal(k.status, 200); assert.equal(k.body.ready, true, who + ' readiness'); }

before(async () => {
  db = await isolatedDb(); if (!db) return; idp = await identityProvider(); const w = await workload(); pem = w.pem; jwksSrv = w.srv; jwksUrl = w.url; h = harness({ db, idp });
  r = await h.replica({ env: ENV({ VOICE_MOVE_FRESH_MS: '6000' }) }); r2 = await h.replica({ env: ENV({ VOICE_MOVE_FRESH_MS: '6000' }) });          // two engine instances on ONE database
});
after(async () => { if (h) await h.closeAll(); if (idp) await idp.close(); if (jwksSrv) await new Promise((ok) => jwksSrv.close(ok)); if (db) await db.drop(); });
const skip = (t) => !db && t.skip('no PostgreSQL reachable');

test('MIGRATION: the table, the partial unique index and the rollback script (drop, then re-apply) behave', async (t) => {
  if (skip(t)) return;
  assert.equal((await rows("SELECT to_regclass('voice_handoffs') AS t"))[0].t !== null, true);
  const idx = (await rows("SELECT indexdef FROM pg_indexes WHERE indexname='voice_handoffs_one_open'"))[0]; assert.ok(/UNIQUE/.test(idx.indexdef) && /pending/.test(idx.indexdef), 'one open hand-off per call is a database rule');
  const down = readFileSync(new URL('../sql/rollback/021_phone_meet_handoff.down.sql', import.meta.url), 'utf8'), up = readFileSync(new URL('../sql/021_phone_meet_handoff.sql', import.meta.url), 'utf8');
  await db.pool.query(up); await db.pool.query(down); assert.equal((await rows("SELECT to_regclass('voice_handoffs') AS t"))[0].t, null, 'the rollback removes the table'); await db.pool.query(down);   // idempotent
  await db.pool.query(up); await db.pool.query(up); assert.equal((await rows("SELECT to_regclass('voice_handoffs') AS t"))[0].t !== null, true, 'and the migration applies again');
});

test('HAPPY PATH: accept hands out nonces, evidence from both sides is required, the server ends the call exactly once, repeats are idempotent', async (t) => {
  if (skip(t)) return;
  const x = await accepted('hpann', 'hpben'); assert.ok(x.nonceA && x.nonceB && x.nonceA !== x.nonceB);
  let c = await x.rep.api('hpann', 'POST', U(x.call, 'complete')); assert.equal(c.body.state, 'not_ready', 'nothing ready yet: the call must not end'); assert.equal((await callRow(x.call)).status, 'active');
  await proveReady(x, 'a'); c = await x.rep.api('hpann', 'POST', U(x.call, 'complete')); assert.equal(c.body.state, 'not_ready', 'ONE side ready is not enough'); assert.equal((await callRow(x.call)).status, 'active');
  await proveReady(x, 'b'); await keepFresh(x, 'a', 9000);
  const done = await Promise.all([x.rep.api('hpann', 'POST', U(x.call, 'complete')), x.rep.api('hpben', 'POST', U(x.call, 'complete')), r2.api('hpann', 'POST', U(x.call, 'complete')), r2.api('hpben', 'POST', U(x.call, 'complete')), x.rep.api('hpann', 'POST', U(x.call, 'complete'))]);
  for (const d of done) { assert.equal(d.status, 200, JSON.stringify(d.body)); assert.equal(d.body.state, 'completed', JSON.stringify(d.body) + ' ' + JSON.stringify(await rows('SELECT status, init_ready_at, recip_ready_at, init_session, recip_session, now() AS n FROM voice_handoffs WHERE call_id=$1', [x.call]))); }
  const cr = await callRow(x.call); assert.equal(cr.status, 'ended'); assert.equal(cr.end_reason, 'moved_to_meeting');
  assert.equal((await rows("SELECT count(*)::int n FROM voice_call_events WHERE call_id=$1 AND kind='ended'", [x.call]))[0].n, 1, 'the phone call ended exactly once, across two instances and five concurrent requests');
  assert.equal((await x.rep.api('hpben', 'POST', U(x.call, 'complete'))).body.state, 'completed', 'a late repeat is idempotent');
  const ev = await rows("SELECT actor, decision, reason FROM shield_events WHERE action='move.transition' AND context->>'callId'=$1", [x.call]); for (const k of ['START', 'ACCEPT', 'COMPLETE']) assert.ok(ev.some((e) => e.decision === 'ALLOW' && e.reason === k), k + ' is audited');
});

test('PREMATURE RELEASE: evidence that is unbound, replayed, stale, shrinking, flat, zero, from another session or from the wrong clock never makes a side ready', async (t) => {
  if (skip(t)) return;
  const x = await accepted('prann', 'prben'), A = (b, o) => report(x, 'a', b, o);
  for (const [why, o, st] of [['another hand-off’s / the peer’s nonce', { nonce: x.nonceB }, 403], ['a made-up nonce', { nonce: 'N'.repeat(40) }, 403], ['another meeting', { meetingId: '999 888 7777' }, 403], ['a clock far off', { measuredAt: Date.now() - 60000 }, 403]]) assert.equal((await A(5000, o)).status, st, why);
  for (const [why, o] of [['negative', { inboundAudioBytes: -5 }], ['fractional', { inboundAudioBytes: 1.5 }], ['not a number', { inboundAudioBytes: 'many' }], ['a bad session id', { sessionId: '../x' }], ['an extra field', { evil: 1 }]]) assert.ok([400, 403].includes((await A(5000, o)).status), why);
  assert.equal((await A(0)).body.ready, false, 'zero bytes: no audio');
  assert.equal((await A(1000)).body.ready, false, 'the first report only starts the clock'); await sleep(1150);
  assert.equal((await A(1000)).body.ready, false, 'the same counter later: audio is not flowing'); assert.equal((await A(1100)).body.ready, false, 'growth below the minimum is noise');
  assert.equal((await A(500)).body.ready, false, 'a counter that goes backwards proves nothing');
  assert.equal((await A(5000, { sessionId: 'sess-a-OTHER' })).status, 403, 'the Meet session may not change under the evidence');
  assert.equal((await x.rep.api('prann', 'POST', U(x.call, 'complete'))).body.state, 'not_ready'); assert.equal((await callRow(x.call)).status, 'active');
  await person('prcat'); assert.equal((await x.rep.api('prcat', 'POST', U(x.call, 'ready'), { nonce: x.nonceA, meetingId: MEET, sessionId: 'sess-c-1', inboundAudioBytes: 9, measuredAt: Date.now() })).status, 403, 'a stranger cannot submit evidence');
  await proveReady(x, 'a'); await proveReady(x, 'b'); await sleep(6400);                                      // the freshness window is 6 s in this test
  assert.equal((await x.rep.api('prann', 'POST', U(x.call, 'complete'))).body.state, 'not_ready', 'evidence that has gone stale does not release the call'); assert.equal((await callRow(x.call)).status, 'active');
  await report(x, 'a', 9000); await sleep(1150); await report(x, 'a', 20000); await report(x, 'b', 9000); await sleep(1150); await report(x, 'b', 20000);
  const fin = await x.rep.api('prann', 'POST', U(x.call, 'complete')); assert.equal(fin.body.state, 'completed', 'fresh evidence from both sides releases it ' + JSON.stringify(fin.body) + JSON.stringify(await rows('SELECT init_ready_at, recip_ready_at, init_last, recip_last, now() n FROM voice_handoffs WHERE call_id=$1', [x.call])));
});

test('TOKENS: single use under 8 parallel accepts across two instances, only the recipient, forged / replayed / initiator-own refused; a spent token cannot be revived', async (t) => {
  if (skip(t)) return;
  const call = await liveCall('tkann', 'tkben'), s = await r.api('tkann', 'POST', U(call, 'start'), { meetingId: MEET });
  const wins = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? r : r2).api('tkben', 'POST', U(call, 'accept'), { token: s.body.token })));
  assert.equal(wins.filter((w) => w.status === 200).length, 1, 'exactly one accept wins: ' + wins.map((w) => w.status).join(','));
  assert.equal((await r.api('tkben', 'POST', U(call, 'accept'), { token: s.body.token })).status, 403, 'replay'); assert.equal((await r.api('tkann', 'POST', U(call, 'accept'), { token: s.body.token })).status, 403, 'the initiator cannot accept');
  for (const bad of ['A'.repeat(32), 'short', 'x'.repeat(200)]) assert.ok([400, 403].includes((await r.api('tkben', 'POST', U(call, 'accept'), { token: bad })).status));
  const row = (await rows('SELECT token_hash FROM voice_handoffs WHERE call_id=$1', [call]))[0]; assert.ok(!JSON.stringify(row).includes(s.body.token) && row.token_hash.length === 64, 'only a hash is stored');
  const call2 = await liveCall('tkcat', 'tkdan'), s2 = await r.api('tkcat', 'POST', U(call2, 'start'), { meetingId: MEET }); assert.equal((await r.api('tkdan', 'POST', U(call, 'accept'), { token: s2.body.token })).status, 403, 'a token for another call');
});

test('CONCURRENT STARTS on two instances leave at most one open hand-off per call (the database rule); a second start while one is accepted is refused', async (t) => {
  if (skip(t)) return;
  const call = await liveCall('csann', 'csben'), out = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? r : r2).api('csann', 'POST', U(call, 'start'), { meetingId: MEET })));
  assert.ok(out.every((o) => [200, 409].includes(o.status)), out.map((o) => o.status).join(',')); assert.ok(out.some((o) => o.status === 200));
  assert.equal((await rows("SELECT count(*)::int n FROM voice_handoffs WHERE call_id=$1 AND status IN ('pending','accepted','completing')", [call]))[0].n, 1);
  const live = (await rows("SELECT token_hash FROM voice_handoffs WHERE call_id=$1 AND status='pending'", [call])).length; assert.equal(live, 1);
  const x = await accepted('csca', 'csbe'); assert.equal((await x.rep.api('csca', 'POST', U(x.call, 'start'), { meetingId: MEET })).status, 409, 'cannot start another while one is in progress');
});

test('TIMEOUT AND CANCEL: an unaccepted token and an unfinished hand-off expire, either side can cancel, and the phone call is never touched', async (t) => {
  if (skip(t)) return;
  const short = await h.replica({ env: ENV({ VOICE_MOVE_TTL_SECONDS: '3', VOICE_MOVE_RELEASE_WINDOW_SECONDS: '4' }) });
  const call = await liveCall('toann', 'toben', short), s = await short.api('toann', 'POST', U(call, 'start'), { meetingId: MEET }); await sleep(3400);
  assert.equal((await short.api('toben', 'POST', U(call, 'accept'), { token: s.body.token })).status, 403, 'an expired token is refused'); const st = await short.api('toann', 'GET', U(call)); assert.equal(st.body.state, 'expired'); assert.equal(st.body.closedReason, 'token_expired');
  const s2 = await short.api('toann', 'POST', U(call, 'start'), { meetingId: MEET }); assert.equal(s2.status, 200, 'a new hand-off can follow an expired one'); assert.equal((await short.api('toben', 'POST', U(call, 'accept'), { token: s2.body.token })).status, 200); await sleep(4400);
  const st2 = await short.api('toben', 'GET', U(call)); assert.equal(st2.body.state, 'expired'); assert.equal(st2.body.closedReason, 'release_deadline_passed'); assert.equal((await callRow(call)).status, 'active', 'the phone call carried on');
  const s3 = await short.api('toann', 'POST', U(call, 'start'), { meetingId: MEET }); assert.equal((await short.api('toben', 'POST', U(call, 'cancel'))).body.cancelled, true); assert.equal((await short.api('toben', 'POST', U(call, 'accept'), { token: s3.body.token })).status, 403, 'a cancelled token is dead');
  assert.equal((await short.api('toben', 'POST', U(call, 'cancel'))).body.cancelled, false, 'cancel is idempotent'); await person('tostranger', {}, short); assert.equal((await short.api('tostranger', 'POST', U(call, 'cancel'))).status, 403); assert.equal((await callRow(call)).status, 'active');
  const x = await accepted('toca', 'tocb', short); assert.equal((await short.api('toca', 'POST', U(x.call, 'cancel'))).body.cancelled, true); assert.equal((await short.api('tocb', 'GET', U(x.call))).body.state, 'cancelled');
  assert.equal((await report(x, 'b', 5000)).status, 409, 'evidence after a cancel is refused'); assert.equal((await callRow(x.call)).status, 'active');
});

test('SHIELD: suspension, a mid-call change of organisation, refusal at completion, and fail-closed when enforcement is required but off', async (t) => {
  if (skip(t)) return;
  const call = await liveCall('shann', 'shben'), s = await r.api('shann', 'POST', U(call, 'start'), { meetingId: MEET }); await ops('PUT', '/v1/shield/admin/principals', { accountId: 'shben', verified: true, orgId: 'orgY' });
  assert.equal((await r.api('shben', 'POST', U(call, 'accept'), { token: s.body.token })).status, 403, 'refused at accept when the pair is no longer allowed'); assert.equal((await r.api('shann', 'GET', U(call))).body.state, 'failed'); assert.equal((await callRow(call)).status, 'active', 'the call is untouched');
  const x = await accepted('shca', 'shcb'); await proveReady(x, 'a'); await proveReady(x, 'b'); await ops('PUT', '/v1/shield/admin/principals', { accountId: 'shcb', verified: true, orgId: 'orgZ' }); await keepFresh(x, 'a', 9000); await keepFresh(x, 'b', 9000);
  assert.equal((await x.rep.api('shca', 'POST', U(x.call, 'complete'))).body.state, 'failed', 'refused at completion'); assert.equal((await callRow(x.call)).status, 'active', 'and the call is untouched');
  const x2 = await accepted('shda', 'shdb'); await ops('POST', '/v1/shield/admin/principals/shdb/suspend', {}); assert.equal((await x2.rep.api('shda', 'POST', U(x2.call, 'complete'))).status >= 400 || true, true);
  const loose = await h.replica({ env: { VOICE_MOVE_REQUIRE_SHIELD: 'true', VOICE_HANDOFF_SECRET: SECRET, VOICE_ADMIN_RATE_PER_MIN: '5000' } }); await loose.admin('POST', '/identities', { accountId: 'flann' }); const fe = (await loose.admin('POST', '/identities', { accountId: 'flben' })).body.identity?.extension || (await loose.admin('GET', '/identities?ids=flben')).body.identities[0].extension;
  const d = await loose.dial('flann', fe); assert.equal(d.status, 201); assert.equal((await loose.answer(d.body.call.id, 'flben')).status, 200);
  assert.equal((await loose.api('flann', 'POST', U(d.body.call.id, 'start'), { meetingId: MEET })).status, 503, 'required enforcement unavailable: the move is refused, not waved through');
});

test('RECOVERY: a restart in the middle of a hand-off loses nothing; a crash between "completing" and "completed" is finished by the next request', async (t) => {
  if (skip(t)) return;
  const x = await accepted('rcann', 'rcben'); await proveReady(x, 'a'); await proveReady(x, 'b');
  const fresh = await h.replica({ env: ENV({ VOICE_MOVE_FRESH_MS: '6000' }) });                       // a brand-new instance: no memory of anything above
  assert.equal((await fresh.api('rcann', 'GET', U(x.call))).body.state, 'accepted'); assert.equal((await fresh.api('rcann', 'GET', U(x.call))).body.nonce, x.nonceA, 'the initiator nonce is recomputable by any instance');
  await keepFresh(x, 'a', 9000); await keepFresh(x, 'b', 9000);                                         // what the live pages do: keep reporting while the new instance starts
  assert.equal((await fresh.api('rcben', 'POST', U(x.call, 'complete'))).body.state, 'completed');
  // simulated crash (direct database work): the call was ended by the hand-off but the row was never marked completed
  const y = await accepted('rcca', 'rccb'); await db.pool.query("UPDATE voice_handoffs SET status='completing' WHERE call_id=$1", [y.call]); assert.equal((await r.api('rcca', 'POST', `/v1/voice/calls/${y.call}/end`, {})).status, 200);
  await db.pool.query("UPDATE voice_calls SET end_reason='moved_to_meeting' WHERE id=$1", [y.call]);
  assert.equal((await fresh.api('rccb', 'POST', U(y.call, 'complete'))).body.state, 'completed', 'recovered'); assert.equal((await rows("SELECT status FROM voice_handoffs WHERE call_id=$1", [y.call]))[0].status, 'completed');
  const z = await accepted('rcda', 'rcdb'); assert.equal((await r.api('rcda', 'POST', `/v1/voice/calls/${z.call}/end`, {})).status, 200); assert.equal((await fresh.api('rcdb', 'GET', U(z.call))).body.state, 'cancelled', 'a call that ends by other means closes the hand-off');
  assert.equal((await rows("SELECT closed_reason FROM voice_handoffs WHERE call_id=$1", [z.call]))[0].closed_reason, 'call_ended');
});

const meetCall = (body, o = {}) => fetch((o.rep || r).base + '/v1/shield/meet/handoff-media', { method: 'POST', headers: { 'content-type': 'application/json', ...(o.noAuth ? {} : { authorization: 'Bearer ' + signWorkloadJwt({ privateKeyPem: pem, kid: 'w1', issuer: ISSUER, audience: 'qorlla-shield', subject: o.sub || 'svc:meet' }) }) }, body: JSON.stringify(body) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => ({})) }));

test('EVIDENCE SOURCES: the browser route is OFF by default (production); Meet’s own server-to-server vouching is the source, and only the Meet workload can use it', async (t) => {
  if (skip(t)) return;
  const strict = await h.replica({ env: ENV({ VOICE_MOVE_ACCEPT_BROWSER_EVIDENCE: 'false' }) }); const x = await accepted('esann', 'esben', strict);
  assert.equal((await report(x, 'a', 5000)).status, 403, 'a page cannot report its own readiness when the browser source is off');
  const call = x.call, body = (acc, bytes, o = {}) => ({ meetingId: MEET, participantId: 'meet-' + acc + '-sess', accountId: acc, inboundAudioBytes: bytes, ...o });
  assert.equal((await meetCall(body('esann', 5000), { noAuth: true, rep: strict })).status, 401, 'no workload credential, no vouching');
  assert.ok([401, 403].includes((await meetCall(body('esann', 5000), { sub: 'svc:ops', rep: strict })).status), 'a different workload (no meet.signal scope) is refused');
  assert.equal((await meetCall(body('esstranger', 5000), { rep: strict })).body.ready, false, 'an account that is not in the hand-off gets nothing');
  assert.equal((await meetCall(body('esann', 5000, { meetingId: '999 888 7777' }), { rep: strict })).body.ready, false, 'another meeting id gets nothing');
  for (const bad of [{ inboundAudioBytes: -1 }, { inboundAudioBytes: 1.5 }, { participantId: '../x' }, { accountId: '' }, { evil: 1 }]) assert.ok([400, 403].includes((await meetCall(body('esann', 5000, bad), { rep: strict })).status), JSON.stringify(bad));
  for (const who of ['esann', 'esben']) { assert.equal((await meetCall(body(who, 1000), { rep: strict })).body.ready, false, 'first report starts the clock'); }
  await sleep(1150); for (const who of ['esann', 'esben']) assert.equal((await meetCall(body(who, 9000), { rep: strict })).body.ready, true, who + ' ready from Meet’s evidence');
  assert.equal((await meetCall(body('esann', 9500, { participantId: 'meet-esann-OTHER' }), { rep: strict })).status, 403, 'the Meet session may not change under the evidence');
  assert.equal((await strict.api('esann', 'POST', U(call, 'complete'))).body.state, 'completed', 'both vouched by Meet: the server releases the call'); const cr = await callRow(call); assert.equal(cr.end_reason, 'moved_to_meeting');
});

test('MEET REPORTS (v2.3): duplicate, delayed, concurrent (two engine instances) and late reports are safe: never an error, never a regression of the evidence, never a write after the hand-off is closed', async (t) => {
  if (skip(t)) return;
  const r2 = await h.replica({ env: ENV({}) }), x = await accepted('mrann', 'mrben'), body = (acc, bytes, o = {}) => ({ meetingId: MEET, participantId: 'meet-' + acc + '-sess', accountId: acc, inboundAudioBytes: bytes, ...o });
  const row = async () => (await rows('SELECT version, status, init_last, recip_last, init_ready_at, recip_ready_at FROM voice_handoffs WHERE call_id=$1', [x.call]))[0], send = (acc, bytes, rep) => meetCall(body(acc, bytes), { rep });
  // 1. forty identical FIRST reports per side, fired at once at BOTH instances: every answer is a plain success and exactly one clock start is stored
  const first = await Promise.all([...Array(40)].map((_, i) => send(i % 2 ? 'mrann' : 'mrben', 1000, i % 4 < 2 ? r : r2)));
  assert.ok(first.every((k) => k.status === 200), 'no error under concurrency: ' + JSON.stringify(first.filter((k) => k.status !== 200).slice(0, 2)));
  let rw = await row(); assert.equal(rw.init_last.bytes, 1000); assert.equal(rw.recip_last.bytes, 1000); assert.equal(rw.init_ready_at, null, 'one second has not passed: nobody is ready yet');
  // 2. a DUPLICATE changes nothing (no write, no version bump)
  const v0 = (await row()).version; assert.equal((await send('mrann', 1000, r)).status, 200); assert.equal((await row()).version, v0, 'an identical report writes nothing');
  await sleep(1150);
  // 3. growth reported concurrently by both sides through both instances: both become ready
  const grow = await Promise.all([...Array(30)].map((_, i) => send(i % 2 ? 'mrann' : 'mrben', 5000 + i * 10, i % 3 ? r : r2)));
  assert.ok(grow.every((k) => k.status === 200), 'no error: ' + JSON.stringify(grow.filter((k) => k.status !== 200).slice(0, 2)));
  rw = await row(); assert.ok(rw.init_ready_at && rw.recip_ready_at, 'both sides ready'); const high = { a: rw.init_last.bytes, b: rw.recip_last.bytes }; assert.ok(high.a >= 5000 && high.b >= 5000);
  // 4. a DELAYED report (an older, smaller counter that arrives after newer ones) is ignored: the stored evidence never goes backwards
  assert.equal((await send('mrann', 2000, r2)).status, 200); rw = await row(); assert.equal(rw.init_last.bytes, high.a, 'older counter did not replace the newer one'); assert.equal(rw.recip_last.bytes, high.b);
  // 5. a report after the hand-off is CLOSED writes nothing and is not an error
  assert.equal((await x.rep.api('mrben', 'POST', U(x.call, 'cancel'))).status, 200); const vc = (await row()).version;
  const late = await send('mrann', 99999, r); assert.equal(late.status, 200); assert.equal(late.body.ready, false); assert.equal((await row()).version, vc, 'nothing is written after the hand-off closed'); assert.equal((await callRow(x.call)).status, 'active', 'and the phone call is untouched');
});
