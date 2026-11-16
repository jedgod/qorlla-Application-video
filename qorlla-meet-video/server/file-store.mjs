// Private, immutable file storage for shared files (v4.34).
//   quarantine/<unique>   written by the SERVER while it streams an upload (size-capped, hashed as it is written, then made read-only). Nothing a client holds can write to it afterwards.
//   clean/<aa>/<sha256>   write-once, content-addressed. An object is promoted here only from a scanned quarantine object whose hash still matches, and it can never be replaced: a different byte string
//                         has a different name, and the same name is verified to hold the same bytes. Reads re-hash the object, so tampering on disk is detected before anything is served.
// The directory is never served by the web server. An S3 backend with object versioning would implement the same methods; it is not implemented in this build.
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const QKEY = /^quarantine\/[0-9a-f-]{36}\.[0-9a-f]{16}$/, SHA = /^[0-9a-f]{64}$/;
export const sha256Of = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function createFileStore(env = process.env) {
  if (!env.FILES_DIR) return { ready: false, reason: 'FILES_DIR is not set' };
  const root = path.resolve(env.FILES_DIR);
  const qpath = (key) => { if (!QKEY.test(key)) throw new Error('Bad quarantine key'); return path.join(root, key); };
  const cpath = (sha) => { if (!SHA.test(sha)) throw new Error('Bad object name'); return path.join(root, 'clean', sha.slice(0, 2), sha); };
  const ensure = async () => { await fs.mkdir(path.join(root, 'quarantine'), { recursive: true, mode: 0o700 }); await fs.mkdir(path.join(root, 'clean'), { recursive: true, mode: 0o700 }); };
  return {
    ready: true, root,
    /** stream an upload into quarantine. Resolves { key, bytes, sha256 }; rejects with code 'too_large' (and leaves nothing behind) if more than maxBytes arrive. */
    async quarantineWrite(stream, { id, maxBytes }) {
      await ensure(); const key = `quarantine/${id}.${crypto.randomBytes(8).toString('hex')}`, file = qpath(key), hash = crypto.createHash('sha256'); let bytes = 0;
      await new Promise((resolve, reject) => {
        const out = createWriteStream(file, { flags: 'wx', mode: 0o600 }); let failed = false;
        const fail = (e) => { if (failed) return; failed = true; out.destroy(); stream.unpipe?.(out); fs.rm(file, { force: true }).finally(() => reject(e)); };
        stream.on('data', (chunk) => { bytes += chunk.length; if (bytes > maxBytes) { stream.pause?.(); fail(Object.assign(new Error('too large'), { code: 'too_large' })); } else hash.update(chunk); });
        stream.on('error', fail); stream.on('aborted', () => fail(Object.assign(new Error('aborted'), { code: 'aborted' }))); out.on('error', fail); out.on('finish', () => { if (!failed) resolve(); });
        stream.pipe(out);
      });
      await fs.chmod(file, 0o400); return { key, bytes, sha256: hash.digest('hex') };
    },
    async quarantineRead(key) { return fs.readFile(qpath(key)); },
    async removeQuarantine(key) { await fs.rm(qpath(key), { force: true }); },
    async listQuarantine() { await ensure(); const out = []; for (const n of await fs.readdir(path.join(root, 'quarantine'))) { const key = 'quarantine/' + n; if (!QKEY.test(key)) continue; out.push({ key, id: n.slice(0, 36), mtimeMs: (await fs.stat(qpath(key))).mtimeMs }); } return out; },
    /** promote the scanned bytes to their permanent, write-once name. Throws 'hash_mismatch' if the quarantine object is not exactly the bytes that were scanned/hashed. */
    async promote(key, sha256) {
      const bytes = await fs.readFile(qpath(key)); if (sha256Of(bytes) !== sha256) throw Object.assign(new Error('hash mismatch'), { code: 'hash_mismatch' });
      const target = cpath(sha256); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      try { const existing = await fs.readFile(target); if (sha256Of(existing) !== sha256) throw Object.assign(new Error('clean object differs'), { code: 'clean_corrupt' }); return { deduplicated: true }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const tmp = target + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
      try { await fs.writeFile(tmp, bytes, { mode: 0o400, flag: 'wx' }); await fs.link(tmp, target); }          // link() refuses to replace: an existing object is never overwritten
      catch (e) { if (e.code !== 'EEXIST') throw e; if (sha256Of(await fs.readFile(target)) !== sha256) throw Object.assign(new Error('clean object differs'), { code: 'clean_corrupt' }); }
      finally { await fs.rm(tmp, { force: true }); }
      return { deduplicated: false };
    },
    /** the bytes of a clean object, re-hashed: a modified object is refused, never served */
    async readClean(sha256) { const bytes = await fs.readFile(cpath(sha256)); if (sha256Of(bytes) !== sha256) throw Object.assign(new Error('object failed verification'), { code: 'clean_corrupt' }); return bytes; },
    async removeClean(sha256) { const f = cpath(sha256); await fs.chmod(f, 0o600).catch(() => {}); await fs.rm(f, { force: true }); },
    async hasClean(sha256) { try { await fs.access(cpath(sha256)); return true; } catch { return false; } },
  };
}
