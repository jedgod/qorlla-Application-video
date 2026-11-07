// A software WebAuthn authenticator for tests: builds the same bytes a real passkey would (CBOR attestation object, COSE key,
// authenticator data with flags + counter, ECDSA P-256 signatures), so server-side verification runs against genuine structures.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const sha256 = (b) => createHash('sha256').update(b).digest();
const u = (b) => Buffer.from(b).toString('base64url');

// ---- minimal CBOR encoder (ints, byte strings, text, maps, arrays) --------------------------------------------------------
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
}
export function cbor(v) {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const t = Buffer.from(v); return Buffer.concat([head(3, t.length), t]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, val]) => [cbor(k), cbor(val)])]);
}

export class SoftAuthenticator {
  constructor({ rpID, origin, counter = 0 } = {}) {
    this.rpID = rpID; this.origin = origin; this.counter = counter;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    this.jwk = publicKey.export({ format: 'jwk' });
    this.credentialId = randomBytes(32);
    this.id = u(this.credentialId);
  }

  _authData(rpID, flags, counter, attested) {
    const c = Buffer.alloc(4); c.writeUInt32BE(counter);
    const parts = [sha256(Buffer.from(rpID)), Buffer.from([flags]), c];
    if (attested) {
      const l = Buffer.alloc(2); l.writeUInt16BE(this.credentialId.length);
      const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(this.jwk.x, 'base64url')], [-3, Buffer.from(this.jwk.y, 'base64url')]]);
      parts.push(Buffer.alloc(16), l, this.credentialId, cbor(cose));
    }
    return Buffer.concat(parts);
  }

  /** Answers navigator.credentials.create(). Options let a test tamper with exactly one property. */
  create(options, o = {}) {
    const origin = o.origin ?? this.origin;
    const flags = (o.uv === false ? 0x01 : 0x05) | 0x40;                                  // UP (+UV) + attested credential data
    const authData = this._authData(o.rpID ?? this.rpID, flags, this.counter, true);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: o.challenge ?? options.challenge, origin, crossOrigin: false }));
    return {
      id: this.id, rawId: this.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: { clientDataJSON: u(clientData), attestationObject: u(cbor({ fmt: 'none', attStmt: {}, authData })), transports: ['internal'] },
    };
  }

  /** Answers navigator.credentials.get(). `counter: <n>` sends exactly n, to simulate a cloned authenticator (n <= the server's stored value). */
  get(options, o = {}) {
    if (o.counter === undefined) this.counter += o.counterDelta ?? 1;                    // `counter` forces an exact value without moving the device
    const flags = o.uv === false ? 0x01 : 0x05;
    const authData = this._authData(o.rpID ?? this.rpID, flags, Math.max(0, o.counter ?? this.counter), false);
    const clientData = Buffer.from(JSON.stringify({ type: o.type ?? 'webauthn.get', challenge: o.challenge ?? options.challenge, origin: o.origin ?? this.origin, crossOrigin: false }));
    const signed = Buffer.concat([authData, sha256(clientData)]);
    const signature = sign('sha256', signed, { key: o.signWith ?? this.privateKey, dsaEncoding: 'der' });
    return {
      id: o.id ?? this.id, rawId: o.id ?? this.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: { authenticatorData: u(authData), clientDataJSON: u(clientData), signature: u(signature), userHandle: null },
    };
  }
}

export const otherKey = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
