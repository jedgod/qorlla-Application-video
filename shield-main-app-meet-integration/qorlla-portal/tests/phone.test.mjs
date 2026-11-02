import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, addMember, ORIGIN } from './helpers.mjs';
import { startFakeLlm } from './fake-llm.mjs';
import { startFakeTwilio, webhook, SID, TOKEN } from './fake-twilio.mjs';
import { hoursState, decide, menuRoutes, openSlots, zonedToUtc, localParts } from '../server/telephony/routing.mjs';
import { verifySignature, signFor, accessToken } from '../server/telephony/twilio.mjs';
import { destinationAllowed } from '../server/phone.mjs';

const ACK = 'confirmed-numbers-consent-and-regulatory-review';
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '00:00', closes: '23:59' }));
const today = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => new Date(Date.now() + 864e5).toISOString().slice(0, 10);
const NUM = '+12025550100', CALLER = '+12025550177', STAFF = '+12025550188', MOBILE = '+12025550199';
const csid = () => 'CA' + crypto.randomBytes(16).toString('hex');
const rsid = () => 'RE' + crypto.randomBytes(16).toString('hex');

describe('telephony routing (pure logic)', () => {
  const profile = { voicemail_enabled: true, closed_greeting_text: 'Closed.', escalation_numbers: ['+12025550111'] };
  test('hours are evaluated in the profile time zone and closures always win', () => {
    const windows = [{ weekday: 1, opens: '09:00', closes: '17:00' }];
    assert.equal(hoursState({ timezone: 'America/New_York', windows, closures: [] }, new Date('2026-10-26T14:00:00Z')), 'open');     // Mon 10:00 EDT
    assert.equal(hoursState({ timezone: 'America/New_York', windows, closures: [] }, new Date('2026-10-26T12:30:00Z')), 'closed');   // Mon 08:30 EDT
    assert.equal(hoursState({ timezone: 'America/New_York', windows, closures: [] }, new Date('2026-10-26T21:00:00Z')), 'closed');   // Mon 17:00 EDT (end exclusive)
    assert.equal(hoursState({ timezone: 'America/New_York', windows, closures: [{ on_date: '2026-10-26' }] }, new Date('2026-10-26T14:00:00Z')), 'closed');
    assert.equal(hoursState({ timezone: 'UTC', windows: [], closures: [] }), 'closed', 'no configured hours means closed');
  });
  test('zonedToUtc handles daylight-saving transitions', () => {
    assert.equal(zonedToUtc('2026-03-08', 9 * 60, 'America/New_York').toISOString(), '2026-03-08T13:00:00.000Z');   // after spring-forward (EDT)
    assert.equal(zonedToUtc('2026-03-07', 9 * 60, 'America/New_York').toISOString(), '2026-03-07T14:00:00.000Z');   // before (EST)
    assert.equal(localParts(new Date('2026-11-01T05:30:00Z'), 'America/New_York').date, '2026-11-01');
  });
  test('decide: first matching rule wins; forwarding is stopped when the plan has no minutes left; no rule falls back to voicemail', () => {
    const routes = [
      { id: 'a', position: 1, name: 'VIP', hours: 'any', digit: null, caller_prefix: '+1202555017', action: 'forward', destination: '+12025550122' },
      { id: 'b', position: 2, name: 'Sales', hours: 'open', digit: '1', caller_prefix: null, action: 'forward', destination: '+12025550133' },
      { id: 'c', position: 3, name: 'Urgent', hours: 'any', digit: '9', caller_prefix: null, action: 'escalate' }];
    assert.equal(decide({ profile, routes, hours: 'open', caller: '+12025550177' }).route.name, 'VIP');
    assert.equal(decide({ profile, routes, hours: 'open', digit: '1', caller: '+19995550000' }).destination, '+12025550133');
    assert.equal(decide({ profile, routes, hours: 'closed', digit: '1', caller: '+19995550000' }).action, 'voicemail', 'open-hours rule does not apply when closed');
    assert.equal(decide({ profile, routes, hours: 'open', digit: '1', caller: '+19995550000', minutesExhausted: true }).reason, 'plan_minutes_exhausted');
    assert.equal(decide({ profile, routes, hours: 'open', digit: '9', caller: 'x' }).action, 'escalate');
    assert.equal(decide({ profile: { ...profile, escalation_numbers: [] }, routes, hours: 'open', digit: '9', caller: 'x' }).reason, 'no_escalation_numbers');
    assert.equal(decide({ profile: { ...profile, voicemail_enabled: false }, routes: [], hours: 'closed', caller: 'x' }).action, 'message');
    assert.equal(menuRoutes(routes, 'closed').map((r) => r.digit).join(), '9');
  });
  test('openSlots excludes bookings, closures and slots that do not fit', () => {
    const windows = [{ weekday: 3, opens: '09:00', closes: '11:00' }];   // 2026-10-28 is a Wednesday
    const base = { timezone: 'UTC', windows, closures: [], date: '2026-10-28', durationMin: 30 };
    assert.deepEqual(openSlots(base).map((s) => s.slice(11, 16)), ['09:00', '09:30', '10:00', '10:30']);
    assert.deepEqual(openSlots({ ...base, booked: [{ starts_at: '2026-10-28T09:30:00Z', ends_at: '2026-10-28T10:00:00Z' }] }).map((s) => s.slice(11, 16)), ['09:00', '10:00', '10:30']);
    assert.deepEqual(openSlots({ ...base, durationMin: 60 }).map((s) => s.slice(11, 16)), ['09:00', '09:30', '10:00']);
    assert.deepEqual(openSlots({ ...base, closures: [{ on_date: '2026-10-28' }] }), []);
  });
  test('destination policy blocks premium-rate, emergency-style and (by default) international numbers', () => {
    assert.equal(destinationAllowed('+12025550100').ok, true);
    assert.equal(destinationAllowed('+19005550100').reason, 'premium_or_emergency');
    assert.equal(destinationAllowed('+442071234567').reason, 'international_disabled');
    assert.equal(destinationAllowed('+442071234567', { allowInternational: true }).ok, true);
    assert.equal(destinationAllowed('2025550100').reason, 'not_e164');
  });
  test('webhook signature: valid accepted; any altered parameter, url or token rejected', () => {
    const params = { CallSid: 'CA1', From: '+1', To: '+2' }; const url = 'https://x.test/api/v1/telephony/voice/inbound';
    const signature = signFor({ authToken: 't', url, params });
    assert.equal(verifySignature({ authToken: 't', url, params, signature }), true);
    assert.equal(verifySignature({ authToken: 't', url, params: { ...params, To: '+3' }, signature }), false);
    assert.equal(verifySignature({ authToken: 't', url: url + '?a=1', params, signature }), false);
    assert.equal(verifySignature({ authToken: 'u', url, params, signature }), false);
    assert.equal(verifySignature({ authToken: 't', url, params, signature: undefined }), false);
    assert.equal(verifySignature({ authToken: 't', url, params, signature: 'AAAA' }), false);
  });
  test('browser dialer token is a HS256 JWT with a voice grant limited to the TwiML app', () => {
    const tok = accessToken({ accountSid: 'AC1', apiKeySid: 'SK1', apiKeySecret: 'secret', twimlAppSid: 'AP1', identity: 'w_u', now: () => 1_000_000 });
    const [h, p, s] = tok.split('.'); const payload = JSON.parse(Buffer.from(p, 'base64url'));
    assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'HS256'); assert.equal(payload.iss, 'SK1'); assert.equal(payload.grants.identity, 'w_u');
    assert.equal(payload.grants.voice.outgoing.application_sid, 'AP1'); assert.equal(payload.grants.voice.incoming.allow, false); assert.equal(payload.exp - payload.iat, 600);
    assert.equal(s, crypto.createHmac('sha256', 'secret').update(h + '.' + p).digest('base64url'));
  });
});

describe('AI receptionist and phone (API + webhooks against PostgreSQL)', () => {
  let db, main, llmd, tw, app, off, W, H, A, M, O, profileId, numberId;
  const host = () => app.client(H); const admin = () => app.client(A); const member = () => app.client(M); const outsider = () => app.client(O);
  const hook = (p, params, o) => webhook(app.base, ORIGIN, '/api/v1/telephony/voice/' + p, params, o);
  const voice = (p, params) => hook(p, { CallSid: csid(), ...params });
  const call = (sid, extra = {}) => hook('inbound', { CallSid: sid, From: CALLER, To: NUM, ...extra });
  const q = async (sql, args = []) => (await db.pool.query(sql, args)).rows;

  before(async () => { try {
    db = await freshDatabase(); main = await startMainStandIn(); llmd = await startFakeLlm(); tw = await startFakeTwilio();
    const env = { AI_LLM_API_KEY: 'test-llm-key', AI_LLM_API_BASE: llmd.url, AI_LLM_MODEL: 'claude-test', TELEPHONY_ENABLED: 'true', TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_API_BASE: tw.url, TELEPHONY_COMPLIANCE_ACK: ACK,
      TWILIO_API_KEY_SID: 'SKtest', TWILIO_API_KEY_SECRET: 'keysecret', TWILIO_TWIML_APP_SID: 'APtest' };
    app = await startApp({ pool: db.pool, cfg: testConfig({ env }, main), jwks: main.jwks, ai: { phoneWorker: { backoffBaseSeconds: 0 } } });
    // a second app with telephony left at its default: it must be inert
    off = await startApp({ pool: db.pool, cfg: testConfig({ env: { AI_LLM_API_KEY: 'test-llm-key', AI_LLM_API_BASE: llmd.url } }, main), jwks: main.jwks });
    H = await main.mint(); A = await main.mint(); M = await main.mint(); O = await main.mint();
    W = await seedWorkspace(db.pool, H.sub, 'Phone Co');
    await db.pool.query(`UPDATE portal.subscriptions SET plan_slug='pro',status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [W]);
    await addMember(db.pool, W, A.sub, 'admin'); await addMember(db.pool, W, M.sub, 'member'); await seedWorkspace(db.pool, O.sub, 'Other Co');
    const p = await host().post('/api/v1/receptionist/profiles', { name: 'Front desk', timezone: 'UTC', escalation_numbers: ['+12025550111'] }); assert.equal(p.status, 201, JSON.stringify(p.body)); profileId = p.body.id;
    const hrs = await host().put(`/api/v1/receptionist/profiles/${profileId}/hours`, { windows: ALL_WEEK, closures: [] }); assert.equal(hrs.status, 200, JSON.stringify(hrs.body));
    const en = await host().patch(`/api/v1/receptionist/profiles/${profileId}`, { enabled: true }); assert.equal(en.status, 200, JSON.stringify(en.body));
    const n = await host().post('/api/v1/phone/numbers', { e164: NUM, label: 'Main line', profile_id: profileId }); assert.equal(n.status, 201, JSON.stringify(n.body)); numberId = n.body.id;
    assert.equal((await host().patch(`/api/v1/phone/numbers/${numberId}`, { status: 'active' })).status, 200);
  } catch (e) { console.error('SETUP FAILED', e); throw e; } });
  after(async () => { await app.close(); await off.close(); await llmd.close(); await tw.close(); await main.close(); await db.drop(); });
  beforeEach(async () => {
    await fetch(llmd.url + '/__control/reset', { method: 'POST' }); tw.st.calls.length = 0; tw.st.recordingRequests.length = 0; tw.st.failCalls = false;
    await db.pool.query(`UPDATE portal.phone_ai_jobs SET status='cancelled' WHERE status IN ('queued','running')`);
    await host().put(`/api/v1/receptionist/profiles/${profileId}/hours`, { windows: ALL_WEEK, closures: [] });
    await host().put(`/api/v1/receptionist/profiles/${profileId}/routes`, { routes: [] });
  });

  describe('off by default', () => {
    test('with telephony unconfigured nothing is accepted, dialled or activated, and the status says why', async () => {
      const s = (await app.client(H).get('/api/v1/phone/status')).body; assert.equal(s.available, true);
      const so = (await off.client(H).get('/api/v1/phone/status')).body; assert.equal(so.available, false); assert.ok(so.reasons.includes('telephony_disabled')); assert.match(so.note, /OFF/);
      const r = await webhook(off.base, ORIGIN, '/api/v1/telephony/voice/inbound', { CallSid: csid(), From: CALLER, To: NUM }); assert.equal(r.status, 503);
      assert.equal((await off.client(H).post('/api/v1/phone/calls', { my_phone: MOBILE, to: STAFF })).status, 503);
      assert.equal((await off.client(H).get('/api/v1/phone/dialer-token')).status, 503);
      const p = await host().post('/api/v1/phone/numbers', { e164: '+12025550155' }); assert.equal(p.status, 201); assert.equal(p.body.status, 'pending');
      const act = await off.client(H).patch(`/api/v1/phone/numbers/${p.body.id}`, { status: 'active' }); assert.equal(act.status, 409); assert.equal(act.body.code, 'telephony_unavailable');
      assert.equal((await q(`SELECT count(*)::int n FROM portal.call_sessions WHERE provider_call_sid IS NULL`))[0].n, 0);
    });
    test('the compliance acknowledgement is required even when credentials are present', async () => {
      const partial = await startApp({ pool: db.pool, cfg: testConfig({ env: { TELEPHONY_ENABLED: 'true', TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_API_BASE: tw.url } }, main), jwks: main.jwks });
      try { const s = (await partial.client(H).get('/api/v1/phone/status')).body; assert.equal(s.available, false); assert.deepEqual(s.reasons, ['compliance_not_acknowledged']); } finally { await partial.close(); }
    });
  });

  describe('webhook security', () => {
    test('missing, wrong and replayed-to-another-url signatures are rejected and store nothing', async () => {
      const params = { CallSid: csid(), From: CALLER, To: NUM };
      assert.equal((await hook('inbound', params, { signature: null })).status, 403);
      assert.equal((await hook('inbound', params, { signature: 'bogus' })).status, 403);
      assert.equal((await hook('inbound', params, { token: 'another-token-another-token-12345' })).status, 403);
      const sigForMenu = signFor({ authToken: TOKEN, url: ORIGIN + '/api/v1/telephony/voice/menu', params });
      assert.equal((await hook('inbound', params, { signature: sigForMenu })).status, 403, 'a signature for one endpoint is useless on another');
      assert.equal((await q('SELECT count(*)::int n FROM portal.call_sessions WHERE provider_call_sid=$1', [params.CallSid]))[0].n, 0);
    });
    test('webhooks do not need cookies or CSRF - and API endpoints still do', async () => {
      assert.equal((await call(csid())).status, 200);
      assert.equal((await fetch(app.base + '/api/v1/phone/voicemails')).status, 401);
    });
    test('inbound call to an unknown or inactive number is declined without creating a session', async () => {
      const sid = csid(); const r = await hook('inbound', { CallSid: sid, From: CALLER, To: '+12025550999' }); assert.equal(r.status, 200); assert.match(r.text, /not in service/); assert.match(r.text, /<Hangup\/>/);
      assert.equal((await q('SELECT count(*)::int n FROM portal.call_sessions WHERE provider_call_sid=$1', [sid]))[0].n, 0);
    });
  });

  describe('inbound call flow', () => {
    test('open hours with a keypad menu: gather, then forward to the chosen destination; the whole call is recorded in the database', async () => {
      const set = await host().put(`/api/v1/receptionist/profiles/${profileId}/routes`, { routes: [
        { name: 'Sales', hours: 'open', digit: '1', action: 'forward', destination: STAFF }, { name: 'Support', hours: 'any', digit: '2', action: 'voicemail' }] });
      assert.equal(set.status, 200, JSON.stringify(set.body));
      const sid = csid(); const r = await call(sid); assert.equal(r.status, 200); assert.match(r.text, /<Gather/); assert.match(r.text, /Press 1 for Sales/); assert.match(r.text, /Press 2 for Support/);
      const m = await hook('menu', { CallSid: sid, From: CALLER, Digits: '1' }); assert.match(m.text, new RegExp(`<Dial[^>]*><Number>\\${STAFF}</Number>`)); assert.match(m.text, new RegExp(`callerId="\\${NUM}"`));
      const [row] = await q(`SELECT s.status, s.direction, s.from_e164, s.to_e164, rc.outcome, rc.digits, rc.hours_state FROM portal.call_sessions s JOIN portal.receptionist_calls rc ON rc.call_session_id=s.id WHERE s.provider_call_sid=$1`, [sid]);
      assert.deepEqual(row, { status: 'ringing', direction: 'inbound', from_e164: CALLER, to_e164: NUM, outcome: 'forwarded', digits: '1', hours_state: 'open' });
      const bad = await hook('menu', { CallSid: sid, From: CALLER, Digits: '7' }); assert.match(bad.text, /not a valid choice/);
    });
    test('provider retries of the same inbound webhook do not create a second call', async () => {
      const sid = csid(); await call(sid); await call(sid); await call(sid);
      assert.equal((await q('SELECT count(*)::int n FROM portal.call_sessions WHERE provider_call_sid=$1', [sid]))[0].n, 1);
      assert.equal((await q('SELECT count(*)::int n FROM portal.receptionist_calls rc JOIN portal.call_sessions s ON s.id=rc.call_session_id WHERE s.provider_call_sid=$1', [sid]))[0].n, 1);
    });
    test('closed (closure today): closed greeting, recording notice BEFORE the beep, voicemail stored once, no consent shortcut', async () => {
      await host().put(`/api/v1/receptionist/profiles/${profileId}/hours`, { windows: ALL_WEEK, closures: [{ on_date: today(), reason: 'Holiday' }] });
      const sid = csid(); const r = await call(sid); assert.match(r.text, /Our office is closed/); const iNotice = r.text.indexOf('will be recorded'), iRecord = r.text.indexOf('<Record');
      assert.ok(iNotice > 0 && iRecord > iNotice, 'the notice must be spoken before recording starts');
      assert.equal((await q('SELECT recording_basis FROM portal.call_sessions WHERE provider_call_sid=$1', [sid]))[0].recording_basis, 'notice_played');
      const recSid = rsid(); const body = { CallSid: sid, RecordingSid: recSid, RecordingUrl: tw.recordingUrl(recSid), RecordingStatus: 'completed', RecordingDuration: '12' };
      assert.equal((await hook('recording', body)).status, 204); assert.equal((await hook('recording', body)).status, 204);
      const vm = await q('SELECT from_e164, duration_seconds FROM portal.voicemails WHERE provider_recording_sid=$1', [recSid]); assert.equal(vm.length, 1); assert.equal(vm[0].from_e164, CALLER); assert.equal(vm[0].duration_seconds, 12);
    });
    test('a recording callback is ignored when no recording notice was played, and recording URLs outside the provider are refused', async () => {
      const sid = csid(); await call(sid);             // open hours, no routes -> default voicemail... force the "no notice" case directly
      await db.pool.query(`UPDATE portal.call_sessions SET recording_basis='none' WHERE provider_call_sid=$1`, [sid]);
      const recSid = rsid(); assert.equal((await hook('recording', { CallSid: sid, RecordingSid: recSid, RecordingUrl: tw.recordingUrl(recSid), RecordingStatus: 'completed' })).status, 204);
      assert.equal((await q('SELECT count(*)::int n FROM portal.voicemails WHERE provider_recording_sid=$1', [recSid]))[0].n, 0);
      await db.pool.query(`UPDATE portal.call_sessions SET recording_basis='notice_played' WHERE provider_call_sid=$1`, [sid]);
      const evil = rsid(); assert.equal((await hook('recording', { CallSid: sid, RecordingSid: evil, RecordingUrl: `https://evil.example/2010/${evil}`, RecordingStatus: 'completed' })).status, 400);
      assert.equal((await q('SELECT count(*)::int n FROM portal.voicemails WHERE provider_recording_sid=$1', [evil]))[0].n, 0);
    });
    test('nobody answers the forwarded call: the caller is sent to voicemail, never left in silence', async () => {
      await host().put(`/api/v1/receptionist/profiles/${profileId}/routes`, { routes: [{ name: 'Sales', hours: 'any', digit: null, action: 'forward', destination: STAFF }] });
      const sid = csid(); const r = await call(sid); assert.match(r.text, /<Dial/);
      const d = await hook('dial-result', { CallSid: sid, DialCallStatus: 'no-answer' }); assert.match(d.text, /<Record/); assert.match(d.text, /will be recorded/);
      assert.match((await hook('dial-result', { CallSid: sid, DialCallStatus: 'completed' })).text, /<Hangup\/>/);
    });
    test('escalation rings the escalation numbers and stays pending until a manager acknowledges it (once)', async () => {
      await host().put(`/api/v1/receptionist/profiles/${profileId}/routes`, { routes: [{ name: 'Urgent', hours: 'any', digit: '9', action: 'escalate' }] });
      const sid = csid(); await call(sid); const r = await hook('menu', { CallSid: sid, From: CALLER, Digits: '9' }); assert.match(r.text, /<Number>\+12025550111<\/Number>/);
      const list = (await host().get('/api/v1/receptionist/escalations')).body; const e = list.find((x) => x.from_e164 === CALLER && !x.escalation_acknowledged_at); assert.ok(e);
      assert.equal((await member().get('/api/v1/receptionist/escalations')).status, 403);
      assert.equal((await member().post(`/api/v1/receptionist/escalations/${e.id}/acknowledge`)).status, 403);
      assert.equal((await outsider().post(`/api/v1/receptionist/escalations/${e.id}/acknowledge`)).status, 409, 'another workspace cannot touch it');
      assert.equal((await admin().post(`/api/v1/receptionist/escalations/${e.id}/acknowledge`)).status, 200);
      assert.equal((await admin().post(`/api/v1/receptionist/escalations/${e.id}/acknowledge`)).status, 409);
    });
    test('when the plan has no minutes left forwarding is replaced by voicemail', async () => {
      await db.pool.query(`INSERT INTO portal.ai_usage_events(workspace_id,feature,units,idempotency_key) VALUES($1,'phone_minutes',1500,'test:exhaust')`, [W]);
      try {
        await host().put(`/api/v1/receptionist/profiles/${profileId}/routes`, { routes: [{ name: 'Sales', hours: 'any', digit: null, action: 'forward', destination: STAFF }] });
        const r = await call(csid()); assert.doesNotMatch(r.text, /<Dial/); assert.match(r.text, /<Record/);
      } finally { await db.pool.query(`DELETE FROM portal.ai_usage_events WHERE idempotency_key='test:exhaust'`).catch(() => {}); }
    });
  });

  describe('call status, metering and failure recovery', () => {
    test('status callbacks update the session, never regress a finished call, are idempotent, and meter minutes exactly once', async () => {
      const sid = csid(); await call(sid);
      const before = Number((await q(`SELECT COALESCE(sum(units),0) s FROM portal.ai_usage_events WHERE feature='phone_minutes'`))[0].s);
      assert.equal((await hook('status', { CallSid: sid, CallStatus: 'in-progress', SequenceNumber: '2' })).status, 204);
      const done = { CallSid: sid, CallStatus: 'completed', CallDuration: '125', SequenceNumber: '4' };
      assert.equal((await hook('status', done)).status, 204); assert.equal((await hook('status', done)).status, 204);
      assert.equal((await hook('status', { CallSid: sid, CallStatus: 'ringing', SequenceNumber: '1' })).status, 204, 'a late out-of-order event is accepted but ignored');
      const [s] = await q('SELECT status, duration_seconds, answered_at IS NOT NULL ans, ended_at IS NOT NULL ended FROM portal.call_sessions WHERE provider_call_sid=$1', [sid]); assert.deepEqual(s, { status: 'completed', duration_seconds: 125, ans: true, ended: true });
      const after = Number((await q(`SELECT COALESCE(sum(units),0) s FROM portal.ai_usage_events WHERE feature='phone_minutes'`))[0].s); assert.equal(after - before, 3, '125 s rounds up to 3 minutes, counted once');
    });
    test('failed and unanswered calls are recorded as such and cost nothing', async () => {
      const sid = csid(); await call(sid); const before = Number((await q(`SELECT COALESCE(sum(units),0) s FROM portal.ai_usage_events WHERE feature='phone_minutes'`))[0].s);
      await hook('status', { CallSid: sid, CallStatus: 'no-answer', CallDuration: '0', SequenceNumber: '3' });
      assert.equal((await q('SELECT status FROM portal.call_sessions WHERE provider_call_sid=$1', [sid]))[0].status, 'no_answer');
      assert.equal(Number((await q(`SELECT COALESCE(sum(units),0) s FROM portal.ai_usage_events WHERE feature='phone_minutes'`))[0].s), before);
    });
    test('status callbacks for calls we never tracked are acknowledged without side effects', async () => {
      assert.equal((await hook('status', { CallSid: csid(), CallStatus: 'completed', CallDuration: '60', SequenceNumber: '1' })).status, 204);
    });
  });

  describe('voicemails', () => {
    async function leaveVoicemail(text) {
      await host().put(`/api/v1/receptionist/profiles/${profileId}/hours`, { windows: ALL_WEEK, closures: [{ on_date: today() }] });
      const sid = csid(); await call(sid); const recSid = rsid();
      await hook('recording', { CallSid: sid, RecordingSid: recSid, RecordingUrl: tw.recordingUrl(recSid), RecordingStatus: 'completed', RecordingDuration: '20' });
      if (text) await hook('transcription', { RecordingSid: recSid, TranscriptionStatus: 'completed', TranscriptionText: text });
      return (await q('SELECT id FROM portal.voicemails WHERE provider_recording_sid=$1', [recSid]))[0].id;
    }
    test('transcript arrives, a leased job summarises it once, usage is counted once, and the summary is shown', async () => {
      const id = await leaveVoicemail('Hi this is Dana, please call me back about the invoice, it is urgent.');
      assert.equal((await q('SELECT summary_status FROM portal.voicemails WHERE id=$1', [id]))[0].summary_status, 'queued');
      assert.equal(await app.ai.phoneWorker.runOne(), true); assert.equal(await app.ai.phoneWorker.runOne(), false);
      const [v] = await q('SELECT ai_summary, summary_status FROM portal.voicemails WHERE id=$1', [id]); assert.equal(v.summary_status, 'done'); assert.match(v.ai_summary, /TEST-DOUBLE VOICEMAIL SUMMARY/); assert.match(v.ai_summary, /\[urgent\]/); assert.match(v.ai_summary, /\[callback requested\]/);
      assert.equal((await q(`SELECT count(*)::int n FROM portal.ai_usage_events WHERE idempotency_key=$1`, [`voicemail:${id}:summary`]))[0].n, 1);
    });
    test('a duplicate transcription callback does not queue a second summary', async () => {
      const id = await leaveVoicemail('Please call back.'); const rs = (await q('SELECT provider_recording_sid s FROM portal.voicemails WHERE id=$1', [id]))[0].s;
      await hook('transcription', { RecordingSid: rs, TranscriptionStatus: 'completed', TranscriptionText: 'Please call back.' });
      assert.equal((await q('SELECT count(*)::int n FROM portal.phone_ai_jobs WHERE voicemail_id=$1', [id]))[0].n, 1);
    });
    test('model outage retries with backoff; permanent rejection fails the job and marks the voicemail', async () => {
      const id = await leaveVoicemail('Retry me please.');
      await fetch(llmd.url + '/__control/set', { method: 'POST', body: JSON.stringify({ failTimes: 1 }) });
      assert.equal(await app.ai.phoneWorker.runOne(), true); assert.equal((await q('SELECT status, attempts FROM portal.phone_ai_jobs WHERE voicemail_id=$1', [id]))[0].status, 'queued');
      assert.equal(await app.ai.phoneWorker.runOne(), true); assert.equal((await q('SELECT summary_status FROM portal.voicemails WHERE id=$1', [id]))[0].summary_status, 'done');
      const id2 = await leaveVoicemail('This will be rejected.'); await fetch(llmd.url + '/__control/set', { method: 'POST', body: JSON.stringify({ mode: 'reject' }) });
      await app.ai.phoneWorker.runOne(); assert.equal((await q('SELECT summary_status FROM portal.voicemails WHERE id=$1', [id2]))[0].summary_status, 'failed');
    });
    test('without an AI provider the voicemail is kept and the summary is explicitly blocked (nothing invented)', async () => {
      const id = await leaveVoicemail(null); const rs = (await q('SELECT provider_recording_sid s FROM portal.voicemails WHERE id=$1', [id]))[0].s;
      const noAi = await startApp({ pool: db.pool, cfg: testConfig({ env: { TELEPHONY_ENABLED: 'true', TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_API_BASE: tw.url, TELEPHONY_COMPLIANCE_ACK: ACK } }, main), jwks: main.jwks });
      try { await webhook(noAi.base, ORIGIN, '/api/v1/telephony/voice/transcription', { RecordingSid: rs, TranscriptionStatus: 'completed', TranscriptionText: 'hello' }); } finally { await noAi.close(); }
      const [v] = await q('SELECT summary_status, ai_summary, transcript FROM portal.voicemails WHERE id=$1', [id]); assert.equal(v.summary_status, 'blocked'); assert.equal(v.ai_summary, null); assert.equal(v.transcript, 'hello');
    });
    test('only owners and admins can list, play and delete voicemails; audio is proxied with our credentials; other workspaces see nothing', async () => {
      const id = await leaveVoicemail('Secret message.');
      assert.equal((await member().get('/api/v1/phone/voicemails')).status, 403); 
      assert.ok((await admin().get('/api/v1/phone/voicemails')).body.some((v) => v.id === id));
      const oList = await outsider().get('/api/v1/phone/voicemails'); assert.equal(oList.status, 200); assert.ok(!oList.body.some((v) => v.id === id), 'owner of another workspace sees none of ours');
      assert.equal((await outsider().get(`/api/v1/phone/voicemails/${id}/audio`)).status, 404); assert.equal((await outsider().del(`/api/v1/phone/voicemails/${id}`)).status, 404);
      const au = await admin().get(`/api/v1/phone/voicemails/${id}/audio`); assert.equal(au.status, 200); assert.equal(au.headers.get('content-type'), 'audio/mpeg'); assert.match(au.headers.get('cache-control'), /no-store/);
      assert.ok(tw.st.recordingRequests.at(-1).authed, 'the provider is called with our credentials, never the browser');
      assert.ok((await q('SELECT listened_at FROM portal.voicemails WHERE id=$1', [id]))[0].listened_at);
    });
    test('deleting a voicemail removes the transcript and summary and hides it', async () => {
      const id = await leaveVoicemail('Delete me.'); assert.equal((await member().del(`/api/v1/phone/voicemails/${id}`)).status, 403);
      assert.equal((await admin().del(`/api/v1/phone/voicemails/${id}`)).status, 204);
      const [v] = await q('SELECT transcript, ai_summary, recording_url, deleted_at IS NOT NULL del FROM portal.voicemails WHERE id=$1', [id]); assert.deepEqual(v, { transcript: null, ai_summary: null, recording_url: 'deleted', del: true });
      assert.ok(!(await admin().get('/api/v1/phone/voicemails')).body.some((x) => x.id === id)); assert.equal((await admin().get(`/api/v1/phone/voicemails/${id}/audio`)).status, 404);
    });
    test('a provider outage while fetching audio is a clean 502, not a crash', async () => {
      const id = await leaveVoicemail('x');
      await db.pool.query(`UPDATE portal.voicemails SET recording_url=$2 WHERE id=$1`, [id, tw.url + '/2010-04-01/Accounts/' + SID + '/Recordings/REmissing']);
      const r = await admin().get(`/api/v1/phone/voicemails/${id}/audio`); assert.equal(r.status, 502);
    });
  });

  describe('numbers, profiles and configuration', () => {
    test('only owners/admins configure; members are refused; hours are required before enabling; invalid input is rejected', async () => {
      assert.equal((await member().post('/api/v1/receptionist/profiles', { name: 'x' })).status, 403);
      assert.equal((await member().get('/api/v1/phone/numbers')).status, 403);
      const p = (await admin().post('/api/v1/receptionist/profiles', { name: 'Second', timezone: 'Europe/Paris' })).body;
      const early = await admin().patch(`/api/v1/receptionist/profiles/${p.id}`, { enabled: true }); assert.equal(early.status, 409); assert.equal(early.body.code, 'hours_required');
      assert.equal((await admin().post('/api/v1/receptionist/profiles', { name: 'Bad tz', timezone: 'Mars/Base' })).status, 400);
      assert.equal((await admin().post('/api/v1/receptionist/profiles', { name: 'Second' })).status, 409);
      assert.equal((await admin().put(`/api/v1/receptionist/profiles/${p.id}/hours`, { windows: [{ weekday: 1, opens: '10:00', closes: '09:00' }] })).status, 400);
      assert.equal((await admin().put(`/api/v1/receptionist/profiles/${p.id}/hours`, { windows: [{ weekday: 1, opens: '09:00', closes: '12:00' }, { weekday: 1, opens: '11:00', closes: '13:00' }] })).status, 400);
      assert.equal((await admin().put(`/api/v1/receptionist/profiles/${p.id}/routes`, { routes: [{ name: 'a', digit: '1', action: 'forward' }] })).status, 400, 'forward needs a destination');
      assert.equal((await admin().put(`/api/v1/receptionist/profiles/${p.id}/routes`, { routes: [{ name: 'a', digit: '1', action: 'voicemail' }, { name: 'b', digit: '1', action: 'hangup' }] })).status, 400, 'duplicate key');
      assert.equal((await admin().patch(`/api/v1/receptionist/profiles/${p.id}`, { recording_notice: 'short' })).status, 400, 'recording notice cannot be blanked out');
      assert.equal((await outsider().patch(`/api/v1/receptionist/profiles/${p.id}`, { name: 'hijack' })).status, 404);
      assert.equal((await outsider().put(`/api/v1/receptionist/profiles/${profileId}/routes`, { routes: [] })).status, 404);
    });
    test('phone numbers are unique across workspaces, validated, plan-limited, and cannot point at another workspace profile', async () => {
      assert.equal((await outsider().post('/api/v1/phone/numbers', { e164: NUM })).status, 409);
      assert.equal((await host().post('/api/v1/phone/numbers', { e164: '12025550123' })).status, 400);
      const other = (await outsider().post('/api/v1/receptionist/profiles', { name: 'Theirs' })).body;
      assert.equal((await host().post('/api/v1/phone/numbers', { e164: '+12025550124', profile_id: other.id })).status, 400);
      const free = await outsider().post('/api/v1/phone/numbers', { e164: '+12025550125' }); assert.equal(free.status, 201);
      const extra = await outsider().post('/api/v1/phone/numbers', { e164: '+12025550126' }); assert.equal(extra.status, 402, JSON.stringify(extra.body)); assert.equal(extra.body.code, 'plan_limit');
    });
  });

  describe('outbound calling', () => {
    test('click-to-call rings the user first and bridges to the destination; the call is recorded as outbound by that user', async () => {
      const r = await host().post('/api/v1/phone/calls', { my_phone: MOBILE, to: STAFF }); assert.equal(r.status, 202, JSON.stringify(r.body));
      const sent = tw.st.calls.at(-1); assert.equal(sent.To, MOBILE); assert.equal(sent.From, NUM); assert.equal(sent.Url, `${ORIGIN}/api/v1/telephony/voice/bridge?to=${encodeURIComponent(STAFF)}`); assert.equal(sent.StatusCallback, `${ORIGIN}/api/v1/telephony/voice/status`);
      const [s] = await q('SELECT direction, to_e164, from_e164, initiated_by, status FROM portal.call_sessions WHERE id=$1', [r.body.id]); assert.deepEqual(s, { direction: 'outbound', to_e164: STAFF, from_e164: NUM, initiated_by: H.sub, status: 'initiated' });
      const sid = (await q('SELECT provider_call_sid s FROM portal.call_sessions WHERE id=$1', [r.body.id]))[0].s;
      const bridge = await webhook(app.base, ORIGIN, `/api/v1/telephony/voice/bridge?to=${encodeURIComponent(STAFF)}`, { CallSid: sid }); assert.match(bridge.text, new RegExp(`<Number>\\${STAFF}</Number>`));
      const tampered = await webhook(app.base, ORIGIN, `/api/v1/telephony/voice/bridge?to=${encodeURIComponent('+12025550666')}`, { CallSid: sid }); assert.match(tampered.text, /cannot be completed/);
    });
    test('destination policy and provider errors are enforced and surfaced honestly', async () => {
      assert.equal((await host().post('/api/v1/phone/calls', { my_phone: MOBILE, to: '+19005550100' })).status, 400);
      assert.equal((await host().post('/api/v1/phone/calls', { my_phone: MOBILE, to: '+442071234567' })).body.code, 'international_disabled');
      assert.equal((await host().post('/api/v1/phone/calls', { my_phone: 'nope', to: STAFF })).status, 400);
      const before = (await q(`SELECT count(*)::int n FROM portal.call_sessions WHERE direction='outbound'`))[0].n;
      tw.st.failCalls = true; const r = await host().post('/api/v1/phone/calls', { my_phone: MOBILE, to: STAFF }); assert.equal(r.status, 502); assert.equal(r.body.code, 'provider_error');
      assert.equal((await q(`SELECT count(*)::int n FROM portal.call_sessions WHERE direction='outbound'`))[0].n, before, 'no ghost call row for a call the provider refused');
    });
    test('a workspace with no active number cannot dial; plan minutes exhausted blocks new outbound calls', async () => {
      assert.equal((await outsider().post('/api/v1/phone/calls', { my_phone: MOBILE, to: STAFF })).status, 409);
      await db.pool.query(`INSERT INTO portal.ai_usage_events(workspace_id,feature,units,idempotency_key) VALUES($1,'phone_minutes',1500,'test:out')`, [W]);
      try { assert.equal((await host().post('/api/v1/phone/calls', { my_phone: MOBILE, to: STAFF })).status, 402); } finally { await db.pool.query(`DELETE FROM portal.ai_usage_events WHERE idempotency_key='test:out'`); }
    });
    test('browser dialer: token only for members of a workspace with an active number; the TwiML app only dials for real members', async () => {
      const t = await host().get('/api/v1/phone/dialer-token'); assert.equal(t.status, 200); assert.equal(t.body.token.split('.').length, 3);
      assert.equal((await outsider().get('/api/v1/phone/dialer-token')).status, 409, 'other workspace has no active number');
      assert.equal((await app.client(null).get('/api/v1/phone/dialer-token')).status, 401);
      const ok = await voice('outbound', { From: `client:${W}_${H.sub}`, To: STAFF }); assert.match(ok.text, new RegExp(`<Number>\\${STAFF}</Number>`));
      const notMember = await voice('outbound', { From: `client:${W}_${O.sub}`, To: STAFF }); assert.match(notMember.text, /not allowed/); assert.doesNotMatch(notMember.text, /<Dial/);
      const premium = await voice('outbound', { From: `client:${W}_${H.sub}`, To: '+19005550100' }); assert.doesNotMatch(premium.text, /<Dial/);
      assert.doesNotMatch((await voice('outbound', { From: 'client:garbage', To: STAFF })).text, /<Dial/);
    });
  });

  describe('appointments', () => {
    const slot = (h = 10, m = 0) => `${tomorrow()}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
    const book = (cl, extra = {}) => cl.post('/api/v1/appointments', { profile_id: profileId, title: 'Consult', starts_at: slot(), duration: 30, attendee_name: 'Dana', attendee_phone: CALLER, idempotency_key: 'idem-' + crypto.randomBytes(5).toString('hex'), ...extra });
    test('free slots come from the business hours; booking removes the slot; a double booking is refused; the same key is idempotent', async () => {
      const s0 = (await member().get(`/api/v1/appointments/slots?profile_id=${profileId}&date=${tomorrow()}&duration=30`)).body; assert.equal(s0.timezone, 'UTC'); assert.ok(s0.slots.includes(slot()));
      const key = 'idem-fixed-key-1'; const b1 = await book(member(), { idempotency_key: key }); assert.equal(b1.status, 201, JSON.stringify(b1.body));
      const again = await book(member(), { idempotency_key: key }); assert.equal(again.status, 200); assert.equal(again.body.id, b1.body.id);
      const clash = await book(admin(), { starts_at: slot(10, 15) }); assert.equal(clash.status, 409); assert.equal(clash.body.code, 'slot_taken');
      assert.ok(!(await member().get(`/api/v1/appointments/slots?profile_id=${profileId}&date=${tomorrow()}`)).body.slots.includes(slot()));
      assert.equal((await book(admin(), { starts_at: slot(11) })).status, 201);
    });
    test('two simultaneous bookings for one slot: exactly one wins', async () => {
      const results = await Promise.all([1, 2, 3, 4].map((i) => book(i % 2 ? member() : admin(), { starts_at: slot(14) })));
      assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status))); assert.equal(results.filter((r) => r.status === 409).length, 3);
    });
    test('outside business hours, in the past, closures and other workspaces are refused', async () => {
      await host().put(`/api/v1/receptionist/profiles/${profileId}/hours`, { windows: [{ weekday: (new Date(`${tomorrow()}T12:00:00Z`).getUTCDay() + 1) % 7, opens: '09:00', closes: '10:00' }], closures: [] });
      const r = await book(member(), { starts_at: slot(15) }); assert.equal(r.status, 409); assert.equal(r.body.code, 'outside_hours');
      await host().put(`/api/v1/receptionist/profiles/${profileId}/hours`, { windows: ALL_WEEK, closures: [{ on_date: tomorrow() }] }); assert.equal((await book(member(), { starts_at: slot(16) })).status, 409);
      await host().put(`/api/v1/receptionist/profiles/${profileId}/hours`, { windows: ALL_WEEK, closures: [] });
      assert.equal((await book(member(), { starts_at: '2020-01-01T10:00:00.000Z' })).status, 400);
      assert.equal((await book(outsider())).status, 404); assert.equal((await outsider().get(`/api/v1/appointments/slots?profile_id=${profileId}&date=${tomorrow()}`)).status, 404);
    });
    test('cancel: the booker or a manager only; the slot becomes free again', async () => {
      const b = await book(member(), { starts_at: slot(18) }); assert.equal(b.status, 201);
      assert.equal((await outsider().post(`/api/v1/appointments/${b.body.id}/cancel`)).status, 404);
      const other = await book(admin(), { starts_at: slot(19) }); assert.equal((await member().post(`/api/v1/appointments/${other.body.id}/cancel`)).status, 403);
      assert.equal((await member().post(`/api/v1/appointments/${b.body.id}/cancel`)).status, 200);
      assert.ok((await member().get(`/api/v1/appointments/slots?profile_id=${profileId}&date=${tomorrow()}`)).body.slots.includes(slot(18)));
      assert.equal((await host().post(`/api/v1/appointments/${other.body.id}/cancel`)).status, 200);
    });
  });

  describe('history and analytics', () => {
    test('call history is manager-wide, personal for members, and analytics aggregate the real rows only', async () => {
      const all = (await host().get('/api/v1/phone/calls')).body; assert.ok(all.length > 3);
      const mine = (await member().get('/api/v1/phone/calls')).body; assert.ok(mine.every((c) => c.initiated_by === M.sub)); assert.ok(mine.length < all.length);
      assert.equal((await member().get('/api/v1/phone/analytics')).status, 403);
      const a = (await admin().get('/api/v1/phone/analytics?days=30')).body; const inbound = a.by_direction.find((d) => d.direction === 'inbound');
      assert.equal(inbound.calls, (await q(`SELECT count(*)::int n FROM portal.call_sessions WHERE workspace_id=$1 AND direction='inbound'`, [W]))[0].n);
      assert.equal(a.minutes.limit, 1500); assert.equal(a.minutes.plan, 'pro'); assert.ok(a.minutes.used_this_month >= 3);
      const empty = (await outsider().get('/api/v1/phone/analytics')).body; assert.deepEqual(empty.by_direction, []); assert.equal(empty.voicemails.n, 0);
    });
  });
});
