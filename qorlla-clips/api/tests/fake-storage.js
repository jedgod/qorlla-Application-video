// An in-memory stand-in for object storage with the same interface as src/storage.js. It enforces what the real store enforces
// that matters to the API: a part must be exactly the signed length, and a completed object is the sum of its parts.
import { randomUUID } from 'node:crypto';

export class FakeStorage {
  constructor() { this.uploads = new Map(); this.objects = new Map(); this.aborted = []; this.removed = []; this.fail = {}; this.sizeLie = null; }

  _maybeFail(op) { if (this.fail[op]) { const e = new Error('simulated storage outage'); e.name = 'ServiceUnavailable'; throw e; } }

  async startMultipart(key, contentType) {
    this._maybeFail('start');
    const id = randomUUID(); this.uploads.set(id, { key, contentType, parts: new Map() }); return id;
  }
  async signPart(key, uploadId, partNumber, contentLength, expiresIn) {
    const u = this.uploads.get(uploadId); if (!u || u.key !== key) throw Object.assign(new Error('no such upload'), { name: 'NoSuchUpload' });
    return `https://fake.test/put?u=${uploadId}&n=${partNumber}&len=${contentLength}&exp=${expiresIn}`;
  }
  /** What a browser does with a signed URL: PUT `bytes` (a number of bytes). Refuses a length other than the signed one. */
  async put(url, bytes) {
    const q = new URL(url).searchParams; const u = this.uploads.get(q.get('u'));
    if (!u) return { status: 404 };
    if (Number(q.get('len')) !== bytes) return { status: 403, code: 'SignatureDoesNotMatch' };
    u.parts.set(Number(q.get('n')), { partNumber: Number(q.get('n')), size: bytes, etag: `"etag-${q.get('n')}-${bytes}"` });
    return { status: 200 };
  }
  async listParts(key, uploadId) {
    this._maybeFail('list');
    const u = this.uploads.get(uploadId); if (!u) throw Object.assign(new Error('no such upload'), { name: 'NoSuchUpload' });
    return [...u.parts.values()].sort((a, b) => a.partNumber - b.partNumber);
  }
  async complete(key, uploadId, parts) {
    this._maybeFail('complete');
    const u = this.uploads.get(uploadId); if (!u) throw Object.assign(new Error('no such upload'), { name: 'NoSuchUpload' });
    const size = parts.reduce((n, p) => n + u.parts.get(p.partNumber).size, 0);
    this.objects.set(key, { size: this.sizeLie ?? size, contentType: u.contentType }); this.uploads.delete(uploadId);
  }
  async abort(key, uploadId) { this.aborted.push(uploadId); this.uploads.delete(uploadId); }
  async head(key) { return this.objects.get(key) ?? null; }
  async signGet(key, { expiresIn }) { return `https://fake.test/get?key=${encodeURIComponent(key)}&exp=${expiresIn}`; }
  async remove(key) { this.removed.push(key); this.objects.delete(key); }
}
