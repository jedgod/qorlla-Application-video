import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { MeetPhoneAuthority } from '../src/meet-authority.js';
import { meetSignaling, verificationPeerSignaling } from '../src/media/meet-signaling.js';
import { SipMediaGateway } from '../src/media/sip-media-gateway.js';
import { meetConfirmedBridge } from '../src/meet-media.js';
import type { AudioEvidence } from '../src/media-contract.js';
import { eventually } from './support.js';

/**
 * The gateway side of A5: asking Meet for the restricted verification credential, connecting with it as a `verification-peer`, and sending the credential's id with the media report so Meet can tie the evidence to the
 * signalling session it observed. The Meet side (issuing, consuming, restricting, promoting, revoking) is tested against the real Meet server in the Meet branch (tests/phone-peer.pg.test.mjs).
 */
const jwt = (payload: object) => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');
const CRED = jwt({ iss: 'qorlla-meet', aud: 'qorlla-meet-verification-peer', scope: 'meet:telephone:verify-media', call: 'c1', mid: 'm1', pid: 'p-phone', jti: 'j'.repeat(40) });
const live: (() => Promise<void> | void)[] = []; test.afterEach(async () => { for (const l of live.splice(0).reverse()) await l(); });

function fakeMeetHttp(handler: (path: string, body: any) => { status: number; body: object }) {
  const seen: { path: string; body: any }[] = [];
  const server = http.createServer((req, res) => { let raw = ''; req.on('data', (d) => (raw += d)); req.on('end', () => { const body = raw ? JSON.parse(raw) : {}; seen.push({ path: req.url ?? '', body }); const r = handler(req.url ?? '', body); res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.body)); }); });
  return new Promise<{ url: string; seen: typeof seen }>((resolve) => server.listen(0, '127.0.0.1', () => { live.push(() => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); })); resolve({ url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, seen }); }));
}
const authority = (url: string) => new MeetPhoneAuthority({ baseUrl: url, auth: { kind: 'hmac', secret: 'a-secret-of-at-least-16-chars' } });

test('requestPeerCredential: asks Meet with the call id and the one-time media token, and returns the credential only for an explicit "issued"', async () => {
  const m = await fakeMeetHttp(() => ({ status: 200, body: { result: 'issued', credential: CRED, jti: 'j'.repeat(40), expiresAt: 1800000060, ttlSeconds: 60 } })), a = authority(m.url);
  const c = await a.requestPeerCredential('sip_abc12345', 'media-token-1'); assert.equal(c.credential, CRED); assert.equal(c.jti, 'j'.repeat(40)); assert.equal(c.ttlSeconds, 60);
  assert.equal(m.seen[0].path, '/api/phone/ivr/peer-credential'); assert.deepEqual(m.seen[0].body, { callId: 'sip_abc12345', mediaToken: 'media-token-1' });
});
test('requestPeerCredential: every other answer is a refusal (denied, not approved, already issued, unavailable, a malformed "issued", a server error)', async () => {
  const answers: [number, object][] = [[200, { result: 'denied' }], [200, { result: 'not_approved' }], [200, { result: 'already_issued' }], [200, { result: 'unavailable' }], [200, { result: 'issued' }], [200, { result: 'issued', credential: 5, jti: 'x' }], [200, { result: 'terminate', action: 'terminate' }], [401, {}], [503, { error: 'x' }], [500, {}]];
  for (const [status, body] of answers) { const m = await fakeMeetHttp(() => ({ status, body })); await assert.rejects(authority(m.url).requestPeerCredential('sip_abc12345', 'tok'), /did not issue a verification credential/, JSON.stringify([status, body])); }
});

async function fakeMeetSocket() {
  const auths: any[] = [], server = http.createServer(), srv = new Server(server);
  srv.use((socket, next) => { auths.push(socket.handshake.auth); next(); });
  srv.on('connection', (socket) => { socket.emit('roster', ['p-host']); socket.on('signal', (_m: unknown, ack?: (r: unknown) => void) => ack?.({ ok: true })); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); live.push(() => new Promise<void>((r) => { void srv.close(() => r()); }));
  return { url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, auths };
}
const args = (mediaToken?: string, signal = new AbortController().signal) => ({ callId: 'sip_abc12345', meetingSessionId: 's', mediaToken, signal });

test('verificationPeerSignaling: obtains the credential with the call\'s media token, connects as kind "verification-peer", reads its own id from the credential\'s pid, and exposes the credential id', async () => {
  const meet = await fakeMeetSocket(), asked: [string, string][] = [];
  const factory = verificationPeerSignaling({ baseUrl: meet.url, authority: { requestPeerCredential: async (callId, mediaToken) => { asked.push([callId, mediaToken]); return { credential: CRED, jti: 'j'.repeat(40) }; } } });
  const port = await factory(args('media-token-1')); live.push(() => port.close());
  assert.deepEqual(asked, [['sip_abc12345', 'media-token-1']]); assert.equal(meet.auths[0].kind, 'verification-peer'); assert.equal(meet.auths[0].token, CRED); assert.equal(port.selfId, 'p-phone', 'a credential names its participant in `pid`'); assert.equal(port.credentialJti, 'j'.repeat(40)); assert.deepEqual(port.roster(), ['p-host']);
});
test('verificationPeerSignaling: without a media token nothing is requested and nothing connects; a refused credential request connects nothing; a cancelled join connects nothing', async () => {
  const meet = await fakeMeetSocket(); let asked = 0; const auth = { requestPeerCredential: async () => { asked++; return { credential: CRED, jti: 'j'.repeat(40) }; } };
  await assert.rejects(verificationPeerSignaling({ baseUrl: meet.url, authority: auth })(args(undefined)), /no media token/); assert.equal(asked, 0); assert.equal(meet.auths.length, 0);
  await assert.rejects(verificationPeerSignaling({ baseUrl: meet.url, authority: { requestPeerCredential: async () => { throw new Error('meet did not issue a verification credential (200 denied)'); } } })(args('tok')), /did not issue/); assert.equal(meet.auths.length, 0);
  const ctl = new AbortController(); const slow = verificationPeerSignaling({ baseUrl: meet.url, authority: { requestPeerCredential: async () => { ctl.abort(); return { credential: CRED, jti: 'j'.repeat(40) }; } } })(args('tok', ctl.signal)); await assert.rejects(slow, /cancelled/); assert.equal(meet.auths.length, 0, 'cancelled before connecting');
});
test('meetSignaling: the participant token path still works (kind "participant"), and a plain string token is accepted as before', async () => {
  const meet = await fakeMeetSocket(); const tok = jwt({ meetingId: 'm1', participantId: 'p-1' });
  const port = await meetSignaling({ baseUrl: meet.url, kind: 'participant', token: async () => tok })(args()); live.push(() => port.close());
  assert.equal(meet.auths[0].kind, 'participant'); assert.equal(port.selfId, 'p-1'); assert.equal(port.credentialJti, undefined);
});

const goodEv = (): AudioEvidence => ({ state: 'audio_flowing', inboundPackets: 100, outboundPackets: 100, observedMs: 2000, codec: 'PCMU', encrypted: true, measuredAt: Date.now() });
test('the credential id travels with the media report: SipMediaGateway.peerJti reads the session\'s id, and the bridge sends it on every report (also for a leg that appeared late)', async () => {
  const reports: { peerJti?: string }[] = [];
  const gateway = { start: async () => goodEv(), stop: async () => {}, onEnded: () => {}, peerJti: (id: string) => (id === 'sip_abc12345' ? 'j'.repeat(40) : undefined) };
  const bridge = meetConfirmedBridge({ gateway, meet: { reportMedia: async (_id, _t, _e, opts) => { reports.push({ peerJti: opts?.peerJti }); return { result: 'connected', action: 'none' }; } } });
  assert.equal((await bridge.attach('sip_abc12345', 's', { signal: new AbortController().signal, mediaToken: 'tok' })).mediaEstablished, true); assert.equal(reports[0].peerJti, 'j'.repeat(40));
  const ctl = new AbortController(); ctl.abort(); await bridge.attach('sip_abc12345', 's', { signal: ctl.signal, mediaToken: 'tok' }); assert.equal(reports[1].peerJti, 'j'.repeat(40), 'a late leg is reported with its credential id too');
  const g = new SipMediaGateway({ meeting: { open: async () => { throw new Error('unused'); } } }); assert.equal(g.peerJti('nobody'), undefined, 'no leg, no id');
  void eventually; void crypto;
});

test('the keep-alive path carries the credential id too, so Meet can keep tying the evidence to the signalling session', async () => {
  const { startMediaKeepAlive } = await import('../src/meet-media.js'); const seen: (string | undefined)[] = [], legs = new Map([['sip_abc12345', 'tok']]);
  const ka = startMediaKeepAlive({ legs, measure: async () => goodEv(), meet: { reportMedia: async (_i, _t, _e, o) => { seen.push(o?.peerJti); return { result: 'connected', action: 'none' }; } }, terminate: async () => {}, peerJti: (id) => (id === 'sip_abc12345' ? 'j'.repeat(40) : undefined), intervalMs: 3_600_000 });
  await ka.tick(); ka.stop(); assert.deepEqual(seen, ['j'.repeat(40)]);
});
