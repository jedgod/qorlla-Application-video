// Telephone numbers (v1.12) on real PostgreSQL and over HTTP. The module is a scaffold with NO carrier: these tests use a mock provider and prove the state machine and the guards, not telephony.
//   off by default and fail-closed; evidence from administrators only (an IP guess never qualifies); idempotency (same key, different request is refused); races (one number, one owner); the provider's signed events
//   (timestamp window, signature, duplicates, out-of-order); submission is not activation; a number is shown to its owner only once active; failures never strand a person on "pending"; the audit is append-only.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { numbersConfig, createNumbers, mockProvider, disabledProvider } from '../src/numbers.mjs';
import { isolatedDb, identityProvider, wait } from './helpers.mjs';
import { harness, ADMIN } from './harness.mjs';

const SECRET = 'n'.repeat(40), NUM = { us1: '+12023021142', us2: '+16502530000', gb1: '+447459558868', gb2: '+442071838750' };
let db, idp, h, on, off, mock, ext;
before(async () => {
  db = await isolatedDb(); if (!db) return; idp = await identityProvider(); h = harness({ db, idp }); mock = mockProvider({ fail: (i) => i.accountId === 'dave' });
  const env = { VOICE_NUMBERS_ENABLED: 'true', VOICE_NUMBERS_COUNTRIES: 'US,GB', VOICE_NUMBERS_WEBHOOK_SECRET: SECRET, VOICE_NUMBERS_PROVIDER: 'mock', VOICE_NUMBERS_WORKER: 'false', VOICE_NUMBERS_MAX_ATTEMPTS: '3', VOICE_CALL_RATE_PER_MIN: '1000', VOICE_API_RATE_PER_MIN: '100000', VOICE_ADMIN_RATE_PER_MIN: '100000' };
  on = await h.replica({ maintenance: false, env, numbersProvider: mock }); off = await h.replica({ maintenance: false }); ext = await h.people(on, ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina']);
});
after(async () => { if (h) await h.closeAll(); if (idp) await idp.close(); if (db) await db.drop(); });
const skip = (t) => !db && t.skip('no PostgreSQL reachable');
const n = async (sql, p = []) => Number((await db.pool.query(sql, p)).rows[0].n);
const adm = (method, path, body, base = on.base) => fetch(base + '/v1/voice/admin' + path, { method, headers: { 'content-type': 'application/json', 'x-voice-admin-secret': ADMIN }, body: body ? JSON.stringify(body) : undefined }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => ({})) }));
const assign = (who, country, key = randomUUID()) => on.api(who, 'POST', '/v1/voice/numbers/assign', { country }, { headers: key === null ? {} : { 'idempotency-key': key } });
const evidence = (who, country = 'US', kind = 'verified_residency', extra = {}) => adm('POST', '/numbers/evidence', { accountId: who, country, kind, verifiedBy: 'kyc-service', ...extra });
const inventory = (country, e164, id = 'pn-' + randomUUID().slice(0, 8)) => adm('POST', '/numbers/inventory', { provider: 'carrier-x', providerNumberId: id, e164, country });
const event = async (type, assignmentId, providerNumberId, { id = 'evt-' + randomUUID(), ts = Math.floor(Date.now() / 1000), secret = SECRET, tamper = false, base = on.base } = {}) => {
  const raw = JSON.stringify({ id, type, assignmentId, providerNumberId }), sig = on.voice.numbers.sign(secret, ts, Buffer.from(raw));
  const r = await fetch(base + '/v1/voice/numbers/provider-events', { method: 'POST', headers: { 'content-type': 'application/json', 'x-qorlla-timestamp': String(ts), 'x-qorlla-signature': sig }, body: tamper ? raw.replace(type, 'number.released') : raw }); return { status: r.status, body: await r.json().catch(() => ({})), id };
};
const row = async (id) => (await db.pool.query('SELECT a.status, n.status AS inv, n.provider_number_id FROM voice_num_assignments a JOIN voice_num_inventory n ON n.id=a.inventory_id WHERE a.id=$1', [id])).rows[0];
const worker = () => on.voice.numbers.runWorkerOnce();

test('configuration is strict: off by default, no country until named, no carrier, and a mock provider is refused in production', () => {
  const d = numbersConfig({}); assert.deepEqual([d.enabled, d.mode, d.countries.size, d.webhookReady, d.worker], [false, 'disabled', 0, false, false]);
  const c = numbersConfig({ VOICE_NUMBERS_ENABLED: 'TRUE', VOICE_NUMBERS_COUNTRIES: 'us, gb ,XX1,,de', VOICE_NUMBERS_WEBHOOK_SECRET: SECRET }); assert.equal(c.enabled, true); assert.deepEqual([...c.countries].sort(), ['DE', 'GB', 'US']); assert.equal(c.webhookReady, true);
  assert.equal(numbersConfig({ VOICE_NUMBERS_ENABLED: 'true', VOICE_NUMBERS_WEBHOOK_SECRET: 'short' }).webhookReady, false);
  assert.throws(() => numbersConfig({ VOICE_NUMBERS_PROVIDER: 'mock', NODE_ENV: 'production' }), /refused in production/); assert.equal(numbersConfig({ VOICE_NUMBERS_PROVIDER: 'mock' }).mode, 'mock');
  assert.throws(() => numbersConfig({ VOICE_NUMBERS_PROVIDER: 'twilio' }), /until a carrier adapter is installed/);
});

test('off by default: every number route, admin route and the webhook answer 503, and nothing is written', async (t) => {
  if (skip(t)) return;
  for (const [m, p] of [['GET', '/v1/voice/numbers/me'], ['POST', '/v1/voice/numbers/assign'], ['POST', '/v1/voice/numbers/release']]) { const x = await off.api('alice', m, p, m === 'POST' ? { country: 'US' } : undefined); assert.equal(x.status, 503, p); assert.equal(x.body.error, 'numbers_disabled'); }
  assert.equal((await adm('POST', '/numbers/inventory', { provider: 'p', providerNumberId: 'x', e164: NUM.us1, country: 'US' }, off.base)).status, 503); assert.equal((await adm('POST', '/numbers/evidence', { accountId: 'alice', country: 'US', kind: 'verified_residency', verifiedBy: 'k' }, off.base)).status, 503);
  const hook = await event('number.activated', randomUUID(), 'x', { base: off.base }); assert.equal(hook.status, 503);
  const m = await fetch(off.base + '/v1/voice/admin/metrics', { headers: { 'x-voice-admin-secret': ADMIN } }).then((x) => x.json()); assert.equal(m.numbers, null);
  assert.equal(await n('SELECT count(*) n FROM voice_num_inventory'), 0); assert.equal((await on.api(null, 'GET', '/v1/voice/numbers/me')).status, 401);
  assert.deepEqual(await disabledProvider.provision().catch((e) => e.message), 'PROVIDER_NOT_CONFIGURED'); assert.equal(await disabledProvider.release().catch((e) => e.message), 'PROVIDER_NOT_CONFIGURED');
});

test('inventory: only real E.164 numbers of the stated country; evidence: only verified, unexpired, administrator-supplied (an IP guess never qualifies)', async (t) => {
  if (skip(t)) return;
  for (const [e164, country] of [['12023021142', 'US'], ['+1202', 'US'], [NUM.us1, 'GB'], ['+0000000000', 'US'], [12023021142, 'US'], ['+119', 'US']]) { const x = await inventory(country, e164); assert.ok([400].includes(x.status), JSON.stringify([e164, country, x.status])); }
  assert.equal((await adm('POST', '/numbers/inventory', { provider: '', providerNumberId: 'x', e164: NUM.us1, country: 'US' })).status, 400); assert.equal((await adm('POST', '/numbers/inventory', {})).status, 400);
  const ok = await inventory('US', NUM.us1); assert.equal(ok.status, 201); assert.equal((await inventory('US', NUM.us1)).status, 409, 'a number is imported once'); assert.equal((await inventory('GB', NUM.gb1)).status, 201);
  assert.equal((await evidence('nobody', 'US')).status, 404); assert.equal((await evidence('alice', 'usa')).status, 400); assert.equal((await evidence('alice', 'US', 'self_declared')).status, 400); assert.equal((await evidence('alice', 'US', 'verified_residency', { verifiedBy: '' })).status, 400); assert.equal((await evidence('alice', 'US', 'verified_residency', { expiresAt: 'tomorrow-ish' })).status, 400);
  assert.equal((await fetch(on.base + '/v1/voice/admin/numbers/evidence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, 'a user cannot supply evidence');
  const mine = await on.api('alice', 'POST', '/v1/voice/numbers/evidence', { country: 'US' }); assert.equal(mine.status, 404, 'there is no user route for evidence');
  await evidence('alice', 'US', 'ip_suggestion', { verifiedBy: undefined }); const a = await assign('alice', 'US'); assert.equal(a.status, 403); assert.equal(a.body.error, 'country_verification_required', 'an IP suggestion never qualifies');
  await evidence('alice', 'US', 'verified_residency', { expiresAt: new Date(Date.now() - 1000).toISOString() }); assert.equal((await assign('alice', 'US')).body.error, 'country_verification_required', 'expired evidence never qualifies');
});

test('assignment: the guards, idempotency (the same key with a different request is refused) and the response never leaks the number while it is only pending', async (t) => {
  if (skip(t)) return;
  await evidence('bob', 'US'); const key = randomUUID();
  assert.equal((await assign('bob', 'US', null)).body.error, 'idempotency_key_required'); assert.equal((await assign('bob', 'US', 'not-a-uuid')).status, 400); assert.equal((await assign('bob', 'us')).status, 400); assert.equal((await assign('bob', 'FR')).body.error, 'country_not_enabled');
  assert.equal((await assign('bob', 'GB')).body.error, 'country_verification_required', 'evidence is per country');
  const first = await assign('bob', 'US', key); assert.equal(first.status, 202); assert.equal(first.body.status, 'pending');
  const again = await assign('bob', 'US', key); assert.equal(again.status, 200); assert.equal(again.body.id, first.body.id, 'a retry of the same request returns the same assignment');
  assert.equal((await assign('bob', 'GB', key)).body.error, 'idempotency_key_reused'); assert.equal((await assign('bob', 'US')).body.error, 'already_assigned');
  const me = await on.api('bob', 'GET', '/v1/voice/numbers/me'); assert.equal(me.body.extension, ext.bob); assert.deepEqual(me.body.number, { status: 'pending', country: 'US', e164: null }); assert.ok(!JSON.stringify(me.body).includes('202302'), 'the number is not shown before the provider confirms it');
  assert.equal(me.headers.get('cache-control'), 'private, no-store'); assert.equal((await on.api('carol', 'GET', '/v1/voice/numbers/me')).body.number, null, 'someone else sees nothing of it');
  assert.equal(await n("SELECT count(*) n FROM voice_num_inventory WHERE status='reserved'"), 1); assert.equal(await n("SELECT count(*) n FROM voice_num_outbox WHERE action='provision' AND status='queued'"), 1);
  assert.equal((await on.admin('POST', '/identities/frank/enabled', { enabled: false })).status, 200); await evidence('frank', 'US'); assert.equal((await assign('frank', 'US')).body.error, 'voice_disabled'); await on.admin('POST', '/identities/frank/enabled', { enabled: true });
});

test('submission is not activation: the worker submits to the provider, but only a signed provider event makes the number active (and visible)', async (t) => {
  if (skip(t)) return;
  const bob = (await db.pool.query("SELECT a.id, n.provider_number_id FROM voice_num_assignments a JOIN voice_num_inventory n ON n.id=a.inventory_id WHERE a.account_id='bob'")).rows[0];
  assert.equal(await worker(), 1); assert.deepEqual(mock.calls.at(-1)[0], 'provision'); assert.equal(mock.calls.at(-1)[1].accountId, 'bob'); assert.equal((await row(bob.id)).status, 'pending', 'submitted, not active');
  assert.equal(await n("SELECT count(*) n FROM voice_num_audit WHERE action='number.provision.submitted'"), 1); assert.equal(await worker(), 0, 'the job is done: nothing to repeat');
  // the guards on the provider's event
  const ok = { assignmentId: bob.id, pn: bob.provider_number_id };
  assert.equal((await event('number.activated', ok.assignmentId, ok.pn, { secret: 'x'.repeat(40) })).status, 401, 'wrong secret'); assert.equal((await event('number.activated', ok.assignmentId, ok.pn, { tamper: true })).status, 401, 'tampered body');
  assert.equal((await event('number.activated', ok.assignmentId, ok.pn, { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401, 'an hour-old timestamp: replay'); assert.equal((await event('number.activated', ok.assignmentId, ok.pn, { ts: Math.floor(Date.now() / 1000) + 3600 })).status, 401, 'a timestamp from the future');
  assert.equal((await fetch(on.base + '/v1/voice/numbers/provider-events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, 'no signature'); assert.equal((await event('number.activated', randomUUID(), ok.pn)).status, 422, 'an event for something that is not ours');
  assert.equal((await event('number.activated', ok.assignmentId, 'someone-elses-number')).status, 422, 'wrong number for that assignment'); assert.equal((await row(ok.assignmentId)).status, 'pending', 'none of the refused events changed anything');
  assert.equal((await event('number.released', ok.assignmentId, ok.pn)).status, 409, 'an out-of-order event never moves a number backwards');
  const big = await fetch(on.base + '/v1/voice/numbers/provider-events', { method: 'POST', headers: { 'content-type': 'application/json', 'x-qorlla-timestamp': String(Math.floor(Date.now() / 1000)), 'x-qorlla-signature': 'a'.repeat(64) }, body: JSON.stringify({ pad: 'x'.repeat(20000) }) }); assert.equal(big.status, 413);
  const act = await event('number.activated', ok.assignmentId, ok.pn); assert.equal(act.status, 200); assert.equal(act.body.status, 'active'); assert.deepEqual(await row(ok.assignmentId), { status: 'active', inv: 'assigned', provider_number_id: ok.pn });
  const dup = await event('number.activated', ok.assignmentId, ok.pn, { id: act.id }); assert.equal(dup.body.duplicate, true, 'a redelivered event is recognised'); assert.equal((await event('number.activated', ok.assignmentId, ok.pn)).body.duplicate, true, 'and a new id for the same fact changes nothing');
  assert.deepEqual((await on.api('bob', 'GET', '/v1/voice/numbers/me')).body.number, { status: 'active', country: 'US', e164: NUM.us1 }, 'only now does the owner see the number');
  assert.equal((await on.api('carol', 'GET', '/v1/voice/numbers/me')).body.number, null); const susp = await event('number.suspended', ok.assignmentId, ok.pn); assert.equal(susp.body.status, 'suspended'); assert.equal((await on.api('bob', 'GET', '/v1/voice/numbers/me')).body.number.status, 'suspended');
  assert.equal(await n("SELECT count(*) n FROM voice_num_audit WHERE actor='provider'"), 2);
});

test('release: requested by the owner, submitted by the worker, completed only by a signed event; the number goes to quarantine, never straight back to available', async (t) => {
  if (skip(t)) return;
  assert.equal((await on.api('carol', 'POST', '/v1/voice/numbers/release', {})).status, 404, 'nothing to release'); const rel = await on.api('bob', 'POST', '/v1/voice/numbers/release', {}); assert.equal(rel.status, 202); assert.equal(rel.body.status, 'release_pending');
  assert.equal((await on.api('bob', 'POST', '/v1/voice/numbers/release', {})).status, 202, 'asking twice is harmless'); assert.equal(await n("SELECT count(*) n FROM voice_num_outbox WHERE action='release'"), 1);
  const a = (await db.pool.query("SELECT a.id, n.provider_number_id FROM voice_num_assignments a JOIN voice_num_inventory n ON n.id=a.inventory_id WHERE a.account_id='bob'")).rows[0];
  assert.equal(await worker(), 1); assert.equal(mock.calls.at(-1)[0], 'release'); assert.equal((await row(a.id)).status, 'release_pending'); const done = await event('number.released', a.id, a.provider_number_id); assert.equal(done.body.status, 'released');
  assert.deepEqual(await row(a.id), { status: 'released', inv: 'quarantined', provider_number_id: a.provider_number_id }); assert.equal((await on.api('bob', 'GET', '/v1/voice/numbers/me')).body.number, null);
  await evidence('carol', 'US'); assert.equal((await assign('carol', 'US')).body.error, 'no_number_inventory', 'a released number is not handed out again until an administrator clears it');
});

test('races: one number goes to exactly one of several claimants; one account never ends up with two; the database itself forbids two owners', async (t) => {
  if (skip(t)) return;
  await db.pool.query("UPDATE voice_num_inventory SET status='retired' WHERE status IN ('available','quarantined')"); const imp = await inventory('US', NUM.us2); assert.equal(imp.status, 201);
  const claimants = ['carol', 'erin', 'gina']; for (const c of claimants) await evidence(c, 'US'); await evidence('alice', 'US', 'verified_residency');
  const res = await Promise.all(claimants.map((c) => assign(c, 'US'))); assert.deepEqual(res.map((x) => x.status).sort(), [202, 409, 409]); assert.equal(res.filter((x) => x.body.error === 'no_number_inventory').length, 2);
  assert.equal(await n("SELECT count(*) n FROM voice_num_assignments WHERE inventory_id=$1 AND status IN ('pending','active','suspended','release_pending')", [imp.body.id]), 1);
  await db.pool.query("UPDATE voice_num_inventory SET status='available' WHERE id=$1", [imp.body.id]); const winner = (await db.pool.query("SELECT account_id FROM voice_num_assignments WHERE inventory_id=$1 AND status='pending'", [imp.body.id])).rows[0].account_id;
  await assert.rejects(db.pool.query("INSERT INTO voice_num_assignments(account_id, inventory_id, status, request_key, request_hash) VALUES($1,$2,'pending',$3,'x')", [claimants.find((c) => c !== winner), imp.body.id, randomUUID()]), (e) => e.code === '23505', 'two live owners of one number is impossible');
  // one account, many simultaneous requests: exactly one
  await inventory('GB', NUM.gb2); await evidence('alice', 'GB'); const many = await Promise.all(Array.from({ length: 6 }, () => assign('alice', 'GB'))); assert.equal(many.filter((x) => x.status === 202).length, 1); assert.equal(many.filter((x) => x.body.error === 'already_assigned').length, 5);
  assert.equal(await n("SELECT count(*) n FROM voice_num_assignments WHERE account_id='alice' AND status IN ('pending','active','suspended','release_pending')"), 1);
});

test('failures never strand a person on "pending": retries with backoff, then the request fails and the number is quarantined; a provider failure event does the same', async (t) => {
  if (skip(t)) return;
  await inventory('US', '+14155552671').then((x) => assert.equal(x.status, 201)); await evidence('dave', 'US'); const a = await assign('dave', 'US'); assert.equal(a.status, 202);
  for (let i = 0; i < 3; i++) { assert.equal(await worker(), 1, 'attempt ' + (i + 1)); await db.pool.query("UPDATE voice_num_outbox SET next_attempt_at = now(), lease_until = NULL WHERE status='queued'"); }
  assert.equal((await worker()), 0); const st = await row(a.body.id); assert.deepEqual([st.status, st.inv], ['failed', 'quarantined']); assert.equal((await db.pool.query("SELECT status, last_error FROM voice_num_outbox WHERE assignment_id=$1", [a.body.id])).rows[0].status, 'dead');
  assert.equal(await n("SELECT count(*) n FROM voice_num_audit WHERE action='number.provision.gave_up'"), 1); assert.equal((await on.api('dave', 'GET', '/v1/voice/numbers/me')).body.number, null, 'the person is not left waiting');
  const s = await adm('GET', '/numbers/summary'); assert.equal(s.body.dead, 1); assert.ok(s.body.quarantined >= 1); assert.deepEqual(s.body.countries.sort(), ['GB', 'US']);
  await db.pool.query("UPDATE voice_num_inventory SET status='available' WHERE status='quarantined' AND country_code='US'"); const again = await assign('dave', 'US'); assert.equal(again.status, 202, 'after the administrator clears the number, a new request works');
  const x = (await db.pool.query("SELECT a.id, n.provider_number_id FROM voice_num_assignments a JOIN voice_num_inventory n ON n.id=a.inventory_id WHERE a.id=$1", [again.body.id])).rows[0]; const f = await event('number.provision_failed', x.id, x.provider_number_id); assert.equal(f.body.status, 'failed'); assert.equal((await row(x.id)).inv, 'quarantined');
  const prom = await fetch(on.base + '/v1/voice/admin/metrics?format=prometheus', { headers: { authorization: 'Bearer ' + ADMIN } }).then((r) => r.text()); for (const m of ['qorlla_voice_numbers_queued', 'qorlla_voice_numbers_dead', 'qorlla_voice_numbers_stuck_pending', 'qorlla_voice_numbers_quarantined']) assert.match(prom, new RegExp('^' + m + ' \\d+$', 'm'), m);
});

test('the audit is append-only, numbers never leak into history or the directory, and the engine still routes by extension only', async (t) => {
  if (skip(t)) return;
  assert.ok(await n('SELECT count(*) n FROM voice_num_audit') >= 8); for (const sql of ["UPDATE voice_num_audit SET actor='x'", 'DELETE FROM voice_num_audit', 'TRUNCATE voice_num_audit']) await assert.rejects(db.pool.query(sql), /append-only/, sql);
  const everything = JSON.stringify([(await on.api('alice', 'GET', '/v1/voice/history')).body, (await on.api('alice', 'GET', '/v1/voice/me')).body, (await on.api('alice', 'GET', '/v1/voice/calls')).body, (await adm('GET', '/identities')).body]);
  for (const digits of ['2023021142', '6502530000', '4155552671', '7459558868', '2071838750']) assert.ok(!everything.includes(digits), 'a number appears nowhere but the owner\'s own /numbers/me: ' + digits);
  assert.equal((await on.dial('alice', '+12023021142')).status, 400, 'a phone number is not an extension: the engine never routes one'); assert.equal((await on.dial('alice', '12023021142')).status, 400);
});
