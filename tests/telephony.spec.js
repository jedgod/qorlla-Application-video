const { test, expect } = require('@playwright/test');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const express = require('express');
const { Pool } = require('pg');

// Qorlla Telephony v2. These tests drive the REAL telephony module (adapter, workflows, ledger, IVR, signed webhooks, fail-closed capability rules) against
//   - a throwaway PostgreSQL schema in the dev database, and
//   - a LOCAL STAND-IN for the Twilio REST API (a test double: it is not Twilio).
// They prove the code behaves as designed. They do NOT prove anything about real Twilio, real numbers, real calls or real audio: those are certification steps T01-T07
// and remain open. Needs `npm run dev:stack` once (database + secrets).
const M = (f) => import(pathToFileURL(path.resolve(__dirname, '..', 'qorlla-meet-video', 'server', 'telephony', f)).href);
const secrets = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '.dev-stack', 'secrets.json'), 'utf8'));
const URL_DB = 'postgres://qorlla:' + secrets.dbPassword + '@127.0.0.1:' + (process.env.MEET_DB_PORT || 35432) + '/qorlla_meet';
const SID = 'ACtest0123456789abcdef', TOKEN = 'tok-' + 'x'.repeat(24);

async function mockTwilio() {
  const log = [], state = { accountStatus: 'active', callPrice: '-0.0130', callDuration: '62', callStatus: 'completed', available: [{ phone_number: '+12025550111', locality: 'Washington', region: 'DC', capabilities: { voice: true } }], nextCall: 1, nextNum: 1 };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
      const form = Object.fromEntries(new URLSearchParams(b)); log.push({ method: req.method, url: req.url, auth: req.headers.authorization, form });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(obj === null ? '' : JSON.stringify(obj)); };
      const want = 'Basic ' + Buffer.from(SID + ':' + TOKEN).toString('base64'); if (req.headers.authorization !== want) return send(401, { code: 20003, message: 'Authenticate' });
      const u = req.url.split('?')[0], base = '/2010-04-01/Accounts/' + SID;
      if (req.method === 'GET' && u === base + '.json') return send(200, { sid: SID, status: state.accountStatus, type: 'Full', friendly_name: 'SECRET NAME' });
      if (req.method === 'GET' && u.startsWith(base + '/AvailablePhoneNumbers/')) return send(200, { available_phone_numbers: state.available });
      if (req.method === 'POST' && u === base + '/IncomingPhoneNumbers.json') return send(201, { sid: 'PN' + String(state.nextNum++).padStart(6, '0'), phone_number: form.PhoneNumber });
      if (req.method === 'DELETE' && u.startsWith(base + '/IncomingPhoneNumbers/')) return send(204, null);
      if (req.method === 'POST' && u === base + '/Calls.json') return send(201, { sid: 'CA' + String(state.nextCall++).padStart(6, '0'), status: 'queued' });
      if (req.method === 'POST' && u.startsWith(base + '/Calls/')) return send(200, { status: 'completed' });
      if (req.method === 'GET' && u.startsWith(base + '/Calls/')) return send(200, { sid: u.split('/').pop().replace('.json', ''), status: state.callStatus, duration: state.callDuration, price: state.callPrice, price_unit: 'USD', direction: 'outbound-api' });
      send(404, { code: 20404 });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + srv.address().port, log, state, close: () => new Promise((r) => srv.close(r)) };
}

test.describe('rules (no server, no database)', () => {
  test('meeting IDs stay 11 digits; E.164 is strict; destinations are screened (premium, satellite, emergency, country policy)', async () => {
    const C = await M('core.mjs');
    expect(C.normalizeMeetingId('123 4567 8901')).toBe('12345678901'); expect(() => C.normalizeMeetingId('1234567890')).toThrow(/11 digits/); expect(() => C.normalizeMeetingId('123456789012')).toThrow();
    expect(C.normalizeE164('+1 (202) 555-0100')).toBe('+12025550100'); expect(() => C.normalizeE164('2025550100')).toThrow(); expect(() => C.normalizeE164('+0123456789')).toThrow();
    const env = { PHONE_ALLOWED_COUNTRIES: 'US,GB' };
    expect(C.screenDestination('+12025550100', env)).toMatchObject({ ok: true, country: 'US' }); expect(C.screenDestination('+442071234567', env)).toMatchObject({ ok: true, country: 'GB' });
    expect(C.screenDestination('+19005551234', env).code).toBe('DESTINATION_BLOCKED'); expect(C.screenDestination('+881234567890', env).code).toBe('DESTINATION_BLOCKED'); expect(C.screenDestination('+44909123456', env).code).toBe('DESTINATION_BLOCKED');
    expect(C.screenDestination('+911', env).code).toBe('EMERGENCY_NUMBER'); expect(C.screenDestination('+233201234567', env).code).toBe('COUNTRY_NOT_ALLOWED'); expect(C.screenDestination('+99912345678', env).code).toBe('COUNTRY_UNKNOWN');
    expect(() => C.assertAdmin({ id: 'u1', admin: false })).toThrow(/administrators/); expect(() => C.assertAdmin(null)).toThrow(); expect(() => C.assertAdmin({ id: 'u1', admin: true })).not.toThrow();
  });
  test('a call only moves forward: late, duplicate and out-of-order events cannot regress it', async () => {
    const C = await M('core.mjs'); let s = 'queued';
    for (const e of ['ringing', 'placing', 'connected', 'ringing', 'completed', 'connected', 'failed']) s = C.nextState(s, C.fromTwilioStatus({ placing: 'queued', ringing: 'ringing', connected: 'in-progress', completed: 'completed', failed: 'failed' }[e]));
    expect(s).toBe('completed'); expect(C.fromTwilioStatus('busy')).toBe('failed'); expect(C.fromTwilioStatus('canceled')).toBe('cancelled'); expect(C.fromTwilioStatus('nonsense')).toBeNull();
  });
  test('Twilio signature: matches Twilio\'s published example, rejects tampering, and verifies in constant time', async () => {
    const T = await M('twilio.mjs');
    const params = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675310', Digits: '1234', From: '+14158675310', To: '+18005551212' }, url = 'https://example.com/myapp.php?foo=1&bar=2';
    const sig = T.twilioSignature({ token: '12345', url, params }); expect(sig).toBe('L/OH5YylLD5NRKLltdqwSvS0BnU=');   // the worked example in Twilio's security documentation (twilio.com/docs/usage/security)
    expect(T.verifySignature({ token: '12345', url, params, signature: sig })).toBe(true); expect(T.verifySignature({ token: '12345', url, params: { ...params, Digits: '1235' }, signature: sig })).toBe(false);
    expect(T.verifySignature({ token: '12345', url: url + '&x=1', params, signature: sig })).toBe(false); expect(T.verifySignature({ token: 'other', url, params, signature: sig })).toBe(false); expect(T.verifySignature({ token: '12345', url, params, signature: '' })).toBe(false);
  });
  test('capabilities are derived from evidence: nothing is "active" on configuration alone, and phone-join needs provider + dial-in + certified bridge', async () => {
    const { deriveCapabilities: d } = await M('core.mjs'); const base = { providerConfigured: true, healthOk: true, webhookVerified: true, gates: {}, dialInCount: 0, personalNumbers: 0, bridgeReady: false, reconciledUsage: 0, healthCheckedAt: 'T', webhookVerifiedAt: 'T' };
    expect(d({ ...base, providerConfigured: false, healthOk: false, webhookVerified: false }).provider.status).toBe('not_connected'); expect(d({ ...base, webhookVerified: false }).provider.status).toBe('pending'); expect(d({ ...base, healthOk: false }).provider.status).toBe('not_connected');
    expect(d(base).provider.status).toBe('active'); expect(d({ ...base, dialInCount: 2 }).dialin.status).toBe('pending'); expect(d({ ...base, dialInCount: 2, gates: { dialin: 'T' } }).dialin.status).toBe('active');
    expect(d(base).carrier.status).toBe('off'); expect(d({ ...base, gates: { carrier: 'T' } }).carrier.status).toBe('active'); expect(d(base).bridge.status).toBe('not_built'); expect(d({ ...base, bridgeReady: true }).bridge.status).toBe('pending');
    expect(d(base).billing.status).toBe('not_connected'); expect(d({ ...base, gates: { billing: 'T' } }).billing.status).toBe('pending'); expect(d({ ...base, gates: { billing: 'T' }, reconciledUsage: 1 }).billing.status).toBe('active');
    expect(d({ ...base, dialInCount: 1, bridgeReady: true, gates: { dialin: 'T', bridge: 'T' } }).phoneMeetingJoinEnabled).toBe(true); expect(d({ ...base, dialInCount: 1, bridgeReady: true, gates: { dialin: 'T' } }).phoneMeetingJoinEnabled).toBe(false);
    expect(d({ ...base, gates: { carrier: 'T', billing: 'T' }, reconciledUsage: 1 }).callingEnabled).toBe(true); expect(d({ ...base, gates: { carrier: 'T' } }).callingEnabled).toBe(false);
    expect(d({ ...base, personalNumbers: 1 }).number.status).toBe('active'); expect(d(base).number.status).toBe('unassigned');
  });
});

test.describe('Twilio adapter, workflows, ledger and webhooks (local Twilio stand-in + throwaway schema)', () => {
  test.describe.configure({ mode: 'serial' });
  let mock, pool, schema, P, S, C, R, ivr; const ADMIN = { id: 'u_admin', admin: true }, USER = { id: 'u_user', admin: false }, OTHER = { id: 'u_other', admin: false };
  const env = (x = {}) => ({ PHONE_ALLOWED_COUNTRIES: 'US,CA,GB', PHONE_RECONCILE_DELAY_S: '0', PHONE_PUBLIC_BASE: 'https://qorlla.example', PHONE_FEATURES: 'dialin,carrier,bridge,billing,settings', ...x });
  const mk = async (e = env(), over = {}) => { const carrier = over.carrier || new (await M('twilio.mjs')).TwilioProvider({ sid: SID, token: TOKEN, base: mock.url, webhookBase: e.PHONE_PUBLIC_BASE, fetchImpl: fetch }); return new S.TelephonyService({ db: pool, carrier, bridge: over.bridge || new P.UnconfiguredBridge(), audio: over.audio || new P.UnconfiguredAudioGateway(), env: e }); };
  const certify = (g) => pool.query("INSERT INTO qphone_gates(gate,evidence_ref,evidence_sha256,certified_by) VALUES($1,'test-evidence',repeat('a',64),'test') ON CONFLICT (gate) DO NOTHING", [g]);
  const q = async (sql, p) => (await pool.query(sql, p)).rows;

  test.beforeAll(async () => {
    mock = await mockTwilio(); schema = 'qt_' + Math.random().toString(36).slice(2, 10);
    const admin = new Pool({ connectionString: URL_DB }); await admin.query('CREATE SCHEMA ' + schema); await admin.end();
    pool = new Pool({ connectionString: URL_DB, options: '-c search_path=' + schema }); for (const f of ['v4_14_telephony.sql', 'v4_15_telephony_features.sql']) await pool.query(fs.readFileSync(path.resolve(__dirname, '..', 'qorlla-meet-video', 'sql', f), 'utf8'));
    P = await M('provider.mjs'); S = await M('service.mjs'); C = await M('core.mjs'); ivr = await M('ivr.mjs'); R = await M('routes.mjs');
  });
  test.afterAll(async () => { if (pool) { await pool.end(); } const a = new Pool({ connectionString: URL_DB }); await a.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(() => {}); await a.end(); if (mock) await mock.close(); });

  test('the adapter speaks the Twilio API: health, inventory, provisioning, release, call, lookup; the token never appears in results or errors', async () => {
    const { TwilioProvider } = await M('twilio.mjs'), t = new TwilioProvider({ sid: SID, token: TOKEN, base: mock.url, webhookBase: 'https://qorlla.example', fetchImpl: fetch });
    expect(await t.healthCheck()).toMatchObject({ ok: true }); expect(JSON.stringify(await t.healthCheck())).not.toMatch(/SECRET NAME|tok-/);
    expect(await t.listAvailableNumbers('US')).toEqual([{ e164: '+12025550111', locality: 'Washington', region: 'DC', voice: true }]);
    const n = await t.provisionNumber({ e164: '+12025550111', friendlyName: 'Qorlla personal' }); expect(n).toEqual({ providerNumberId: 'PN000001', e164: '+12025550111' });
    const post = mock.log.find((l) => l.method === 'POST' && l.url.includes('IncomingPhoneNumbers')); expect(post.form.VoiceUrl).toBe('https://qorlla.example/api/telephony/webhooks/twilio/voice'); expect(post.form.StatusCallback).toBe('https://qorlla.example/api/telephony/webhooks/twilio/status');
    expect(await t.releaseNumber('PN000001')).toEqual({ released: true }); const c = await t.startCall({ from: '+12025550111', to: '+12025550100', url: 'https://x/v', statusCallback: 'https://x/s' }); expect(c.providerCallId).toBe('CA000001');
    expect(await t.fetchCall('CA000001')).toMatchObject({ status: 'completed', durationSeconds: 62, price: 0.013, priceUnit: 'USD' });
    const bad = new TwilioProvider({ sid: SID, token: 'wrong-token', base: mock.url, fetchImpl: fetch }); const h = await bad.healthCheck(); expect(h.ok).toBe(false); expect(h.detail).toContain('rejected the credentials'); expect(JSON.stringify(h)).not.toContain('wrong-token');
    const err = await bad.provisionNumber({ e164: '+12025550111' }).catch((e) => e); expect(err.code).toBe('PROVIDER_AUTH_FAILED'); expect(err.message).not.toContain('wrong-token');
    const down = new TwilioProvider({ sid: SID, token: TOKEN, base: 'http://127.0.0.1:1', fetchImpl: fetch }); expect((await down.healthCheck()).ok).toBe(false); expect((await down.startCall({ from: 'a', to: 'b', url: 'c' }).catch((e) => e)).code).toBe('PROVIDER_UNREACHABLE');   // provider outage: a clear failure, no hang
  });

  test('fail closed: with no carrier nothing is connected, provisioned or dialled, and every capability says why', async () => {
    const svc = await mk(env(), { carrier: new P.UnconfiguredProvider() }); const caps = await svc.capabilities(USER.id);
    expect(caps).toMatchObject({ provider: { status: 'not_connected' }, dialin: { status: 'not_connected' }, carrier: { status: 'off' }, number: { status: 'unassigned' }, bridge: { status: 'not_built' }, billing: { status: 'not_connected' }, callingEnabled: false, phoneMeetingJoinEnabled: false });
    expect((await svc.testConnection(ADMIN)).ok).toBe(false); expect((await svc.testConnection(USER).catch((e) => e)).code).toBe('FORBIDDEN');
    expect((await svc.requestNumber(ADMIN, { country: 'US', idempotencyKey: 'key-aaaaaaaa' }).catch((e) => e)).code).toBe('PROVIDER_NOT_CONNECTED'); expect((await svc.availableNumbers(ADMIN, 'US')).numbers).toEqual([]);
    expect((await svc.startCall(USER, { to: '+12025550100', idempotencyKey: 'call-aaaaaaaa' }).catch((e) => e)).code).toBe('CARRIER_NOT_ENABLED');
  });

  test('T01 connection: health check + a signed webhook are both required; the status is evidence, not configuration', async () => {
    const svc = await mk(); expect((await svc.capabilities(USER.id)).provider.status).toBe('not_connected');   // credentials present, nothing proven
    const r = await svc.testConnection(ADMIN); expect(r).toMatchObject({ ok: true, webhookConfigured: true, webhookVerified: false }); expect(r.next).toContain('signed webhook');
    expect((await svc.capabilities(USER.id)).provider.status).toBe('pending'); await svc.markWebhookVerified(); expect((await svc.capabilities(USER.id)).provider.status).toBe('active');
    mock.state.accountStatus = 'suspended'; expect((await svc.testConnection(ADMIN)).ok).toBe(false); expect((await svc.capabilities(USER.id)).provider.status).toBe('not_connected'); mock.state.accountStatus = 'active'; await svc.testConnection(ADMIN);   // an outage drops the status
  });

  test('T02 provisioning: admin only, eligibility, idempotent, asynchronous; the carrier-confirmed number is recorded and assigned; personal and shared numbers stay separate', async () => {
    const svc = await mk();
    expect((await svc.requestNumber(USER, { country: 'US', idempotencyKey: 'key-user-0001' }).catch((e) => e)).code).toBe('FORBIDDEN');
    expect((await svc.requestNumber(ADMIN, { country: 'GH', idempotencyKey: 'key-gh-00001' }).catch((e) => e)).code).toBe('COUNTRY_NOT_ALLOWED'); expect((await svc.requestNumber(ADMIN, { country: 'US', idempotencyKey: 'x' }).catch((e) => e)).code).toBe('IDEMPOTENCY_REQUIRED');
    expect((await svc.requestNumber(ADMIN, { country: 'US', kind: 'weird', idempotencyKey: 'key-kind-001' }).catch((e) => e)).code).toBe('INVALID_KIND'); expect((await svc.availableNumbers(USER, 'US').catch((e) => e)).code).toBe('FORBIDDEN');
    expect((await svc.availableNumbers(ADMIN, 'US')).numbers[0].e164).toBe('+12025550111');
    const req = await svc.requestNumber(ADMIN, { country: 'US', kind: 'personal', assignTo: USER.id, idempotencyKey: 'key-personal-1' }); expect(req.state).toBe('requested');
    expect(await svc.requestNumber(ADMIN, { country: 'US', kind: 'personal', assignTo: USER.id, idempotencyKey: 'key-personal-1' })).toMatchObject({ id: req.id, duplicate: true });   // a retry never buys a second number
    expect((await svc.capabilities(USER.id)).number.status).toBe('unassigned');   // requested is not assigned
    const before = mock.log.filter((l) => l.method === 'POST' && l.url.includes('IncomingPhoneNumbers')).length; expect(await svc.runProvisioning()).toBe(1); expect(await svc.runProvisioning()).toBe(0);
    expect(mock.log.filter((l) => l.method === 'POST' && l.url.includes('IncomingPhoneNumbers')).length).toBe(before + 1);
    const [n] = await q("SELECT * FROM qphone_numbers WHERE assigned_to=$1", [USER.id]); expect(n).toMatchObject({ e164: '+12025550111', provider: 'twilio', kind: 'personal', state: 'active' }); expect(n.provider_number_id).toBe('PN000002');
    expect((await svc.capabilities(USER.id)).number.status).toBe('active'); expect((await svc.capabilities(OTHER.id)).number.status).toBe('unassigned');
    expect((await svc.listNumbers(USER)).map((x) => x.number)).toEqual(['+12025550111']); expect(await svc.listNumbers(OTHER)).toEqual([]);
    // carrier says no numbers: the request fails with a code, nothing is invented
    mock.state.available = []; const r2 = await svc.requestNumber(ADMIN, { country: 'CA', kind: 'dialin', idempotencyKey: 'key-dialin-01' }); await svc.runProvisioning(); expect((await svc.listRequests(ADMIN)).find((x) => x.id === r2.id)).toMatchObject({ state: 'failed', error: 'NO_NUMBERS_AVAILABLE' });
    mock.state.available = [{ phone_number: '+16465550123', capabilities: { voice: true } }]; await svc.requestNumber(ADMIN, { country: 'US', kind: 'dialin', idempotencyKey: 'key-dialin-02' }); await svc.runProvisioning();
    expect((await svc.dialInDirectory()).map((x) => x.number)).toEqual(['+16465550123']); expect((await svc.listNumbers(OTHER)).map((x) => x.number)).toEqual(['+16465550123']);   // a shared dial-in number is visible to everyone, a personal one only to its owner
    expect((await svc.setNumberState(USER, n.id, 'suspended').catch((e) => e)).code).toBe('FORBIDDEN'); await svc.setNumberState(ADMIN, n.id, 'suspended'); expect((await svc.capabilities(USER.id)).number.status).toBe('unassigned'); await svc.setNumberState(ADMIN, n.id, 'active');
    expect((await svc.reassignNumber(ADMIN, n.id, OTHER.id)).assignedTo).toBe(OTHER.id); await svc.reassignNumber(ADMIN, n.id, USER.id);
  });

  test('T03/T06 calling: gates, fraud screen, spending limit, idempotency, one carrier call per intent, out-of-order and duplicate events, usage ledger and reconciliation', async () => {
    const audio = { ready: true, outboundTwiml: () => '<Dial>stub</Dial>' };   // a labelled test double: no real voice gateway exists
    const svc = await mk(env(), { audio }), DEST = '+12025550100';
    expect((await svc.startCall(USER, { to: DEST, idempotencyKey: 'call-00000001' }).catch((e) => e)).code).toBe('CARRIER_NOT_ENABLED');          // provider active but not certified for calling
    await certify('carrier'); expect((await svc.startCall(USER, { to: DEST, idempotencyKey: 'call-00000001' }).catch((e) => e)).code).toBe('BILLING_NOT_CERTIFIED');   // paid calling needs billing certified
    await certify('billing'); const noAudio = await mk(env(), {}); expect((await noAudio.startCall(USER, { to: DEST, idempotencyKey: 'call-00000001' }).catch((e) => e)).code).toBe('AUDIO_GATEWAY_NOT_CONFIGURED');
    expect((await svc.startCall(USER, { to: DEST, idempotencyKey: 'call-00000001' }).catch((e) => e)).code).toBe('SPENDING_LIMIT');                // no limit set = paid calling off
    expect((await svc.setLimit(USER, USER.id, 5e6).catch((e) => e)).code).toBe('FORBIDDEN'); await svc.setLimit(ADMIN, USER.id, 5e6);
    for (const [to, code] of [['+19005551234', 'DESTINATION_BLOCKED'], ['+233201234567', 'COUNTRY_NOT_ALLOWED'], ['12345', 'INVALID_E164'], ['+911', 'INVALID_E164']]) expect((await svc.startCall(USER, { to, idempotencyKey: 'call-' + code.slice(0, 6) + '00' }).catch((e) => e)).code, to).toBe(code);
    expect((await svc.startCall(OTHER, { to: DEST, idempotencyKey: 'call-other-001' }).catch((e) => e)).code).toBe('NO_NUMBER');   // OTHER has no number of their own to call from
    expect((await svc.startCall(USER, { to: DEST, idempotencyKey: 'bad' }).catch((e) => e)).code).toBe('IDEMPOTENCY_REQUIRED');
    const c1 = await svc.startCall(USER, { to: DEST, idempotencyKey: 'call-00000001' }); expect(c1).toMatchObject({ state: 'queued', destinationLast4: '0100', country: 'US' }); expect(JSON.stringify(c1)).not.toContain('2025550100');
    expect(await svc.startCall(USER, { to: DEST, idempotencyKey: 'call-00000001' })).toMatchObject({ id: c1.id, duplicate: true });
    const placed = () => mock.log.filter((l) => l.method === 'POST' && l.url.endsWith('/Calls.json')).length, p0 = placed();
    expect(await svc.runCalls()).toBe(1); expect(await svc.runCalls()).toBe(0); expect(placed()).toBe(p0 + 1);   // a retry never rings twice
    const post = mock.log.filter((l) => l.url.endsWith('/Calls.json')).pop(); expect(post.form).toMatchObject({ From: '+12025550111', To: DEST }); expect(post.form.Url).toContain('/voice?intent=' + c1.id);
    const [row] = await q('SELECT * FROM qphone_call_intents WHERE id=$1', [c1.id]); const sid = row.provider_call_id; expect(sid).toMatch(/^CA/);
    expect((await svc.getCall(OTHER, c1.id).catch((e) => e)).code).toBe('NOT_FOUND'); expect((await svc.getCall(USER, c1.id)).state).toBe('placing');
    // out of order and duplicated events: ringing arrives after in-progress, completed arrives twice, a late "ringing" after completion changes nothing
    for (const [status, seq] of [['in-progress', 3], ['ringing', 2], ['completed', 4], ['completed', 4], ['ringing', 2]]) await svc.applyCallEvent({ providerCallId: sid, status, sequence: seq, duration: status === 'completed' ? 62 : null });
    expect((await svc.getCall(USER, c1.id)).state).toBe('completed'); expect((await q('SELECT count(*)::int AS n FROM qphone_usage WHERE provider_usage_id=$1', [sid]))[0].n).toBe(1);   // one ledger row, however many events
    expect(await svc.applyCallEvent({ providerCallId: 'CAunknown', status: 'completed' })).toEqual({ ignored: true });
    // reconciliation: the carrier's duration and price are authoritative; a local/carrier duration mismatch is disputed, not silently billed
    await pool.query('UPDATE qphone_usage SET local_seconds=60 WHERE provider_usage_id=$1', [sid]); expect(await svc.reconcileUsage()).toBe(1);
    let u = await svc.usage(USER); expect(u.records[0]).toMatchObject({ state: 'reconciled', seconds: 62, providerCost: 0.013, currency: 'USD', customerCharge: 0.013 }); expect(u.totals.customerCharge).toBeCloseTo(0.013);
    expect((await svc.capabilities(USER.id)).billing.status).toBe('active');   // certified AND at least one reconciled record
    const c2 = await svc.startCall(USER, { to: DEST, idempotencyKey: 'call-00000002' }); await svc.runCalls(); const [r2] = await q('SELECT provider_call_id FROM qphone_call_intents WHERE id=$1', [c2.id]);
    await svc.applyCallEvent({ providerCallId: r2.provider_call_id, status: 'in-progress' }); await svc.applyCallEvent({ providerCallId: r2.provider_call_id, status: 'completed', duration: 62 }); await pool.query('UPDATE qphone_usage SET local_seconds=120 WHERE provider_usage_id=$1', [r2.provider_call_id]);
    await svc.reconcileUsage(); expect((await svc.usage(USER)).records.find((x) => x.callId === c2.id).state).toBe('disputed');
    const markup = await mk(env({ PHONE_MARKUP_PERCENT: '50', PHONE_TAX_PERCENT: '10' }), { audio }); const c3 = await markup.startCall(USER, { to: DEST, idempotencyKey: 'call-00000003' }); await markup.runCalls(); const [r3] = await q('SELECT provider_call_id FROM qphone_call_intents WHERE id=$1', [c3.id]);
    await markup.applyCallEvent({ providerCallId: r3.provider_call_id, status: 'completed', duration: 62 }); await markup.reconcileUsage(); const m3 = (await markup.usage(USER)).records.find((x) => x.callId === c3.id); expect(m3.providerCost).toBe(0.013); expect(m3.customerCharge).toBeCloseTo(0.0195); expect(m3.tax).toBeCloseTo(0.00195);   // provider cost and customer charge are separate
    expect((await svc.adjust(USER, m3.id, { kind: 'refund', amountMicros: 1000, reason: 'test refund' }).catch((e) => e)).code).toBe('FORBIDDEN'); expect((await svc.adjust(ADMIN, m3.id, { kind: 'refund', amountMicros: -5, reason: 'bad amount' }).catch((e) => e)).code).toBe('INVALID_AMOUNT'); expect((await svc.adjust(ADMIN, m3.id, { kind: 'refund', amountMicros: 1000, reason: 'x' }).catch((e) => e)).code).toBe('REASON_REQUIRED');
    await svc.adjust(ADMIN, m3.id, { kind: 'refund', amountMicros: 1000, reason: 'goodwill refund' }); u = await svc.usage(USER); expect(u.totals.refunds).toBeCloseTo(0.001); expect(u.adjustments.length).toBe(1);
    expect((await svc.usage(OTHER)).records).toEqual([]); expect((await svc.usage(ADMIN)).records.length).toBeGreaterThanOrEqual(3);   // an account sees only its own usage
    // spending limit: with a 0.50 reserve per in-flight call and a 1.00 limit, the third concurrent call is refused
    await svc.setLimit(ADMIN, USER.id, 1.0e6); await svc.startCall(USER, { to: DEST, idempotencyKey: 'call-spend-001' }); expect((await svc.startCall(USER, { to: DEST, idempotencyKey: 'call-spend-002' }).catch((e) => e)).code).toBe('SPENDING_LIMIT');
    await svc.setLimit(ADMIN, USER.id, 1e9); const perHour = await mk(env({ PHONE_MAX_CALLS_PER_HOUR: '1' }), { audio }); expect((await perHour.startCall(USER, { to: DEST, idempotencyKey: 'call-rate-0001' }).catch((e) => e)).code).toBe('RATE_LIMITED');
    const end = await svc.endCall(USER, c1.id); expect(end.state).toBe('completed'); const diag = await svc.diagnostics(ADMIN); expect(diag.audit.length).toBeGreaterThan(3); expect(JSON.stringify(diag)).not.toMatch(/tok-|2025550100/);   // diagnostics: state only
  });

  test('independent feature flags: a certified gate does nothing unless its flag is on, and the default is everything off', async () => {
    const off = await mk(env({ PHONE_FEATURES: '' })), on = await mk(env({ PHONE_FEATURES: 'carrier' }));
    await pool.query('DELETE FROM qphone_gates'); await certify('carrier'); await certify('dialin');
    const a = await off.capabilities(USER.id); expect(a.carrier.status).toBe('off'); expect(a.carrier.detail).toContain('switched off by the PHONE_FEATURES'); expect(a.dialin.detail).toContain('PHONE_FEATURES');
    const b = await on.capabilities(USER.id); expect(b.carrier.status).toBe('active'); expect(b.dialin.status).not.toBe('active');   // dialin is certified but its flag is not on
    expect((await mk(env({ PHONE_FEATURES: undefined }))).flags().size).toBe(0);
    await pool.query('DELETE FROM qphone_gates');
  });

  test('saved preferences are not enforced preferences: the registry, the activation pipeline, read-back confirmation, drift and failure (fake carrier that supports them; the real Twilio adapter supports none)', async () => {
    const F = await M('features.mjs');
    expect(F.cleanDesired({ forwarding: { enabled: true, to: '+44 20 7123 4567' }, voicemail: { enabled: true, greeting: 'x'.repeat(400) }, bogus: { enabled: true }, blockedNumbers: { enabled: true, count: 500 }, callerId: { enabled: true, name: '  Desk  ' } })).toEqual({ forwarding: { enabled: true, to: '+442071234567' }, voicemail: { enabled: true, greeting: 'x'.repeat(300) }, blockedNumbers: { enabled: true, count: 100 }, callerId: { enabled: true, name: 'Desk' } });
    expect(() => F.cleanDesired({ forwarding: { enabled: true, to: '555' } })).toThrow(/international/); expect(F.cleanDesired({ forwarding: { enabled: false } })).toEqual({ forwarding: { enabled: false } });
    const { TwilioProvider } = await M('twilio.mjs');
    // 1. the real adapter: nothing is supported, so everything is "saved, inactive" even with a connected carrier, a number and the flag on
    const real = await mk(); await real.testConnection(ADMIN); await real.markWebhookVerified(); await pool.query("DELETE FROM qphone_numbers WHERE assigned_to='u_feat'"); await pool.query("INSERT INTO qphone_numbers(e164,provider,provider_number_id,country,kind,assigned_to,state) VALUES('+12025550177','twilio','PNfeat','US','personal','u_feat','active')");
    const U = { id: 'u_feat', admin: false };
    let st = await real.setDesired(U, { forwarding: { enabled: true, to: '+12025550100' }, doNotDisturb: { enabled: true }, voicemail: { enabled: false } });
    expect(st.features.forwarding).toMatchObject({ enabled: true, state: 'inactive' }); expect(st.features.forwarding.reason).toContain('cannot enforce this setting yet'); expect(st.features.voicemail.state).toBe('off'); expect(st.enforcing).toBe(0);
    expect(await real.runFeatures()).toBe(0);   // nothing for the worker to do: it never pretends
    // 2. no carrier, no number, flag off: each says its own reason
    const none = await mk(env(), { carrier: new P.UnconfiguredProvider() }); expect((await none.featureStatus(U)).features.forwarding.reason).toContain('No carrier is connected');
    expect((await (await mk(env({ PHONE_FEATURES: 'carrier' }))).featureStatus(U)).features.forwarding.reason).toContain('PHONE_FEATURES'); await pool.query("UPDATE qphone_numbers SET state='suspended' WHERE assigned_to='u_feat'"); expect((await real.featureStatus(U)).features.forwarding.reason).toContain('no Qorlla number'); await pool.query("UPDATE qphone_numbers SET state='active' WHERE assigned_to='u_feat'");
    // 3. a fake carrier that DOES support forwarding and DND: pending -> applied -> read back -> active; drift is detected and corrected; a carrier that will not hold it is "failed"
    const held = new Map(), fake = new TwilioProvider({ sid: SID, token: TOKEN, base: mock.url, webhookBase: 'https://qorlla.example', fetchImpl: fetch });
    Object.defineProperty(fake, 'features', { get: () => new Set(['forwarding', 'doNotDisturb']) }); fake.applyFeature = async ({ providerNumberId, feature, config }) => { if (feature === 'doNotDisturb' && fake.refuse) throw Object.assign(new Error('no'), { code: 'PROVIDER_REJECTED' }); held.set(providerNumberId + feature, config); }; fake.readFeature = async ({ providerNumberId, feature }) => (fake.lie ? { enabled: false } : held.get(providerNumberId + feature) || { enabled: false });
    const svc = await mk(env(), { carrier: fake }); await svc.testConnection(ADMIN); await svc.markWebhookVerified();
    st = await svc.featureStatus(U); expect(st.features.forwarding.state).toBe('pending'); expect(st.features.callWaiting.state).toBe('off');   // supported and allowed: queued, NOT yet active
    expect(await svc.runFeatures()).toBe(2); st = await svc.featureStatus(U); expect(st.features.forwarding).toMatchObject({ state: 'active' }); expect(st.features.forwarding.reason).toContain('Confirmed by the carrier'); expect(st.enforcing).toBe(2); expect(held.get('PNfeatforwarding')).toEqual({ enabled: true, to: '+12025550100' });
    held.set('PNfeatforwarding', { enabled: true, to: '+19998887777' }); await svc.runFeatures();   // reconcile pass: the first run detects the change...
    let [row] = (await pool.query("SELECT state FROM qphone_feature_state WHERE owner_id='u_feat' AND feature='forwarding'")).rows; expect(row.state).toBe('drift'); expect((await svc.featureStatus(U)).features.forwarding.state).toBe('drift'); await svc.runFeatures();
    expect((await svc.featureStatus(U)).features.forwarding.state).toBe('active'); expect(held.get('PNfeatforwarding').to).toBe('+12025550100');   // ...the next re-applies Qorlla's setting
    await svc.setDesired(U, { forwarding: { enabled: false } }); expect((await svc.featureStatus(U)).features.forwarding.state).toBe('off'); await svc.runFeatures(); expect(held.get('PNfeatforwarding')).toEqual({ enabled: false });   // turning it off is applied at the carrier too
    fake.lie = true; await svc.setDesired(U, { forwarding: { enabled: true, to: '+12025550101' } }); await svc.runFeatures(); expect((await svc.featureStatus(U)).features.forwarding).toMatchObject({ state: 'failed' }); expect((await svc.featureStatus(U)).features.forwarding.reason).toContain('NOT_CONFIRMED'); fake.lie = false;   // a read-back that disagrees is never "active"
    await svc.setDesired(U, { forwarding: { enabled: true, to: '+12025550101' } }); await svc.runFeatures(); expect((await svc.featureStatus(U)).features.forwarding.state).toBe('active');   // saving again retries a failed one
    fake.refuse = true; await svc.setDesired(U, { doNotDisturb: { enabled: false } }); await svc.setDesired(U, { doNotDisturb: { enabled: true } }); await svc.runFeatures(); expect((await svc.featureStatus(U)).features.doNotDisturb.state).toBe('failed'); fake.refuse = false;
    expect((await svc.featureStatus({ id: 'u_nobody', admin: false })).features.forwarding.state).toBe('off'); expect((await q("SELECT count(*)::int AS n FROM qphone_audit WHERE action LIKE 'feature.%'"))[0].n).toBeGreaterThan(3);   // transitions are audited
  });

  test('webhooks: signed by the carrier, de-duplicated, safe against replay; dial-in IVR fails closed without a certified bridge; with one, the existing PIN rules decide and the PIN is never stored', async () => {
    const { twilioSignature } = await M('twilio.mjs'), { TwilioProvider } = await M('twilio.mjs');
    const calls = { verify: [], joined: [], ended: [] }; let verdict = { result: 'denied', say: 'x' }, status = 'waiting';
    const phone = { verifyCall: async (j, pn) => { calls.verify.push({ pn, meetingId: j.meetingId, from: j.from, pin: j.pin }); return verdict; }, statusOf: async () => status, endedCall: async (j, pn) => { calls.ended.push({ ...j, pn }); return {}; } };
    let bridgeReady = false; const bridge = { get ready() { return bridgeReady; }, join: async (x) => { calls.joined.push(x); return '<Dial><Sip>sip:bridge.example</Sip></Dial>'; } };
    const app = express(); const srv = http.createServer(app); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const pub = 'http://127.0.0.1:' + srv.address().port;
    const e = env({ PHONE_PUBLIC_BASE: pub }), carrier = new TwilioProvider({ sid: SID, token: TOKEN, base: mock.url, webhookBase: pub, fetchImpl: fetch });
    const t = R.registerTelephony({ app, db: pool, bridgeAuth: (_q, _s, n) => n(), phone, env: e, carrier, bridge, audio: new P.UnconfiguredAudioGateway() });
    const post = async (p, params, o = {}) => { const url = pub + p, sig = o.sig === undefined ? twilioSignature({ token: TOKEN, url, params }) : o.sig; const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig, ...(o.headers || {}) }, body: new URLSearchParams(params).toString() }); return { status: r.status, text: await r.text() }; };
    try {
      await pool.query('DELETE FROM qphone_provider_status'); const svc = t.svc; expect((await svc.capabilities(USER.id)).provider.status).not.toBe('active');
      expect((await post('/api/telephony/webhooks/twilio/status', { CallSid: 'CAx1', CallStatus: 'ringing' }, { sig: 'bogus' })).status).toBe(403); expect((await post('/api/telephony/webhooks/twilio/status', { CallSid: 'CAx1', CallStatus: 'ringing' }, { sig: '' })).status).toBe(403);
      expect((await q('SELECT count(*)::int AS n FROM qphone_provider_events'))[0].n).toBe(0); expect((await svc.providerStatus())).toBeNull();   // a forged webhook has no effect and proves nothing
      const ok = await post('/api/telephony/webhooks/twilio/status', { CallSid: 'CAx1', CallStatus: 'ringing', SequenceNumber: '1' }, { headers: { 'i-twilio-idempotency-token': 'tok-evt-0001' } }); expect(ok.status).toBe(204);
      expect((await svc.providerStatus()).webhook_verified_at).not.toBeNull();   // a SIGNED webhook is what proves the webhook configuration
      expect((await post('/api/telephony/webhooks/twilio/status', { CallSid: 'CAx1', CallStatus: 'ringing', SequenceNumber: '1' }, { headers: { 'i-twilio-idempotency-token': 'tok-evt-0001' } })).status).toBe(204); expect((await q("SELECT count(*)::int AS n FROM qphone_provider_events WHERE provider_event_id='tok-evt-0001'"))[0].n).toBe(1);   // replay: one event
      expect((await post('/api/telephony/webhooks/twilio/status', { CallSid: 'CAx2', CallStatus: 'completed' })).status).toBe(204); expect(calls.ended.some((x) => x.callId === 'CAx2' && x.pn === 'twilio')).toBe(true);   // a dial-in caller who hangs up leaves the meeting
      const voice = (params, query = '') => post('/api/telephony/webhooks/twilio/voice' + query, params);
      expect((await voice({ CallSid: 'CAv1', From: '+12025550188', To: '+19998887777' })).text).toContain('<Reject');   // not one of our numbers
      await pool.query("INSERT INTO qphone_numbers(e164,provider,provider_number_id,country,kind,state) VALUES('+16465550199','twilio','PNdialin','US','dialin','active')");
      const closed = await voice({ CallSid: 'CAv2', From: '+12025550188', To: '+16465550199' }); expect(closed.text).toContain('not available yet'); expect(closed.text).toContain('<Hangup/>'); expect(closed.text).not.toContain('<Gather'); expect(calls.verify.length).toBe(0);   // FAIL CLOSED: no bridge, no PIN prompt, no join claim
      bridgeReady = true; const noGate = await voice({ CallSid: 'CAv3', From: '+12025550188', To: '+16465550199' }); expect(noGate.text).toContain('not available yet');   // an installed bridge is still not enough without certification
      await certify('bridge'); await certify('dialin');
      const g1 = await voice({ CallSid: 'CAv4', From: '+12025550188', To: '+16465550199' }); expect(g1.text).toContain('<Gather'); expect(g1.text).toContain('11-digit meeting ID');
      const bad = await voice({ CallSid: 'CAv4', From: '+12025550188', To: '+16465550199', Digits: '12345' }, '?step=id&a=0'); expect(bad.text).toContain('could not connect you'); expect(bad.text).toContain('<Gather');
      const idOk = await voice({ CallSid: 'CAv4', From: '+12025550188', To: '+16465550199', Digits: '12345678901' }, '?step=id&a=1'); expect(idOk.text).toContain('step=pin'); expect(idOk.text).toContain('m=12345678901'); expect(idOk.text).not.toMatch(/Digits|pin=\d/);
      const den1 = await voice({ CallSid: 'CAv4', From: '+12025550188', To: '+16465550199', Digits: '99999999' }, '?step=pin&m=12345678901&a=0'); expect(den1.text).toContain('<Gather'); expect(calls.joined.length).toBe(0);
      const den3 = await voice({ CallSid: 'CAv4', From: '+12025550188', To: '+16465550199', Digits: '99999998' }, '?step=pin&m=12345678901&a=2'); expect(den3.text).toContain('<Hangup/>'); expect(den3.text).not.toContain('<Gather');   // attempts are bounded
      verdict = { result: 'waiting', say: 'Please hold. The host will let you in shortly.', callRef: 'ref-w' }; const w = await voice({ CallSid: 'CAv5', From: '+12025550188', To: '+16465550199', Digits: '12345678' }, '?step=pin&m=12345678901&a=0'); expect(w.text).toContain('Please hold'); expect(w.text).toContain('step=wait'); expect(calls.joined.length).toBe(0);   // waiting room: not joined yet
      status = 'waiting'; expect((await voice({ CallSid: 'CAv5', From: '+12025550188', To: '+16465550199' }, '?step=wait&m=12345678901&a=1')).text).toContain('Redirect'); status = 'connected'; const let1 = await voice({ CallSid: 'CAv5', From: '+12025550188', To: '+16465550199' }, '?step=wait&m=12345678901&a=2'); expect(let1.text).toContain('The host let you in'); expect(calls.joined.length).toBe(1);
      status = 'removed'; expect((await voice({ CallSid: 'CAv5', From: '+12025550188', To: '+16465550199' }, '?step=wait&m=12345678901&a=3')).text).toContain('<Hangup/>');
      verdict = { result: 'connected', say: 'You are connected to the meeting.', callRef: 'ref-c', recordingNotice: true, consentPrompt: 'This meeting may be recorded only if everyone agrees. Press 1 to agree or 2 to decline.' };
      const j = await voice({ CallSid: 'CAv6', From: '+12025550188', To: '+16465550199', Digits: '12345678' }, '?step=pin&m=12345678901&a=0'); expect(j.text).toContain('You are connected'); expect(j.text).toContain('<Sip>'); expect(j.text).toContain('recorded only if everyone agrees'); expect(calls.joined.length).toBe(2);   // the bridge is asked to join ONLY after the Qorlla rules said connected
      expect(calls.verify.every((x) => x.pn === 'twilio' && x.meetingId === '12345678901')).toBe(true); expect(calls.verify.some((x) => x.pin === '12345678')).toBe(true);   // the existing rules received the PIN...
      const stored = JSON.stringify(await q('SELECT * FROM qphone_provider_events')) + JSON.stringify(await q('SELECT * FROM qphone_audit')); expect(stored).not.toMatch(/(?<![0-9])(12345678|99999999|99999998)(?![0-9])/);   // ...but it is never stored
      const dup = await voice({ CallSid: 'CAv6', From: '+12025550188', To: '+16465550199', Digits: '12345678' }, '?step=pin&m=12345678901&a=0'); expect(dup.text).toBe(j.text); expect(calls.joined.length).toBe(2);   // a carrier retry gets the same answer and never joins twice
    } finally { t.stop(); await new Promise((r) => srv.close(r)); }
  });
});

// END TO END: the real main app and a real second Meet (:3311) in an ISOLATED database schema, with Meet talking to the local Twilio stand-in. This is the closest proof available without a real carrier.
test.describe('end to end: Numbers & Plans administration (main app + Meet + Twilio stand-in)', () => {
  test.describe.configure({ mode: 'serial' });
  const { startMain, organiser, PASSWORD } = require('./support/meet-stack');
  const { spawn } = require('node:child_process'); const os = require('node:os');
  let mock, meet, schema, sp, main; const MEETP = 3311;
  test.beforeAll(async () => {
    mock = await mockTwilio(); schema = 'qe_' + Math.random().toString(36).slice(2, 10);
    const a = new Pool({ connectionString: URL_DB }); await a.query('CREATE SCHEMA ' + schema); await a.end();
    sp = new Pool({ connectionString: URL_DB, options: '-c search_path=' + schema + ',public' }); for (const f of ['v4_14_telephony.sql', 'v4_15_telephony_features.sql']) await sp.query(fs.readFileSync(path.resolve(__dirname, '..', 'qorlla-meet-video', 'sql', f), 'utf8'));
    const env = { ...process.env, PORT: String(MEETP), DATABASE_URL: URL_DB + '?options=' + encodeURIComponent('-c search_path=' + schema + ',public'), JWT_SECRET: secrets.jwt, QORLLA_BRIDGE_SECRET: secrets.bridge, RECOVERY_ESCROW_KEY: secrets.escrow, NODE_ENV: 'development',
      RECORDING_MASTER_KEYS: JSON.stringify({ dev1: secrets.recordingKey }), RECORDING_ACTIVE_KEY_ID: 'dev1', RECORDING_STORE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'qrec-')), RECORDING_ADMIN_SECRET: 'test-admin-secret',
      PHONE_CARRIER: 'twilio', TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_API_BASE: mock.url, PHONE_PUBLIC_BASE: 'http://127.0.0.1:' + MEETP, PHONE_ALLOWED_COUNTRIES: 'US,GB', PHONE_WORKER_MS: '400', PHONE_RECONCILE_DELAY_S: '0', PHONE_FEATURES: 'dialin,carrier,bridge,billing,settings' };
    meet = spawn(process.execPath, ['server/index.js'], { cwd: path.resolve(__dirname, '..', 'qorlla-meet-video'), env, stdio: 'ignore' });
    for (let i = 0; i < 60; i++) { if (await fetch('http://127.0.0.1:' + MEETP + '/api/config').then((r) => r.ok).catch(() => false)) break; await new Promise((r) => setTimeout(r, 500)); }
    main = await startMain(5293, { MEET_PROBE_URL: 'http://127.0.0.1:' + MEETP, PHONE_ADMIN_USERS: 'org*' });
  });
  test.afterAll(async () => { if (main) main.stop(); if (meet) meet.kill(); if (sp) await sp.end(); const a = new Pool({ connectionString: URL_DB }); await a.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(() => {}); await a.end(); if (mock) await mock.close(); });

  test('a connected-but-uncertified carrier stays fail-closed; the admin tools work through Meet; a non-admin has none of them', async ({ browser }) => {
    test.setTimeout(150000); const { twilioSignature } = await M('twilio.mjs');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); await organiser(ctx, main.base); const page = await ctx.newPage(); const caps = async () => (await (await ctx.request.get(main.base + '/api/phone/overview')).json());
    await page.goto(main.base + '/qorlla.html#home'); await page.locator('.nav-item[data-view=phone]').click(); await page.locator('#phTab-settings').click(); await page.locator('#qpPT-plans').click();
    await expect(page.locator('#phStatus')).toContainText('Telephony provider: Not connected'); await expect(page.locator('#phStatus')).toContainText('health check'); await expect(page.locator('#phStatus')).toContainText('Audio bridge for phone callers: Not built'); await expect(page.locator('#phStatus')).toContainText('Telephony billing: Not connected');
    // admin tools exist, only for an administrator, only because Meet answers
    await page.locator('#qpPT-admin').click(); await page.locator('#qpTestConn').click(); await expect(page.locator('#qpConnOut')).toContainText('Reachable and active'); await expect(page.locator('#qpConnOut')).toContainText('not received yet'); await expect(page.locator('#qpConnOut')).toContainText('signed webhook'); expect(JSON.stringify(await caps())).not.toContain(TOKEN);
    expect((await caps()).capabilities.provider.status).toBe('pending');   // the API answered but no signed webhook: NOT connected yet
    const url = 'http://127.0.0.1:' + MEETP + '/api/telephony/webhooks/twilio/status', params = { CallSid: 'CAe2e', CallStatus: 'ringing', SequenceNumber: '1' };
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'forged' }, body: new URLSearchParams(params).toString() })).status).toBe(403); expect((await caps()).capabilities.provider.status).toBe('pending');   // a forged webhook proves nothing
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature({ token: TOKEN, url, params }) }, body: new URLSearchParams(params).toString() })).status).toBe(204); expect((await caps()).capabilities.provider.status).toBe('active');
    // provisioning: request -> carrier -> confirmed -> assigned (asynchronous)
    await page.locator('#qpAD-req').click(); await expect(page.locator('#qpReqCountry option')).not.toHaveCount(0); await page.locator('#qpReqCountry').selectOption('US'); await page.locator('#qpReqSend').click(); await expect(page.locator('#qpReqSendMsg')).toContainText('requested');
    await expect.poll(async () => { await page.locator('#qpReqRefresh').click(); return page.locator('#qpReqTable').textContent().catch(() => ''); }, { timeout: 20000, intervals: [700] }).toContain('provisioned');
    await page.locator('#phTab-dial').click(); await page.locator('#phTab-settings').click(); await expect(page.locator('#qpMyNumber')).toHaveText('+12025550111'); await expect(page.locator('#qpNumber')).toContainText('not verified');
    await page.locator('#qpPT-plans').click(); await expect(page.locator('#phStatus')).toContainText('Telephony provider: Active'); await expect(page.locator('#phStatus')).toContainText('Your Qorlla number: Active'); await expect(page.locator('#phStatus')).toContainText('Carrier calling: Off');   // a number exists, calling is still not certified
    // calling stays off at every layer until each gate is certified AND a voice gateway exists
    const call = (key) => ctx.request.post(main.base + '/api/phone/calls', { data: { to: '+12025550100' }, headers: { 'Idempotency-Key': key } });
    let r = await call('e2e-call-0001'); expect(r.status()).toBe(503); expect((await r.json()).code).toBe('CARRIER_NOT_ENABLED');
    for (const g of ['carrier', 'billing']) await sp.query("INSERT INTO qphone_gates(gate,evidence_ref,evidence_sha256,certified_by) VALUES($1,'e2e-test',repeat('b',64),'test') ON CONFLICT DO NOTHING", [g]);
    r = await call('e2e-call-0002'); expect(r.status()).toBe(503); expect((await r.json()).code).toBe('AUDIO_GATEWAY_NOT_CONFIGURED');   // carrier + billing certified, but no voice gateway: still no call
    expect((await caps()).carrierCalling).toBe(false);   // calling also needs billing proven by a reconciled record
    // spending limit via the admin screen; usage, diagnostics
    await page.locator('#phTab-dial').click(); await page.locator('#phTab-settings').click(); await page.locator('#qpPT-admin').click(); await page.locator('#qpAD-usage').click(); await expect(page.locator('#qpNoUsage')).toBeVisible(); await expect(page.locator('#qpUsageTotals')).toContainText('none set');
    await page.locator('#qpLimitAmt').fill('25'); await page.locator('#qpLimitSave').click(); await expect(page.locator('#qpLimitMsg')).toContainText('Limit set to 25');
    await page.locator('#qpAD-diag').click(); await expect(page.locator('#qpDiagProvider')).toContainText('twilio'); await expect(page.locator('#qpDiagProvider')).toContainText('passed'); await expect(page.locator('#qpNoDiagCalls')).toBeVisible(); await expect(page.locator('.ps-audit')).toContainText('number.provisioned');
    // an outage is visible: the carrier account is suspended, a new test says not connected
    mock.state.accountStatus = 'suspended'; await page.locator('#qpAD-conn').click(); await page.locator('#qpTestConn').click(); await expect(page.locator('#qpConnOut')).toContainText('Not connected'); expect((await caps()).capabilities.provider.status).toBe('not_connected'); mock.state.accountStatus = 'active';
    // a non-administrator: no Admin tab, no number request, no usage of others, no limits
    const uctx = await browser.newContext(); const uname = 'plain' + Math.random().toString(36).slice(2, 7); expect((await uctx.request.post(main.base + '/api/auth/register', { data: { username: uname, displayName: 'Plain', password: PASSWORD } })).status()).toBe(201);
    const up = await uctx.newPage(); await up.goto(main.base + '/qorlla.html#home'); await up.locator('.nav-item[data-view=phone]').click(); await up.locator('#phTab-settings').click(); await expect(up.locator('#qpPT-plans')).toBeVisible(); await expect(up.locator('#qpPT-admin')).toHaveCount(0);
    expect((await uctx.request.post(main.base + '/api/phone/numbers/provision', { data: { country: 'US' }, headers: { 'Idempotency-Key': 'plain-req-001' } })).status()).toBe(403); expect((await uctx.request.post(main.base + '/api/phone/provider/test-connection', { data: {} })).status()).toBe(403);
    expect((await uctx.request.put(main.base + '/api/phone/limits/anyone', { data: { monthlyLimitMicros: 1 } })).status()).toBe(403); expect((await uctx.request.get(main.base + '/api/phone/numbers/requests')).status()).toBe(403); expect((await (await uctx.request.get(main.base + '/api/phone/usage')).json()).records).toEqual([]);
    expect((await (await uctx.request.get(main.base + '/api/phone/overview')).json()).assigned).toEqual([]);   // the admin's personal number is not theirs
    await uctx.close(); await ctx.close();
  });
});
