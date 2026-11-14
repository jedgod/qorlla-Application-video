'use strict';
// Meeting password vault: lets the HOST see the password of a meeting again (Meeting ID + password on current and History meetings) without ever storing it in clear.
//
//   * AES-256-GCM. The key comes from MEETING_PASSCODE_KEY (at least 32 characters). The key is NEVER stored next to the data.
//   * FAIL CLOSED: without a usable key nothing is stored (seal() returns null), reveal says "not stored", and the meeting keeps working exactly as before with its
//     scrypt hash. A password is never written in clear, not even temporarily.
//   * The meeting ID is bound into every ciphertext (GCM additional data), so a sealed value copied onto another meeting does not open, and any edit is detected.
//   * Rotation: set the new key in MEETING_PASSCODE_KEY and keep the old one in MEETING_PASSCODE_KEY_PREVIOUS. Values sealed with the old key still open; `resealIfOld`
//     moves them to the new key the next time the host reveals them. Remove the old key after every stored value has been re-sealed (or the passwords re-set).
//   * Format: v1.<key id>.<iv>.<tag>.<ciphertext>   (base64url parts; the key id is a short hash, it does not reveal the key)
const crypto = require('crypto');

const MIN_KEY = 32;
const digits = (id) => String(id || '').replace(/\D/g, '');
const derive = (secret) => crypto.createHash('sha256').update('qorlla-meeting-passcode-v1\0' + secret).digest();
const kid = (key) => crypto.createHash('sha256').update(key).update('\0kid').digest('hex').slice(0, 8);
const b64 = (b) => Buffer.from(b).toString('base64url');

function keys(env = process.env) {
    const out = [];
    for (const name of ['MEETING_PASSCODE_KEY', 'MEETING_PASSCODE_KEY_PREVIOUS']) {
        const s = String(env[name] || ''); if (s.length < MIN_KEY) continue;
        const key = derive(s); out.push({ id: kid(key), key, current: name === 'MEETING_PASSCODE_KEY' });
    }
    return out;
}
const available = (env = process.env) => keys(env).some((k) => k.current);

/** Sealed string for `password`, or null when there is no usable key (nothing is stored then). */
function seal(meetingId, password, env = process.env) {
    const cur = keys(env).find((k) => k.current); if (!cur || typeof password !== 'string' || !password) return null;
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', cur.key, iv); c.setAAD(Buffer.from('qorlla-meeting:' + digits(meetingId)));
    const ct = Buffer.concat([c.update(password, 'utf8'), c.final()]);
    return ['v1', cur.id, b64(iv), b64(c.getAuthTag()), b64(ct)].join('.');
}

/** { ok:true, password, old } or { ok:false, reason: 'no_key' | 'unknown_key' | 'tampered' | 'malformed' }. Never throws. */
function open(meetingId, sealed, env = process.env) {
    if (typeof sealed !== 'string') return { ok: false, reason: 'malformed' };
    const p = sealed.split('.'); if (p.length !== 5 || p[0] !== 'v1') return { ok: false, reason: 'malformed' };
    const ring = keys(env); if (!ring.length) return { ok: false, reason: 'no_key' };
    const k = ring.find((x) => x.id === p[1]); if (!k) return { ok: false, reason: 'unknown_key' };
    try {
        const d = crypto.createDecipheriv('aes-256-gcm', k.key, Buffer.from(p[2], 'base64url')); d.setAAD(Buffer.from('qorlla-meeting:' + digits(meetingId))); d.setAuthTag(Buffer.from(p[3], 'base64url'));
        return { ok: true, password: Buffer.concat([d.update(Buffer.from(p[4], 'base64url')), d.final()]).toString('utf8'), old: !k.current };
    } catch (e) { return { ok: false, reason: 'tampered' }; }
}

/** After a successful open with an old key: the same password sealed with the current key (or null). */
const resealIfOld = (meetingId, opened, env = process.env) => (opened && opened.ok && opened.old ? seal(meetingId, opened.password, env) : null);

module.exports = { available, seal, open, resealIfOld, MIN_KEY };
