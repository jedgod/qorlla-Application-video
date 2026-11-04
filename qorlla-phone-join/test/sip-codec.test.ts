import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parse, serialize, topVia, cseq, tagOf, uriOf, respond, header, LIMITS, type SipRequest } from '../src/sip/message.js';
import { DigestAuthenticator, answerChallenge, ha1, parseAuth } from '../src/sip/digest.js';
import { parseOffer, answer, buildOffer } from '../src/sip/sdp.js';

const INVITE = (extra = '', body = '') => `INVITE sip:+12025550100@gw.example SIP/2.0\r\nVia: SIP/2.0/UDP 198.51.100.7:5060;branch=z9hG4bKabc123def456;rport\r\nMax-Forwards: 70\r\nFrom: <sip:+12025550123@carrier.example>;tag=a1\r\nTo: <sip:+12025550100@gw.example>\r\nCall-ID: c1@carrier\r\nCSeq: 1 INVITE\r\nContact: <sip:x@198.51.100.7>\r\n${extra}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

test('SIP messages: a valid request round-trips, compact header forms are understood, and the pieces that identify a transaction are extracted', () => {
  const m = parse(INVITE()) as SipRequest; assert.equal(m.kind, 'request'); assert.equal(m.method, 'INVITE'); assert.equal(m.uri, 'sip:+12025550100@gw.example');
  assert.deepEqual(topVia(m), { transport: 'UDP', sentBy: '198.51.100.7:5060', branch: 'z9hG4bKabc123def456', received: undefined, rport: '' }); assert.deepEqual(cseq(m), { n: 1, method: 'INVITE' });
  assert.equal(tagOf(header(m, 'From')), 'a1'); assert.deepEqual(uriOf(header(m, 'From')), { user: '+12025550123', host: 'carrier.example' });
  const compact = parse('OPTIONS sip:gw SIP/2.0\r\nv: SIP/2.0/UDP h:1;branch=z9hG4bK1234567890ab\r\nf: <sip:a@b>;tag=1\r\nt: <sip:c@d>\r\ni: id1\r\nCSeq: 1 OPTIONS\r\nl: 0\r\n\r\n') as SipRequest; assert.ok(compact); assert.equal(header(compact, 'Call-ID'), 'id1');
  const again = parse(serialize(m)) as SipRequest; assert.equal(again.method, 'INVITE'); assert.equal(header(again, 'Call-ID'), 'c1@carrier');
});
test('SIP messages: malformed or hostile input is refused, never repaired', () => {
  const bad: [string, string | Buffer][] = [['empty', ''], ['no blank line', 'INVITE sip:a SIP/2.0\r\nVia: x'], ['wrong version', 'INVITE sip:a SIP/3.0\r\nCall-ID: x\r\n\r\n'], ['lowercase method', 'invite sip:a SIP/2.0\r\nCall-ID: x\r\n\r\n'],
    ['folded header', 'INVITE sip:a SIP/2.0\r\nCall-ID: x\r\n  folded\r\n\r\n'], ['header without colon', 'INVITE sip:a SIP/2.0\r\nCall-ID x\r\n\r\n'], ['control char in value', 'INVITE sip:a SIP/2.0\r\nCall-ID: x\u0000y\r\n\r\n'],
    ['two content-lengths', 'INVITE sip:a SIP/2.0\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n'], ['non-numeric content-length', 'INVITE sip:a SIP/2.0\r\nContent-Length: abc\r\n\r\n'], ['content-length longer than the body', 'INVITE sip:a SIP/2.0\r\nContent-Length: 50\r\n\r\nshort'],
    ['status out of range', 'SIP/2.0 99 Nope\r\nCall-ID: x\r\n\r\n'], ['oversized', Buffer.alloc(LIMITS.maxBytes + 1, 0x41)], ['too many headers', 'INVITE sip:a SIP/2.0\r\n' + Array.from({ length: LIMITS.maxHeaders + 1 }, (_, i) => `X-${i}: 1`).join('\r\n') + '\r\n\r\n'],
    ['header value too long', 'INVITE sip:a SIP/2.0\r\nX: ' + 'a'.repeat(LIMITS.maxHeaderValue + 1) + '\r\n\r\n']];
  for (const [name, raw] of bad) assert.equal(parse(raw), null, name);
  assert.equal(topVia(parse(INVITE().replace('z9hG4bKabc123def456', 'oldbranch'))!), null, 'a Via without the RFC 3261 branch cookie is not served');
  assert.equal(topVia(parse(INVITE().replace('SIP/2.0/UDP', 'SIP/2.0/XYZ'))!), null);
});
test('SIP messages: responses copy the identifying headers and add the To tag exactly once', () => {
  const m = parse(INVITE()) as SipRequest, r = respond(m, 200, 'OK', { toTag: 'gw1', body: 'v=0\r\n' }); assert.equal(tagOf(header(r, 'To')), 'gw1'); assert.equal(header(r, 'Call-ID'), 'c1@carrier'); assert.equal(header(r, 'CSeq'), '1 INVITE'); assert.equal(header(r, 'Content-Type'), 'application/sdp');
  const twice = respond(parse(serialize(r).toString().replace('SIP/2.0 200 OK', 'INVITE sip:a SIP/2.0')) as SipRequest, 200, 'OK', { toTag: 'other' }); assert.equal(tagOf(header(twice, 'To')), 'gw1', 'an existing tag is never replaced');
});

const secret = crypto.randomBytes(32), realm = 'qorlla-gw', H = ha1('SHA-256', 'trunk1', realm, 'trunk-secret');
const auth = (o: Partial<ConstructorParameters<typeof DigestAuthenticator>[0]> & { now?: () => number } = {}) => new DigestAuthenticator({ realm, secret, lookup: (u) => (u === 'trunk1' ? H : undefined), ...o });
const respondTo = (a: DigestAuthenticator, over: Record<string, string> = {}, nc = 1) => {
  const ch = a.challenge()[0], head = answerChallenge({ challenge: ch, method: 'INVITE', uri: 'sip:x', username: 'trunk1', password: 'trunk-secret', nc }); return { head: Object.keys(over).length ? head.replace(/(\w+)="?([^",]*)"?/g, (s, k) => (over[k] !== undefined ? `${k}="${over[k]}"` : s)) : head, ch };
};
test('digest: a correct SHA-256 answer is accepted once; a replay, a wrong password, an unknown user, a wrong realm, a changed URI and a forged nonce are refused', () => {
  const a = auth(); const { head } = respondTo(a); assert.deepEqual(a.verify('INVITE', 'sip:x', head), { ok: true, username: 'trunk1' }); assert.deepEqual(a.verify('INVITE', 'sip:x', head), { ok: false, reason: 'replay' });
  assert.equal(a.verify('INVITE', 'sip:x', answerChallenge({ challenge: a.challenge()[0], method: 'INVITE', uri: 'sip:x', username: 'trunk1', password: 'nope' })).ok, false);
  assert.deepEqual(a.verify('INVITE', 'sip:x', answerChallenge({ challenge: a.challenge()[0], method: 'INVITE', uri: 'sip:x', username: 'ghost', password: 'trunk-secret' })), { ok: false, reason: 'unknown_user' });
  assert.deepEqual(a.verify('INVITE', 'sip:y', respondTo(a).head), { ok: false, reason: 'bad_uri' }); assert.deepEqual(a.verify('BYE', 'sip:x', respondTo(a).head), { ok: false, reason: 'bad_response' }, 'the method is part of the proof');
  assert.deepEqual(a.verify('INVITE', 'sip:x', respondTo(a, { realm: 'other' }).head), { ok: false, reason: 'bad_realm' });
  const forged = respondTo(a).head.replace(/nonce="([^"]+)"/, (_s, n: string) => `nonce="${n.slice(0, -2)}xx"`); assert.deepEqual(a.verify('INVITE', 'sip:x', forged), { ok: false, reason: 'bad_nonce' });
  assert.deepEqual(a.verify('INVITE', 'sip:x', undefined), { ok: false, reason: 'missing' }); assert.deepEqual(a.verify('INVITE', 'sip:x', 'Basic abc'), { ok: false, reason: 'malformed' });
});
test('digest: nonces expire, a nonce from another secret is rejected, MD5 only when an operator enables it, and a short secret is refused at construction', () => {
  let t = 1_000_000; const a = auth({ now: () => t, nonceTtlMs: 5000 }), { head } = respondTo(a); t += 6000; assert.deepEqual(a.verify('INVITE', 'sip:x', head), { ok: false, reason: 'stale' });
  const other = auth({ secret: crypto.randomBytes(32) }); assert.deepEqual(other.verify('INVITE', 'sip:x', respondTo(a).head), { ok: false, reason: 'bad_nonce' });
  const md5 = new DigestAuthenticator({ realm, secret, lookup: () => ha1('MD5', 'trunk1', realm, 'trunk-secret'), algorithms: ['MD5'] }); assert.equal(md5.verify('INVITE', 'sip:x', answerChallenge({ challenge: md5.challenge()[0], method: 'INVITE', uri: 'sip:x', username: 'trunk1', password: 'trunk-secret' })).ok, true);
  assert.equal(auth().verify('INVITE', 'sip:x', answerChallenge({ challenge: md5.challenge()[0], method: 'INVITE', uri: 'sip:x', username: 'trunk1', password: 'trunk-secret' })).ok, false, 'the default accepts SHA-256 only');
  assert.throws(() => new DigestAuthenticator({ realm, secret: Buffer.alloc(8), lookup: () => undefined }), /at least 32 bytes/); assert.equal(parseAuth('Digest ' + 'a=b,'.repeat(400)), null, 'oversized headers are refused');
});

test('SDP: a G.711 + SRTP offer is answered with our own key and ptime 20; the answer never echoes the offerer\'s key', () => {
  const { sdp, key } = buildOffer({ ip: '198.51.100.7', port: 40000 }), o = parseOffer(sdp); assert.ok(!('refuse' in o)); if ('refuse' in o) return;
  assert.equal(o.secure, true); assert.equal(o.dtmfPt, 101); assert.deepEqual(o.codecs.map((c) => c.name), ['PCMU', 'PCMA']); assert.ok(o.crypto!.key.equals(key!));
  const a = answer(o, { ip: '203.0.113.9', port: 20000, sipSourceIp: '198.51.100.7' }); assert.ok(!('refuse' in a)); if ('refuse' in a) return;
  assert.equal(a.codec, 'PCMU'); assert.equal(a.secure, true); assert.ok(!a.crypto!.key.equals(key!)); assert.match(a.sdp, /m=audio 20000 RTP\/SAVP 0 101/); assert.match(a.sdp, /a=ptime:20/); assert.match(a.sdp, /a=sendrecv/);
  assert.deepEqual(parseOffer(a.sdp) && (parseOffer(a.sdp) as { port: number }).port, 20000);
});
test('SDP: refusals - codec mismatch, plain RTP, a media address that is not the caller\'s, hold / listen-only, no audio, malformed', () => {
  const ip = '198.51.100.7', policy = { ip: '203.0.113.9', port: 20000, sipSourceIp: ip }, of = (o: Partial<Parameters<typeof buildOffer>[0]>) => parseOffer(buildOffer({ ip, port: 40000, ...o }).sdp);
  const opusOnly = 'v=0\r\no=- 1 1 IN IP4 198.51.100.7\r\ns=-\r\nc=IN IP4 198.51.100.7\r\nt=0 0\r\nm=audio 40000 RTP/SAVP 111\r\na=rtpmap:111 opus/48000/2\r\na=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:' + crypto.randomBytes(30).toString('base64') + '\r\n';
  assert.deepEqual(answer(parseOffer(opusOnly) as never, policy), { refuse: 'codec_mismatch' });
  assert.deepEqual(answer(of({ secure: false }) as never, policy), { refuse: 'unencrypted' }, 'plain RTP is refused by default'); assert.ok(!('refuse' in (answer(of({ secure: false }) as never, { ...policy, allowPlainRtp: true }))), 'and only an explicit lab setting allows it');
  assert.deepEqual(answer(of({ ip: '192.0.2.99' }) as never, policy), { refuse: 'bad_media_address' }, 'RTP is never sent to an address other than the caller\'s');
  assert.deepEqual(answer(of({ direction: 'sendonly' }) as never, policy), { refuse: 'bad_direction' }); assert.deepEqual(answer(of({ direction: 'inactive' }) as never, policy), { refuse: 'bad_direction' });
  assert.deepEqual(parseOffer('v=0\r\nc=IN IP4 198.51.100.7\r\nm=video 40000 RTP/AVP 96\r\n'), { refuse: 'no_audio' }); assert.deepEqual(parseOffer('v=0\r\nc=IN IP4 198.51.100.7\r\nm=audio 0 RTP/AVP 0\r\n'), { refuse: 'no_audio' });
  for (const junk of ['', 'garbage', 'v=0\r\nc=IN IP4 not-an-ip\r\nm=audio 4000 RTP/AVP 0\r\n', 'v=0\r\nm=audio 99999 RTP/AVP 0\r\nc=IN IP4 1.2.3.4\r\n', 'x'.repeat(5000)]) assert.deepEqual(parseOffer(junk), { refuse: 'malformed' }, junk.slice(0, 20));
  const noDtmf = answer(of({ dtmfPt: null }) as never, policy); assert.ok(!('refuse' in noDtmf) && noDtmf.dtmfPt === undefined);
});
