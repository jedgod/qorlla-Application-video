import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createPhoneJoinRouter } from '../src/server.js';
import { UNAVAILABLE_MESSAGE, type Readiness, type MeetingAuthority, type SipRtpBridge } from '../src/admission.js';

const all: Readiness = { carrierConnected: true, inboundNumberCertified: true, gatewayHealthy: true, mediaBridgeCertified: true, billingCertified: true, productionApproved: true };
const body = { meetingId: 'ABC12345', passcode: '123456', callId: 'call_12345678', dialedNumber: '+12025550100' };
const allow: express.RequestHandler = (_q, _r, next) => next();
const deny = (code: string): express.RequestHandler => (_q, r) => { r.status(401).json({ code }); };

async function serve(over: Partial<Parameters<typeof createPhoneJoinRouter>[0]> = {}, calls: string[] = []) {
  const authority: MeetingAuthority = { verifyPhoneJoin: async () => { calls.push('verify'); return { allowed: true, requiresHostApproval: false, meetingSessionId: 's1' }; }, requestHostApproval: async () => true };
  const bridge: SipRtpBridge = { attach: async () => { calls.push('attach'); return { mediaEstablished: true }; }, disconnect: async () => { calls.push('disconnect'); } };
  const app = express(); app.use('/api/v1/phone-join', createPhoneJoinRouter({ readiness: async () => all, authority, bridge, authenticateGateway: allow, rateLimit: allow, verifyWebhook: allow, ...over }));
  const server = http.createServer(app); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/v1/phone-join';
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}
const post = (base: string, data: unknown) => fetch(base + '/inbound/admit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

test('capabilities: unauthenticated callers are refused; authenticated ones see availability, never cached', async () => {
  const s = await serve({ authenticateGateway: deny('AUTH_REQUIRED') }); assert.equal((await fetch(s.base + '/capabilities')).status, 401); await s.close();
  const on = await serve(); const r = await fetch(on.base + '/capabilities'); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal((await r.json() as any).telephoneJoin, true); await on.close();
  const off = await serve({ readiness: async () => ({ ...all, carrierConnected: false }) }); const j = await (await fetch(off.base + '/capabilities')).json() as any; assert.equal(j.telephoneJoin, false); assert.equal(j.message, UNAVAILABLE_MESSAGE); await off.close();
});
test('capabilities: a readiness check that fails reports unavailable (503), not available', async () => {
  const s = await serve({ readiness: async () => { throw new Error('backend down'); } }); const r = await fetch(s.base + '/capabilities'); assert.equal(r.status, 503); assert.equal((await r.json() as any).telephoneJoin, false); await s.close();
});
test('capabilities: an incomplete readiness answer is unavailable', async () => {
  const s = await serve({ readiness: async () => ({}) as any }); assert.equal(((await (await fetch(s.base + '/capabilities')).json()) as any).telephoneJoin, false); await s.close();
});
test('admission: a request without a verified gateway is refused before anything runs', async () => {
  const calls: string[] = []; const s = await serve({ verifyWebhook: deny('SIGNED_WEBHOOK_REQUIRED') }, calls);
  assert.equal((await post(s.base, body)).status, 401); assert.deepEqual(calls, []); await s.close();
});
test('admission: unknown fields and wrong types are rejected as invalid', async () => {
  const calls: string[] = []; const s = await serve({}, calls);
  for (const bad of [{ ...body, extra: 1 }, { ...body, passcode: 123456 }, { meetingId: 'ABC12345' }, [], null, 'x']) assert.equal((await post(s.base, bad)).status, 400, JSON.stringify(bad));
  assert.deepEqual(calls, []); await s.close();
});
test('admission: malformed or oversized bodies get a JSON refusal (no stack trace, no HTML)', async () => {
  const calls: string[] = []; const s = await serve({}, calls);
  for (const raw of ['{not json', 'null', '"x"', JSON.stringify({ ...body, passcode: 'x'.repeat(9000) })]) {
    const r = await fetch(s.base + '/inbound/admit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    assert.ok([400, 413].includes(r.status), raw.slice(0, 20) + ' -> ' + r.status); assert.match(r.headers.get('content-type') || '', /json/); assert.equal(((await r.json()) as any).code, 'INVALID_REQUEST');
  }
  assert.deepEqual(calls, []); await s.close();
});
test('admission: while telephony is not ready every request is answered 503 with the unavailable announcement, and nothing is asked or attached', async () => {
  const calls: string[] = [];
  for (const readiness of [async () => ({ ...all, productionApproved: false }), async () => ({}) as any, async () => { throw new Error('down'); }]) {
    const s = await serve({ readiness }, calls); const r = await post(s.base, body); const j = await r.json() as any;
    assert.equal(r.status, 503); assert.equal(j.code, 'PHONE_JOIN_UNAVAILABLE'); assert.equal(j.announcement, UNAVAILABLE_MESSAGE); await s.close();
  }
  assert.deepEqual(calls, []);
});
test('admission: a ready, authorized call is connected through the bridge, with no-store', async () => {
  const calls: string[] = []; const s = await serve({}, calls); const r = await post(s.base, body);
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(((await r.json()) as any).code, 'MEDIA_CONNECTED'); assert.deepEqual(calls, ['verify', 'attach']); await s.close();
});
test('admission: ledger and timeouts passed to the router are honoured', async () => {
  const held = new Set<string>(); const ledger = { claim: async (id: string) => (held.has(id) ? false : (held.add(id), true)), release: async (id: string) => { held.delete(id); } };
  const s = await serve({ admission: { ledger } }); assert.equal((await post(s.base, body)).status, 200); assert.equal((await post(s.base, body)).status, 409); await s.close();
});
