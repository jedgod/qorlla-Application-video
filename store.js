/**
 * JSON file storage with optional encryption at rest.
 *
 * Set ENCRYPT_KEY (64 hex characters = 32 bytes, e.g. `openssl rand -hex 32`) and every file
 * written through this module is sealed with AES-256-GCM. Existing plaintext files keep working
 * and are encrypted the next time they are written (or all at once with
 * scripts/encrypt-data.js). To rotate, set the new key in ENCRYPT_KEY and the previous one in
 * ENCRYPT_KEY_OLD, then run the script's "rotate" command.
 *
 * Design notes:
 *  - The file name is bound to each ciphertext (GCM additional data), so a file cannot be swapped
 *    for another user's file without detection.
 *  - A file that is encrypted but cannot be decrypted THROWS. It is never treated as empty,
 *    because the next save would then overwrite the real data.
 *  - Writes are atomic (temp file + rename) with owner-only permissions where the OS supports it.
 *  - What this does and does not protect: it defends data on disk, in backups and in volume
 *    snapshots. Anyone who can read the running process's environment can also read the key.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const MARK = 'qorlla_enc';

function parseKey(hex, name) {
    if (!hex) return null;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error(`${name} must be exactly 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32`);
    }
    return Buffer.from(hex, 'hex');
}

// Read at load time so a malformed key stops the server at startup instead of at the first save
const KEY = parseKey(process.env.ENCRYPT_KEY, 'ENCRYPT_KEY');
const OLD_KEY = parseKey(process.env.ENCRYPT_KEY_OLD, 'ENCRYPT_KEY_OLD');

const aad = (file) => Buffer.from(path.basename(file).replace(/\.tmp$/, ''), 'utf8');

function seal(text, file, key = KEY) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    cipher.setAAD(aad(file));
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return JSON.stringify({ [MARK]: 1, alg: ALGO, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}

function open(envelope, file) {
    const keys = [KEY, OLD_KEY].filter(Boolean);
    if (!keys.length) {
        throw new Error(`${path.basename(file)} is encrypted but ENCRYPT_KEY is not set`);
    }
    for (const key of keys) {
        try {
            const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(envelope.iv, 'base64'));
            decipher.setAAD(aad(file));
            decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
            return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
        } catch (err) { /* try the next key */ }
    }
    throw new Error(`${path.basename(file)} could not be decrypted with the configured key(s)`);
}

const isEnvelope = (obj) => obj && typeof obj === 'object' && obj[MARK] === 1 && typeof obj.data === 'string';

/** Returns { data, encrypted } or null when the file does not exist. Throws on corruption. */
function inspect(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (err) { throw new Error(`${path.basename(file)} is not valid JSON (${err.message})`); }
    if (isEnvelope(parsed)) return { data: JSON.parse(open(parsed, file)), encrypted: true };
    return { data: parsed, encrypted: false };
}

function readJson(file, fallback) {
    const r = inspect(file);
    return r ? r.data : fallback;
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Moves the finished temp file over the real one. On Windows (and in folders synced by OneDrive,
 * Dropbox or an antivirus scanner) a rename onto an existing file can fail with EPERM/EACCES/EBUSY
 * while something briefly holds it open, so retry with a short back-off. If it still will not
 * rename, copy the contents over instead, which is not atomic but is far better than losing the save.
 */
function replaceFile(tmp, file) {
    const transient = new Set(['EPERM', 'EACCES', 'EBUSY']);
    let delay = 5;
    for (let attempt = 0; attempt < 8; attempt++) {
        try { fs.renameSync(tmp, file); return; }
        catch (err) {
            if (!transient.has(err.code)) throw err;
            sleepSync(delay);
            delay = Math.min(delay * 2, 200);
        }
    }
    fs.copyFileSync(tmp, file);
    try { fs.unlinkSync(tmp); } catch (err) { /* leftover temp file is harmless */ }
    console.warn('[Store]: ' + path.basename(file) + ' stayed locked; saved by copy instead of rename');
}

/** opts.plain forces an unencrypted write (used by the decrypt command only). */
function writeJson(file, data, opts = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify(data, null, 2);
    const out = KEY && !opts.plain ? seal(text, file) : text;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, out, { mode: 0o600 });
    replaceFile(tmp, file);
}

module.exports = {
    readJson,
    writeJson,
    inspect,
    enabled: !!KEY,
    hasOldKey: !!OLD_KEY
};
