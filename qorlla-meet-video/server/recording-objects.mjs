// Private object storage for encrypted recording chunks. The filesystem backend writes to a directory that is NEVER served by the web server (no static route,
// owner-only permissions); objects are only ever read back by the authorized download handler, and what is stored is already ciphertext.
// An S3-compatible backend (private bucket, SSE, no public ACLs) would implement the same four methods; it is NOT implemented or tested in this build.
import fs from 'node:fs/promises';
import path from 'node:path';

const KEY = /^[0-9a-f-]{36}\/\d{1,9}\.bin$/;
export function createObjectStore(env = process.env) {
  const kind = env.RECORDING_STORE || 'fs';
  if (kind !== 'fs') return { ready: false, reason: 'Only the filesystem object store is implemented (RECORDING_STORE=fs)' };
  const root = path.resolve(env.RECORDING_STORE_DIR || '');
  if (!env.RECORDING_STORE_DIR) return { ready: false, reason: 'RECORDING_STORE_DIR is not set' };
  const file = (key) => { if (!KEY.test(key)) throw new Error('Bad object key'); return path.join(root, key); };
  return {
    ready: true, kind, root,
    async put(key, buf) { const f = file(key); await fs.mkdir(path.dirname(f), { recursive: true, mode: 0o700 }); const tmp = f + '.tmp'; await fs.writeFile(tmp, buf, { mode: 0o600 }); await fs.rename(tmp, f); },
    async get(key) { return fs.readFile(file(key)); },
    async delete(key) { await fs.rm(file(key), { force: true }); },
    async removePrefix(prefix) { if (!/^[0-9a-f-]{36}$/.test(prefix)) throw new Error('Bad prefix'); await fs.rm(path.join(root, prefix), { recursive: true, force: true }); },
  };
}
