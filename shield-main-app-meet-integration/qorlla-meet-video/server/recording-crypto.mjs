// Envelope encryption for recordings: a random 256-bit data key per recording encrypts every chunk with AES-256-GCM (authenticated: a modified, reordered or
// swapped chunk fails to decrypt); the data key is itself wrapped with a master key from a keyring. Deleting the wrapped key makes the media unrecoverable.
//
// Keyring: RECORDING_MASTER_KEYS = {"k1":"<base64 of 32 random bytes>", ...}, RECORDING_ACTIVE_KEY_ID = k1. Old keys stay in the ring so old recordings still open
// (key rotation). This is an application keyring supplied by your secret manager - NOT a hardware/cloud KMS. A KMS adapter would implement wrap()/unwrap().
import crypto from 'node:crypto';

export function loadKeyring(env = process.env) {
  let ring = {}; try { ring = JSON.parse(env.RECORDING_MASTER_KEYS || '{}'); } catch { return { ready: false, reason: 'RECORDING_MASTER_KEYS is not valid JSON' }; }
  const keys = new Map(); for (const [id, b64] of Object.entries(ring)) { const k = Buffer.from(String(b64), 'base64'); if (k.length === 32 && /^[A-Za-z0-9_-]{1,32}$/.test(id)) keys.set(id, k); }
  const active = env.RECORDING_ACTIVE_KEY_ID; if (!keys.size || !keys.has(active)) return { ready: false, reason: 'No usable master key (set RECORDING_MASTER_KEYS and RECORDING_ACTIVE_KEY_ID)' };
  return {
    ready: true, activeId: active,
    wrap(dek, aad) { const n = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', keys.get(active), n); c.setAAD(Buffer.from(aad)); const ct = Buffer.concat([c.update(dek), c.final()]); return { keyId: active, wrapped: Buffer.concat([n, ct, c.getAuthTag()]) }; },
    unwrap(keyId, wrapped, aad) { const k = keys.get(keyId); if (!k || !wrapped) throw new Error('Key unavailable'); const n = wrapped.subarray(0, 12), tag = wrapped.subarray(wrapped.length - 16), ct = wrapped.subarray(12, wrapped.length - 16); const d = crypto.createDecipheriv('aes-256-gcm', k, n); d.setAAD(Buffer.from(aad)); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]); },
  };
}
export const newDataKey = () => crypto.randomBytes(32);
const chunkAad = (recordingId, seq) => Buffer.from(recordingId + ':' + seq);          // binds a chunk to its recording and position
export function encryptChunk(dek, recordingId, seq, plain) { const n = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', dek, n); c.setAAD(chunkAad(recordingId, seq)); const ct = Buffer.concat([c.update(plain), c.final()]); return Buffer.concat([n, ct, c.getAuthTag()]); }
export function decryptChunk(dek, recordingId, seq, blob) { if (blob.length < 29) throw new Error('Corrupt chunk'); const n = blob.subarray(0, 12), tag = blob.subarray(blob.length - 16), ct = blob.subarray(12, blob.length - 16); const d = crypto.createDecipheriv('aes-256-gcm', dek, n); d.setAAD(chunkAad(recordingId, seq)); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]); }
