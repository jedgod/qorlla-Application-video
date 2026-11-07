/**
 * TOTP (RFC 6238 over HOTP RFC 4226) and encryption of the stored secret. Pure functions; no I/O.
 * TOTP is the optional alternative / recovery factor next to passkeys (WebAuthn).
 */

import { createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text).replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function hotp(secret, counter, digits = 6, algorithm = 'sha1') {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(algorithm, secret).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const timeStep = (nowMs, period = 30) => Math.floor(nowMs / 1000 / period);
export const totp = (secret, nowMs, { period = 30, digits = 6, algorithm = 'sha1' } = {}) => hotp(secret, timeStep(nowMs, period), digits, algorithm);

/**
 * Returns the matching time step (a number) or null. Accepts the previous, current and next step by default (clock drift).
 * The caller stores the returned step and refuses any step <= the last accepted one: a code works once (replay prevention).
 */
export function matchTotp(secret, code, nowMs, { period = 30, digits = 6, window = 1 } = {}) {
  if (typeof code !== 'string' || !new RegExp(`^[0-9]{${digits}}$`).test(code)) return null;
  const now = timeStep(nowMs, period);
  let found = null;
  for (let s = now - window; s <= now + window; s++) {
    if (s < 0) continue;
    const want = Buffer.from(hotp(secret, s, digits));
    if (timingSafeEqual(want, Buffer.from(code)) && found === null) found = s;      // no early exit: the loop always runs in full
  }
  return found;
}

export function otpauthUri({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** AES-256-GCM: iv(12) | tag(16) | ciphertext. `aad` binds the blob to its owner so it cannot be moved to another user's row. */
export function seal(key, plaintext, aad = '') {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('encryption key must be 32 bytes');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function open(key, blob, aad = '') {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('encryption key must be 32 bytes');
  const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

export const newSecret = () => randomBytes(20);
