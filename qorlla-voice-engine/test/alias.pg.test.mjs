// A3.7 country-aware internal aliases and dial preparation, against a real engine on real PostgreSQL with real workload credentials.
// Scope: internal (account-to-account) only. A "+" destination is classified and refused as PSTN; nothing here can place a call, quote a price or touch a wallet.
// The reserved ranges below are TEST values; a real deployment must configure ranges that are reserved/unallocated in the countries concerned.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { exportJWK, importSPKI } from 'jose';
import { isolatedDb, identityProvider } from './helpers.mjs';
import { harness, until, ADMIN } from './harness.mjs';
import { signWorkloadJwt } from '../../qorlla-meet-video/server/telephony/number-sync.mjs';
import { classifyDial } from '../src/dial.mjs';

let db, idp, h, r, pem, jwksSrv, jwksUrl;
const ISSUER = 'qorlla-workload', NS = JSON.stringify({ GB: { prefix: '0770090', length: 11 }, US: { prefix: '202555', length: 10 }, GH: { prefix: '020000', length: 10 } });
async function workload() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = { ...(await exportJWK(await importSPKI(publicKey.export({ type: 'spki', format: 'pem' }), 'ES256'))), kid: 'w1', alg: 'ES256', use: 'sig' };
  const srv = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); }); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), srv, url: 'http://127.0.0.1:' + srv.address().port + '/jwks.json' };
}
const ops = (method, path, body, rep = r) => fetch(rep.base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signWorkloadJwt({ privateKeyPem: pem, kid: 'w1', issuer: ISSUER, subject: 'svc:ops' }) }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => ({})) }));
const BASE = (extra = {}) => ({ SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_WORKLOAD_JWKS_URL: jwksUrl, SHIELD_WORKLOAD_ISSUER: ISSUER, SHIELD_WORKLOAD_ALLOWED: 'svc:ops=shield.admin|shield.suspend', ...extra });
const variant = (extra, o = {}) => h.replica({ outbox: false, maintenance: false, ...o, env: BASE(extra) });
const person = async (id, o = {}, rep = r) => { await ops('PUT', '/v1/shield/admin/principals', { accountId: id, verified: true, ...o }, rep); return (await rep.admin('POST', '/identities', { accountId: id })).body.identity.extension; };
const getAlias = (rep, as, country) => rep.api(as, 'POST', '/v1/voice/alias', { country, confirm: true });
const prepare = (rep, as, dial) => rep.api(as, 'POST', '/v1/voice/dial/prepare', { dial });
const GATE = { error: 'feature_disabled', feature: 'country_alias', message: 'Country-aware Qorlla numbers are disabled.' };

before(async () => {
  db = await isolatedDb(); if (!db) return; idp = await identityProvider(); const w = await workload(); pem = w.pem; jwksSrv = w.srv; jwksUrl = w.url; h = harness({ db, idp });
  r = await h.replica({ env: BASE({ VOICE_COUNTRY_ALIAS_ENABLED: 'true', VOICE_ALIAS_NAMESPACES: NS }) });
});
after(async () => { if (h) await h.closeAll(); if (idp) await idp.close(); if (jwksSrv) await new Promise((ok) => jwksSrv.close(ok)); if (db) await db.drop(); });
const skip = (t) => !db && t.skip('no PostgreSQL reachable');
const rows = async (sql, p) => (await db.pool.query(sql, p)).rows;

test('CLASSIFICATION: "+" is an external request, "00" is invalid and never becomes "+", emergency numbers are their own kind, 3-8 digits are an extension, 9-15 an internal alias; nothing is guessed', () => {
  const k = (x) => classifyDial(x).kind;
  assert.equal(k('+1 302 444 1516'), 'EXTERNAL_REQUEST'); assert.equal(classifyDial('+1 302 444 1516').e164, '+13024441516'); assert.equal(k('0044 745 667 0202'), 'INVALID'); assert.equal(k('+000'), 'INVALID'); assert.equal(k('+44abc'), 'INVALID'); assert.equal(k('+1'), 'INVALID');
  for (const e of ['911', '112', '999', '000', '110']) assert.equal(k(e), 'EMERGENCY', e); assert.equal(k('5001'), 'INTERNAL_EXTENSION'); assert.equal(k('12345678'), 'INTERNAL_EXTENSION'); assert.equal(k('0808 590 9693'), 'INTERNAL_ALIAS'); assert.equal(classifyDial('(202) 555-0123').national, '2025550123');
  for (const bad of ['hello', '12', '', '   ', '12;34', '１２３４５', '5001\u0000', '1'.repeat(16), 'x'.repeat(100), null, undefined, 5001, {}, []]) assert.equal(k(bad), 'INVALID', JSON.stringify(bad));
});

test('FLAG OFF by default: alias and alias-dialling answer feature_disabled, extension dialling still works; only the exact value "true" enables it; a bad reserved-range configuration refuses to start', async (t) => {
  if (skip(t)) return;
  const off = await variant({}); const e1 = await person('flagann', {}, off), e2 = await person('flagben', {}, off);
  for (const rep of [off, await variant({ VOICE_COUNTRY_ALIAS_ENABLED: 'false', VOICE_ALIAS_NAMESPACES: NS }), await variant({ VOICE_COUNTRY_ALIAS_ENABLED: 'TRUE', VOICE_ALIAS_NAMESPACES: NS }), await variant({ VOICE_COUNTRY_ALIAS_ENABLED: '1', VOICE_ALIAS_NAMESPACES: NS }), await variant({ VOICE_COUNTRY_ALIAS_ENABLED: ' true', VOICE_ALIAS_NAMESPACES: NS })]) {
    for (const [m, p, b] of [['GET', '/v1/voice/alias'], ['POST', '/v1/voice/alias', { country: 'GB', confirm: true }]]) { const x = await rep.api('flagann', m, p, b); assert.equal(x.status, 403); assert.deepEqual(x.body, GATE); }
    const pr = await prepare(rep, 'flagann', '07700900123'); assert.equal(pr.status, 403); assert.deepEqual(pr.body, GATE); assert.equal((await rep.api('flagann', 'GET', '/v1/voice/features')).body.countryAlias, false);
  }
  const ext = await prepare(off, 'flagann', e2); assert.equal(ext.status, 200); assert.deepEqual(ext.body, { status: 'INTERNAL_READY', extension: e2, via: 'extension' });
  assert.equal((await r.api('flagann', 'GET', '/v1/voice/features')).body.countryAlias, true);
  const bad = (ns, extra = {}) => assert.rejects(variant({ VOICE_COUNTRY_ALIAS_ENABLED: 'true', VOICE_ALIAS_NAMESPACES: typeof ns === 'string' ? ns : JSON.stringify(ns), ...extra }), /VOICE_ALIAS_NAMESPACES/);
  await bad({ GB: { prefix: '07a', length: 11 } }); await bad({ GB: { prefix: '0770090', length: 8 } }); await bad({ GB: { prefix: '077009012', length: 11 } }); await bad({ gb: { prefix: '0770090', length: 11 } }); await bad('{not json'); await bad({ GB: { prefix: '0770090', length: 16 } });
});

test('ASSIGNMENT: needs an explicit country confirmation and a configured reserved range; idempotent; a country change is refused; unverified and foreign credentials refused; IP, headers and extra fields cannot set a country', async (t) => {
  if (skip(t)) return;
  const ext = await person('aliasann'); await person('aliasnew', { verified: false });
  assert.equal((await r.api('aliasann', 'POST', '/v1/voice/alias', { country: 'FR', confirm: true })).status, 404, 'a country without a configured reserved range cannot get aliases (no default)');
  assert.equal((await r.api('aliasann', 'POST', '/v1/voice/alias', { country: 'US' })).body.error, 'confirmation_required'); assert.equal((await r.api('aliasann', 'POST', '/v1/voice/alias', { country: 'US', confirm: 'yes' })).status, 400); assert.equal((await r.api('aliasann', 'POST', '/v1/voice/alias', { country: 'us', confirm: true })).status, 400);
  for (const extra of [{ ipCountry: 'GB' }, { geo: 'GB' }, { locale: 'en-GB' }, { accountId: 'someone-else' }]) assert.equal((await r.api('aliasann', 'POST', '/v1/voice/alias', { country: 'US', confirm: true, ...extra })).status, 400, 'unknown field refused: ' + Object.keys(extra));
  assert.equal((await r.api('aliasann', 'GET', '/v1/voice/alias')).body.alias, null);
  const a = await r.api('aliasann', 'POST', '/v1/voice/alias', { country: 'US', confirm: true }, { headers: { 'x-forwarded-for': '81.2.69.142', 'cf-ipcountry': 'GB', 'accept-language': 'en-GB' } });
  assert.equal(a.status, 201, JSON.stringify(a.body)); assert.equal(a.body.alias.country, 'US', 'the country is the confirmed one, whatever the IP, header or locale says'); assert.match(a.body.alias.number, /^202555[0-9]{4}$/); assert.match(a.body.alias.display, /^\(202\) 555-[0-9]{4}$/); assert.equal(a.body.alias.extension, ext); assert.equal(a.body.alias.qorllaOnly, true);
  const again = await getAlias(r, 'aliasann', 'US'); assert.equal(again.status, 200); assert.equal(again.body.reused, true); assert.equal(again.body.alias.number, a.body.alias.number, 'idempotent');
  const other = await getAlias(r, 'aliasann', 'GB'); assert.equal(other.status, 409); assert.equal(other.body.error, 'alias_country_mismatch');
  const g = (await r.api('aliasann', 'GET', '/v1/voice/alias')).body; assert.equal(g.alias.number, a.body.alias.number); assert.equal(g.confirmedCountry, 'US'); assert.deepEqual(g.countries, ['GB', 'GH', 'US']);
  assert.equal((await getAlias(r, 'aliasnew', 'US')).body.error, 'identity_unverified'); assert.equal((await getAlias(r, 'aliasnever', 'US')).status, 401);
  for (const authz of [undefined, 'Bearer garbage', 'Bearer ' + await idp.token('aliasann', { aud: 'qorlla-meet-media' })]) assert.equal((await fetch(r.base + '/v1/voice/alias', { method: 'POST', headers: { 'content-type': 'application/json', ...(authz ? { authorization: authz } : {}) }, body: JSON.stringify({ country: 'US', confirm: true }) })).status, 401);
  assert.equal((await rows('SELECT count(*)::int AS n FROM voice_country_aliases WHERE account_id=$1', ['aliasann']))[0].n, 1);
  assert.ok((await rows("SELECT 1 FROM shield_events WHERE action='alias.assign' AND actor='aliasann'")).length === 1, 'assignment is audited once');
});

test('NO DUPLICATE ALLOCATION: parallel requests for one account give one alias; many accounts at once all get distinct numbers; the database refuses duplicates, edits, deletes and un-retiring', async (t) => {
  if (skip(t)) return;
  await person('racer'); const same = await Promise.all(Array.from({ length: 12 }, () => getAlias(r, 'racer', 'GB'))); assert.ok(same.every((x) => x.status === 200 || x.status === 201), JSON.stringify(same.map((x) => x.status)));
  assert.equal(new Set(same.map((x) => x.body.alias.number)).size, 1, 'one number for 12 simultaneous requests'); assert.equal(same.filter((x) => x.body.reused === false).length, 1, 'exactly one request created it');
  assert.equal((await rows('SELECT count(*)::int AS n FROM voice_country_aliases WHERE account_id=$1', ['racer']))[0].n, 1);
  const ids = Array.from({ length: 25 }, (_, i) => 'mass' + i); for (const id of ids) await person(id); const many = await Promise.all(ids.map((id) => getAlias(r, id, 'GH')));
  assert.ok(many.every((x) => x.status === 201), JSON.stringify(many.map((x) => x.status))); assert.equal(new Set(many.map((x) => x.body.alias.number)).size, 25, 'no two accounts share a number'); assert.ok(many.every((x) => /^020000[0-9]{4}$/.test(x.body.alias.number)), 'all inside the reserved range');
  const one = (await rows("SELECT * FROM voice_country_aliases WHERE account_id='racer'"))[0];
  await assert.rejects(db.pool.query("INSERT INTO voice_country_aliases(account_id, extension, iso_country, canonical_national, display_national) VALUES('mass1', (SELECT extension FROM voice_identities WHERE account_id='mass1'), 'GB', $1, 'x')", [one.canonical_national]), /unique|duplicate/i, 'the same digits cannot be issued twice');
  await assert.rejects(db.pool.query("INSERT INTO voice_country_aliases(account_id, extension, iso_country, canonical_national, display_national) VALUES('racer', (SELECT extension FROM voice_identities WHERE account_id='racer'), 'GB', '07700900999', 'x')"), /unique|duplicate/i, 'and an account cannot hold two active aliases');
  for (const sql of ["UPDATE voice_country_aliases SET canonical_national='07700900001' WHERE account_id='racer'", "UPDATE voice_country_aliases SET account_id='mass2' WHERE account_id='racer'", "UPDATE voice_country_aliases SET iso_country='US' WHERE account_id='racer'", 'DELETE FROM voice_country_aliases WHERE account_id=\'racer\'', 'TRUNCATE voice_country_aliases']) await assert.rejects(db.pool.query(sql), /immutable|never deleted/, sql);
  await assert.rejects(db.pool.query("INSERT INTO voice_country_aliases(account_id, extension, iso_country, canonical_national, display_national) VALUES('racer', 'x', 'GB', '07700900123', 'x')"), /foreign key|violates/i, 'an alias must point at a real extension');
});

test('RESOLUTION: same confirmed country only; tenants isolated; spoofed country, other countries, unconfirmed callers and unknown numbers all look like "not found"; preparing never places a call', async (t) => {
  if (skip(t)) return;
  await ops('PUT', '/v1/shield/admin/orgs', { orgId: 'orgA' }); await ops('PUT', '/v1/shield/admin/orgs', { orgId: 'orgB' });
  const x = {}; for (const [id, org, country] of [['rann', null, 'US'], ['rben', null, 'US'], ['rgha', null, 'GH'], ['runc', null, null], ['reve', 'orgA', 'US'], ['rfay', 'orgA', 'US'], ['rgus', 'orgB', 'US']]) { x[id] = await person(id, org ? { orgId: org } : {}); if (country) x[id + 'alias'] = (await getAlias(r, id, country)).body.alias; }
  const callsBefore = (await rows('SELECT count(*)::int AS n FROM voice_calls'))[0].n; const nf = { status: 'NOT_FOUND', reason: 'QORLLA_USER_NOT_FOUND' };
  const ok = await prepare(r, 'rben', x.rannalias.display); assert.equal(ok.status, 200); assert.deepEqual(ok.body, { status: 'INTERNAL_READY', extension: x.rann, via: 'alias' }, 'formatting is ignored: the digits are what counts');
  assert.equal((await prepare(r, 'rben', x.rannalias.number.replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3'))).body.extension, x.rann);
  const unknown = await prepare(r, 'rben', '2025550000'); assert.equal(unknown.status, 404); assert.deepEqual(unknown.body, nf);
  for (const [as, dial, why] of [['rgha', x.rannalias.number, 'a caller of another country (spoofing the number of a country that is not theirs)'], ['runc', x.rannalias.number, 'a caller who never confirmed a country'], ['rben', x.rghaalias.number, 'a US caller dialling a GH number'], ['rgus', x.revealias.number, 'another tenant'], ['rben', x.revealias.number, 'default namespace into a tenant'], ['reve', x.rannalias.number, 'tenant into the default namespace']]) { const p = await prepare(r, as, dial); assert.equal(p.status, 404, why); assert.deepEqual(p.body, unknown.body, why + ': the same answer as an unknown number'); }
  assert.deepEqual((await prepare(r, 'rfay', x.revealias.number)).body, { status: 'INTERNAL_READY', extension: x.reve, via: 'alias' }, 'same tenant, same country');
  assert.equal((await prepare(r, 'rann', x.rannalias.number)).status, 403); assert.equal((await prepare(r, 'rann', x.rannalias.number)).body.reason, 'OWN_NUMBER');
  // dialling the extension of another tenant is refused the same way
  assert.equal((await prepare(r, 'rgus', x.reve)).status, 404);
  // preparing is not calling: no call, nothing billable, no carrier; the real call goes through the normal, guarded path with the prepared extension
  assert.equal((await rows('SELECT count(*)::int AS n FROM voice_calls'))[0].n, callsBefore, 'prepare never creates a call');
  const call = await r.api('rben', 'POST', '/v1/voice/calls', { extension: ok.body.extension, idempotencyKey: 'k-' + randomUUID(), deviceId: r.device('rben') }); assert.equal(call.status, 201); await r.api('rben', 'POST', `/v1/voice/calls/${call.body.call.id}/end`, {});
});

test('SUSPENSION and ELIGIBILITY: a suspended callee cannot be reached and keeps its number (not reissued); a suspended or unverified caller cannot prepare; restoring brings it back', async (t) => {
  if (skip(t)) return;
  const sa = await person('sann'); await person('sben'); const al = (await getAlias(r, 'sann', 'GB')).body.alias; await getAlias(r, 'sben', 'GB'); await person('sunv', { verified: false });
  assert.equal((await prepare(r, 'sben', al.number)).status, 200);
  assert.equal((await ops('POST', '/v1/shield/admin/principals/sann/suspend', {})).status, 200); assert.deepEqual((await prepare(r, 'sben', al.number)).body, { status: 'NOT_FOUND', reason: 'QORLLA_USER_NOT_FOUND' }, 'a suspended account cannot be reached');
  assert.equal((await rows("SELECT status FROM voice_country_aliases WHERE account_id='sann'"))[0].status, 'active', 'the number is retained during suspension (and never reissued)'); assert.equal((await prepare(r, 'sann', al.number)).status, 403, 'a suspended account cannot prepare');
  assert.equal((await r.api('sann', 'GET', '/v1/voice/alias')).status, 403); assert.equal((await getAlias(r, 'sann', 'GB')).status, 403, 'nor obtain or read an alias');
  assert.equal((await ops('POST', '/v1/shield/admin/principals/sann/restore', {})).status, 200); await new Promise((ok) => setTimeout(ok, 1100)); assert.equal((await prepare(r, 'sben', al.number)).body.extension, sa, 'restored: reachable again at the SAME number');
  const unv = await prepare(r, 'sunv', al.number); assert.equal(unv.status, 403); assert.equal(unv.body.error, 'identity_unverified'); assert.equal((await getAlias(r, 'sunv', 'US')).status, 403);
});

test('RETIREMENT: the explicit change procedure keeps the old number forever; it is never reissued, even when the reserved range is exhausted', async (t) => {
  if (skip(t)) return;
  await person('tann'); await person('tben'); const first = (await getAlias(r, 'tann', 'US')).body.alias; await getAlias(r, 'tben', 'US');
  assert.equal((await fetch(r.base + '/v1/voice/admin/alias/tann/retire', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"reason":"moved country"}' })).status, 401, 'administrators only');
  assert.equal((await r.admin('POST', '/alias/tann/retire', { reason: 'x' })).status, 400); assert.equal((await r.admin('POST', '/alias/nobody/retire', { reason: 'moved country' })).status, 404);
  const ret = await r.admin('POST', '/alias/tann/retire', { reason: 'moved country' }); assert.equal(ret.status, 200); assert.equal(ret.body.alias.status, 'retired');
  assert.deepEqual((await prepare(r, 'tben', first.number)).body, { status: 'NOT_FOUND', reason: 'QORLLA_USER_NOT_FOUND' }, 'a retired number reaches nobody'); assert.equal((await r.api('tann', 'GET', '/v1/voice/alias')).body.alias, null);
  assert.equal((await r.admin('POST', '/alias/tann/retire', { reason: 'again' })).status, 404, 'nothing active to retire twice');
  const next = await getAlias(r, 'tann', 'GB'); assert.equal(next.status, 201, 'after the explicit procedure the account confirms a country again'); assert.notEqual(next.body.alias.number, first.number); assert.equal(next.body.alias.country, 'GB');
  assert.equal((await prepare(r, 'tben', first.number)).status, 404, 'the old digits still reach nobody'); assert.ok((await rows('SELECT 1 FROM voice_country_aliases WHERE canonical_national=$1 AND status=$2', [first.number, 'retired'])).length === 1, 'the retired row is kept');
  assert.ok((await rows("SELECT 1 FROM shield_events WHERE action='alias.retire'")).length >= 1);
  // exhaustion: a range of 10 numbers, one account cycling through retirements: the 11th request is refused instead of reusing a retired number
  const tiny = await variant({ VOICE_COUNTRY_ALIAS_ENABLED: 'true', VOICE_ALIAS_MIN_RANDOM_DIGITS: '1', VOICE_ALIAS_NAMESPACES: JSON.stringify({ NG: { prefix: '08000000', length: 9 } }) }); await person('cycler', {}, tiny); const seen = new Set();
  for (let i = 0; i < 10; i++) { const a = await getAlias(tiny, 'cycler', 'NG'); assert.equal(a.status, 201, 'issue ' + i + ': ' + JSON.stringify(a.body)); assert.ok(!seen.has(a.body.alias.number), 'never a number issued before'); seen.add(a.body.alias.number); assert.equal((await tiny.admin('POST', '/alias/cycler/retire', { reason: 'cycle ' + i })).status, 200); }
  const full = await getAlias(tiny, 'cycler', 'NG'); assert.equal(full.status, 503); assert.equal(full.body.error, 'alias_capacity', 'range exhausted: refused, never recycled'); assert.equal((await rows("SELECT count(*)::int AS n FROM voice_country_aliases WHERE iso_country='NG'"))[0].n, 10);
  assert.equal((await rows("SELECT count(*)::int AS n FROM voice_country_aliases WHERE account_id='cycler' AND status='active'"))[0].n, 0, 'the failed request left nothing behind');
});

test('EXTERNAL IS OUT OF SCOPE and the endpoint is guarded: "+" numbers are refused as PSTN (never quoted or routed), emergency numbers refused, malformed input rejected, rate limited, authentication required, restart-safe', async (t) => {
  if (skip(t)) return;
  await person('uann'); const pstnBefore = (await rows('SELECT count(*)::int AS n FROM voice_calls'))[0].n;
  const plus = await prepare(r, 'uann', '+1 302 444 1516'); assert.equal(plus.status, 403); assert.deepEqual(plus.body, { error: 'feature_disabled', feature: 'pstn', message: 'Public telephone calling is disabled.', status: 'UNAVAILABLE', reason: 'PSTN_DISABLED' });
  const pstnOn = await variant({ VOICE_PSTN_ENABLED: 'true', VOICE_COUNTRY_ALIAS_ENABLED: 'true', VOICE_ALIAS_NAMESPACES: NS }); const o = await prepare(pstnOn, 'uann', '+13024441516'); assert.equal(o.status, 503); assert.deepEqual(o.body, { status: 'UNAVAILABLE', reason: 'EXTERNAL_ROUTING_NOT_AVAILABLE' }, 'even with the flag on this engine has no external route: no quote, no confirmation, no call');
  assert.equal((await prepare(r, 'uann', '0044 745 667 0202')).status, 400); assert.equal((await prepare(r, 'uann', '+000')).status, 400); assert.equal((await prepare(r, 'uann', 'hello')).status, 400); assert.equal((await r.api('uann', 'POST', '/v1/voice/dial/prepare', { dial: '5001', extra: 1 })).status, 400, 'unknown fields are refused');
  for (const e of ['911', '112', '999']) { const x = await prepare(r, 'uann', e); assert.equal(x.status, 403); assert.deepEqual(x.body, { status: 'DENIED', reason: 'EMERGENCY_NUMBERS_NOT_SUPPORTED' }); }
  assert.equal((await fetch(r.base + '/v1/voice/dial/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"dial":"5001"}' })).status, 401);
  assert.equal((await rows('SELECT count(*)::int AS n FROM voice_calls'))[0].n, pstnBefore, 'nothing was ever placed'); const limited = await variant({ VOICE_PREPARE_RATE_PER_MIN: '5' }); await person('lann', {}, limited); const codes = []; for (let i = 0; i < 8; i++) codes.push((await prepare(limited, 'lann', '99999999')).status); assert.equal(codes.filter((c) => c === 429).length, 3, 'lookups are rate limited (enumeration): ' + codes);
  // restart safety: a brand-new engine process on the same database resolves the same numbers and has no memory of its own
  const fresh = await variant({ VOICE_COUNTRY_ALIAS_ENABLED: 'true', VOICE_ALIAS_NAMESPACES: NS }); const known = (await rows("SELECT canonical_national FROM voice_country_aliases WHERE account_id='rben'"))[0].canonical_national; assert.equal((await prepare(fresh, 'rann', known)).status, 200);
});
