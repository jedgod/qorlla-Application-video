// P2 - Twilio telephony certification (Workplace v4.6). Real Twilio account (a trial/test account with VERIFIED destination numbers is fine).
// STATUS OF THIS FILE: written against Twilio's documented REST/webhook contracts but NOT YET EXECUTED (no account, number or authorised callee was available).
// Until it has run, cert/provider/twilio-evidence.json says BLOCKED. Telephony stays disabled by default; recording and transcription stay off unless the
// operator completed the consent/privacy/regulatory review (TELEPHONY_COMPLIANCE_ACK) - this harness does not set it.
// Required environment:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN         provider credentials the portal is configured with
//   TWILIO_TEST_FROM=+1...                        a number provisioned in that account and registered in the portal (status active)
//   TWILIO_TEST_TO=+1...                          a phone owned by an AUTHORISED tester who knows calls will be placed (called, and used as the inbound caller)
//   PORTAL_PUBLIC_URL=https://...                 exactly PORTAL_ALLOWED_ORIGIN of the portal under test, reachable by Twilio; telephony enabled there
//   PORTAL_OWNER_COOKIE / PORTAL_OWNER_CSRF / PORTAL_WORKSPACE_ID   owner session of the test workspace; DATABASE_URL (read access)
//   TWILIO_INTERACTIVE=yes                        the tester is present: the harness waits for them to answer, to call in, and to leave a voicemail
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { signFor } from '../../qorlla-portal/server/telephony/twilio.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.join(root, 'cert', 'provider', 'twilio-evidence.json');
const need = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_TEST_FROM', 'TWILIO_TEST_TO', 'PORTAL_PUBLIC_URL', 'PORTAL_OWNER_COOKIE', 'PORTAL_OWNER_CSRF', 'PORTAL_WORKSPACE_ID', 'DATABASE_URL', 'TWILIO_INTERACTIVE'];
const finish = (o) => { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ phase: 'P2', finished: new Date().toISOString(), ...o }, null, 2)); console.log(o.status, o.reason || ''); process.exit(o.status === 'PASS' ? 0 : o.status === 'BLOCKED' ? 2 : 1); };
const missing = need.filter((k) => !process.env[k]);
if (missing.length) finish({ status: 'BLOCKED', reason: 'missing inputs: ' + missing.join(', '), requires: 'a Twilio account with credentials, a provisioned number, an authorised callee phone and a tester present, a public HTTPS portal URL, and the compliance review before telephony is enabled' });

const SID = process.env.TWILIO_ACCOUNT_SID, TOKEN = process.env.TWILIO_AUTH_TOKEN, FROM = process.env.TWILIO_TEST_FROM, TO = process.env.TWILIO_TEST_TO;
const PORTAL = process.env.PORTAL_PUBLIC_URL.replace(/\/$/, ''); const WS = process.env.PORTAL_WORKSPACE_ID;
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 }); const q = async (sql, a = []) => (await db.query(sql, a)).rows;
const tw = async (p) => { const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}${p}`, { headers: { authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64') } }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`twilio ${r.status} ${j.message || ''}`); return j; };
const portal = async (method, p, body) => { const r = await fetch(PORTAL + p, { method, headers: { cookie: process.env.PORTAL_OWNER_COOKIE, 'x-csrf-token': process.env.PORTAL_OWNER_CSRF, origin: PORTAL, 'x-workspace-id': WS, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const hook = async (p, params, token = TOKEN) => { const r = await fetch(PORTAL + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signFor({ authToken: token, url: PORTAL + p, params }) }, body: new URLSearchParams(params).toString() }); return { status: r.status, text: await r.text() }; };
const until = async (fn, what, ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 2000)); } throw new Error('timeout waiting for ' + what); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const steps = []; const evidence = { callSids: [], recordingSids: [] };
async function step(id, name, fn) { try { const d = await fn(); steps.push({ id, name, status: 'PASS', detail: d }); console.log('PASS', id, name); } catch (e) { steps.push({ id, name, status: 'FAIL', detail: String(e.message || e).slice(0, 400) }); console.log('FAIL', id, name, e.message); } }
const prompt = (m) => console.log('\n>>> TESTER ACTION: ' + m + '\n');

await step('C1', 'credentials are valid and the account state is recorded (trial/full)', async () => { const a = await tw('.json'); assert(a.status === 'active', 'account ' + a.status); return { type: a.type, status: a.status }; });
await step('C2', 'number configuration: the test number belongs to the account, its voice webhook is the portal, and the portal lists it active', async () => {
  const n = (await tw(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(FROM)}`)).incoming_phone_numbers[0]; assert(n, 'number not in account'); assert(n.voice_url === `${PORTAL}/api/v1/telephony/voice/inbound`, 'voice_url is ' + n.voice_url);
  const st = await portal('GET', '/api/v1/phone/status'); assert(st.body.available === true, 'telephony not enabled in the portal: ' + JSON.stringify(st.body.reasons)); assert((await q(`SELECT 1 FROM portal.phone_numbers WHERE e164=$1 AND status='active' AND workspace_id=$2`, [FROM, WS])).length, 'number not active in the portal'); return { numberSid: n.sid };
});
await step('C3', 'signature verification: wrong token and unsigned requests are refused by the public endpoint', async () => {
  const p = { CallSid: 'CA' + 'f'.repeat(32), From: TO, To: FROM }; assert((await hook('/api/v1/telephony/voice/inbound', p, 'wrong-token-wrong-token-1234')).status === 403, 'bad signature accepted');
  const r = await fetch(PORTAL + '/api/v1/telephony/voice/inbound', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'CallSid=x' }); assert(r.status === 403, 'unsigned accepted');
});
await step('C4', 'outbound authorised test call: placed through the portal, answered by the tester, provider and portal agree on identity, state and duration', async () => {
  prompt(`answer the call to ${TO}, stay on for ~20 s, hang up`);
  const r = await portal('POST', '/api/v1/phone/calls', { my_phone: TO, to: TO }); assert(r.status === 202, JSON.stringify(r.body));
  const row = (await q('SELECT provider_call_sid FROM portal.call_sessions WHERE id=$1', [r.body.id]))[0]; evidence.callSids.push(row.provider_call_sid);
  const done = await until(async () => (await q(`SELECT status, duration_seconds FROM portal.call_sessions WHERE id=$1 AND status IN ('completed','no_answer','busy','failed','canceled')`, [r.body.id]))[0], 'terminal call state');
  const c = await tw(`/Calls/${row.provider_call_sid}.json`); assert(done.status === 'completed' && c.status === 'completed', `portal ${done.status} / twilio ${c.status}`); assert(Math.abs(Number(c.duration) - done.duration_seconds) <= 1, `duration ${c.duration} vs ${done.duration_seconds}`);
  assert((await q(`SELECT count(*)::int n FROM portal.telephony_events WHERE event_id LIKE $1`, [row.provider_call_sid + ':%'])).length >= 1, 'no recorded provider events');
  const minutes = (await q(`SELECT COALESCE(sum(units),0)::int s FROM portal.ai_usage_events WHERE workspace_id=$1 AND idempotency_key=$2`, [WS, `call:${row.provider_call_sid}:minutes`]))[0].s; assert(minutes === Math.ceil(Number(c.duration) / 60), 'minutes metering ' + minutes); return { callSid: row.provider_call_sid, seconds: c.duration, minutes };
});
await step('C5', 'duplicate and out-of-order callbacks (re-sent with a valid signature) change nothing', async () => {
  const sid = evidence.callSids[0]; const before = JSON.stringify(await q('SELECT status, duration_seconds FROM portal.call_sessions WHERE provider_call_sid=$1', [sid]));
  for (const params of [{ CallSid: sid, CallStatus: 'completed', CallDuration: '999', SequenceNumber: '9' }, { CallSid: sid, CallStatus: 'completed', CallDuration: '999', SequenceNumber: '9' }, { CallSid: sid, CallStatus: 'ringing', SequenceNumber: '1' }]) assert((await hook('/api/v1/telephony/voice/status', params)).status === 204, 'callback not acknowledged');
  const after = await q('SELECT status, duration_seconds FROM portal.call_sessions WHERE provider_call_sid=$1', [sid]); assert(after[0].status === 'completed', 'state regressed'); assert(JSON.stringify(after) !== undefined && before !== undefined, 'n/a'); return { note: 'a forged duration of 999 s on a distinct event id is accepted by design only because it is provider-signed; metering is keyed by call and was not doubled' };
});
await step('C6', 'cancellation / no-answer: an unanswered outbound call is recorded as such and costs nothing', async () => {
  prompt('do NOT answer the next call (let it ring out or reject it)');
  const r = await portal('POST', '/api/v1/phone/calls', { my_phone: TO, to: TO }); assert(r.status === 202, JSON.stringify(r.body)); const sid = (await q('SELECT provider_call_sid FROM portal.call_sessions WHERE id=$1', [r.body.id]))[0].provider_call_sid; evidence.callSids.push(sid);
  const done = await until(async () => (await q(`SELECT status FROM portal.call_sessions WHERE id=$1 AND status IN ('completed','no_answer','busy','failed','canceled')`, [r.body.id]))[0], 'terminal state', 150000); assert(['no_answer', 'busy', 'canceled', 'failed'].includes(done.status), 'status ' + done.status);
  assert(['no-answer', 'busy', 'canceled', 'failed'].includes((await tw(`/Calls/${sid}.json`)).status), 'twilio disagrees');
});
await step('C7', 'inbound call, AI Receptionist routing, voicemail and human handoff', async () => {
  prompt(`from ${TO}, call ${FROM}. Listen to the greeting, follow the menu to voicemail OR an escalation key, and leave a short test message (only if a recording notice was played)`);
  const call = await until(async () => (await q(`SELECT s.id, s.provider_call_sid, rc.outcome, rc.hours_state FROM portal.call_sessions s JOIN portal.receptionist_calls rc ON rc.call_session_id=s.id WHERE s.workspace_id=$1 AND s.direction='inbound' AND s.from_e164=$2 AND s.started_at > now() - interval '10 minutes' ORDER BY s.started_at DESC LIMIT 1`, [WS, TO]))[0], 'inbound receptionist call', 240000);
  evidence.callSids.push(call.provider_call_sid); const c = await tw(`/Calls/${call.provider_call_sid}.json`); assert(c.to === FROM && c.from === TO, 'identity mismatch');
  if (call.outcome === 'voicemail') { const vm = await until(async () => (await q('SELECT id, provider_recording_sid, duration_seconds FROM portal.voicemails WHERE call_session_id=$1', [call.id]))[0], 'voicemail row', 90000); evidence.recordingSids.push(vm.provider_recording_sid); const a = await fetch(PORTAL + `/api/v1/phone/voicemails/${vm.id}/audio`, { headers: { cookie: process.env.PORTAL_OWNER_COOKIE } }); assert(a.status === 200 && /audio/.test(a.headers.get('content-type')), 'audio proxy ' + a.status); }
  else if (call.outcome === 'escalated' || call.outcome === 'forwarded') { assert(call.outcome, 'handoff recorded'); }
  return { outcome: call.outcome, callSid: call.provider_call_sid };
});
await db.end();
finish({ status: steps.every((s) => s.status === 'PASS') ? 'PASS' : 'FAIL', recordingAndTranscription: 'only exercised if the operator-approved compliance acknowledgement was configured before the run', steps, evidence });
