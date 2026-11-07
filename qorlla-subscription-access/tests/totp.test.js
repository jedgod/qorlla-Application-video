import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { hotp, totp, matchTotp, base32Encode, base32Decode, otpauthUri, seal, open, newSecret } from '../src/totp.js';

const RFC_SECRET = Buffer.from('12345678901234567890');                       // RFC 4226 / 6238 test key (ASCII)

test('RFC 4226 appendix D: the first ten HOTP values', () => {
  const want = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  want.forEach((v, i) => assert.equal(hotp(RFC_SECRET, i), v, 'counter ' + i));
});

test('RFC 6238 appendix B (SHA-1, 8 digits): the official vectors', () => {
  for (const [t, code] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.equal(totp(RFC_SECRET, t * 1000, { digits: 8 }), code, 'T=' + t);
  }
});

test('matching accepts one step of drift each way and rejects two; the matched step is returned for replay protection', () => {
  const now = 1_700_000_000_000;
  const at = (offsetSteps) => totp(RFC_SECRET, now + offsetSteps * 30_000);
  const step = Math.floor(now / 30_000);
  assert.equal(matchTotp(RFC_SECRET, at(0), now), step);
  assert.equal(matchTotp(RFC_SECRET, at(-1), now), step - 1);
  assert.equal(matchTotp(RFC_SECRET, at(1), now), step + 1);
  assert.equal(matchTotp(RFC_SECRET, at(-2), now), null);
  assert.equal(matchTotp(RFC_SECRET, at(2), now), null);
});

test('malformed codes never match', () => {
  const now = 1_700_000_000_000;
  for (const bad of [undefined, null, 123456, '', '12345', '1234567', '12345a', ' 123456', '123 456', '١٢٣٤٥٦', {}, []]) assert.equal(matchTotp(RFC_SECRET, bad, now), null, String(bad));
});

test('base32 round-trips and tolerates the formatting authenticator apps show', () => {
  for (let i = 0; i < 50; i++) { const b = randomBytes(1 + (i % 32)); assert.deepEqual(base32Decode(base32Encode(b)), b); }
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');                       // RFC 4648 vector
  assert.deepEqual(base32Decode('mzxw 6ytb-oi=='), Buffer.from('foobar'));
  assert.throws(() => base32Decode('not*base32'));
});

test('the enrolment URI carries the secret, issuer and parameters', () => {
  const uri = otpauthUri({ secret: Buffer.from('foobar'), account: 'u_1', issuer: 'Qorlla' });
  assert.match(uri, /^otpauth:\/\/totp\/Qorlla%3Au_1\?secret=MZXW6YTBOI&issuer=Qorlla&algorithm=SHA1&digits=6&period=30$/);
});

test('sealed secrets: round-trip, unreadable without the key, and bound to their owner', () => {
  const key = randomBytes(32), secret = newSecret();
  const blob = seal(key, secret, 'totp:u_alice');
  assert.deepEqual(open(key, blob, 'totp:u_alice'), secret);
  assert.ok(!blob.includes(secret), 'the plaintext is not in the blob');
  assert.throws(() => open(randomBytes(32), blob, 'totp:u_alice'), 'wrong key');
  assert.throws(() => open(key, blob, 'totp:u_mallory'), 'moved to another user\'s row');
  const tampered = Buffer.from(blob); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => open(key, tampered, 'totp:u_alice'), 'tampered');
  assert.notDeepEqual(seal(key, secret, 'x'), seal(key, secret, 'x'), 'fresh IV every time');
  assert.throws(() => seal(Buffer.alloc(16), secret), /32 bytes/);
});
