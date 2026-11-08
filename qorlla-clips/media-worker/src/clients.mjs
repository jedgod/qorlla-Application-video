// The worker's two outside connections: object storage (to put the render) and the Clips API (to report back). Neither is a database.
import { readFile } from 'node:fs/promises';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export function createUploader(env = process.env) {
  const client = new S3Client({
    region: env.S3_REGION || 'us-east-1',
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    forcePathStyle: env.S3_FORCE_PATH_STYLE === '1',
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });
  const Bucket = env.S3_BUCKET;
  return async function upload(key, file) {
    const Body = await readFile(file);                                   // a placeholder is a few hundred KB; a real renderer would stream
    await client.send(new PutObjectCommand({ Bucket, Key: key, Body, ContentType: 'video/mp4', ContentLength: Body.length, ...(env.S3_SSE ? { ServerSideEncryption: env.S3_SSE } : {}) }));
    return Body.length;
  };
}

export function createApiClient({ baseUrl, serviceKey, fetchImpl = fetch, timeoutMs = 20000 }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const headers = { 'x-service-key': serviceKey, 'content-type': 'application/json' };
  const call = async (method, path, body) => {
    const r = await fetchImpl(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const json = await r.json().catch(() => null);
    return { status: r.status, body: json };
  };
  return {
    /** Reports a finished or failed render. 404 means the draft is gone (discarded, or already saved to My clips): nothing left to do. */
    async complete(draftId, body) {
      const r = await call('POST', `/api/internal/avatar-drafts/${draftId}/complete`, body);
      if (r.status === 404) return { gone: true };
      if (r.status < 200 || r.status >= 300) throw new Error(`the API refused the result (${r.status}): ${JSON.stringify(r.body)}`);
      return r.body;
    },
    async pending() {
      const r = await call('GET', '/api/internal/avatar-drafts/pending');
      if (r.status !== 200) throw new Error(`could not list pending drafts (${r.status})`);
      return r.body.drafts || [];
    },
  };
}
