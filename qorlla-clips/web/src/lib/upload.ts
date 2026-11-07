// Multipart upload of a recording straight to object storage.
//
// The server decides everything that matters (object key, part size, size limit) and signs one short-lived URL per part. The browser
// only sends bytes. After the last part the SERVER lists what the storage actually holds and completes the upload, so nothing the
// browser reports (sizes, ETags) is trusted, and storage CORS needs no ETag exposure.
//
// Parts upload with limited parallelism, each retried with backoff; if an upload is interrupted it can be resumed (parts already in
// storage are skipped) because the server can list them.

import { api, ApiError, type Clip } from './api';

export type UploadPhase = 'INITIALIZING' | 'UPLOADING' | 'ASSEMBLING' | 'SUCCESS' | 'FAILED' | 'CANCELED';

export interface UploadHandle { clipId: string; clip?: Clip }

export interface UploadOptions {
  title?: string;
  source?: 'RECORDING' | 'UPLOAD';
  durationMs?: number;
  /** resume a previous attempt for the same recording instead of starting a new clip */
  resume?: UploadHandle;
  signal?: AbortSignal;
  onPhase: (phase: UploadPhase, handle?: UploadHandle) => void;
  /** 0..100, by bytes actually sent */
  onProgress: (percent: number) => void;
  concurrency?: number;
  maxAttempts?: number;
  /** first retry waits about this long, then doubles (capped at 8 s). Tests set it near zero. */
  backoffBaseMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Canceled', 'AbortError')); }, { once: true });
});

/** PUT one part with XMLHttpRequest (fetch cannot report upload progress). Resolves when storage answers 2xx. */
function putPart(url: string, body: Blob, onBytes: (sent: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onBytes(e.loaded); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status, 'storage_rejected', `Storage refused part (${xhr.status})`)));
    xhr.onerror = () => reject(new ApiError(0, 'network', 'The connection to storage was interrupted.'));
    xhr.ontimeout = () => reject(new ApiError(0, 'network', 'Storage did not answer in time.'));
    xhr.timeout = 10 * 60 * 1000;
    const abort = () => { xhr.abort(); reject(new DOMException('Canceled', 'AbortError')); };
    if (signal) { if (signal.aborted) return abort(); signal.addEventListener('abort', abort, { once: true }); }
    xhr.send(body);
  });
}

const retryable = (e: unknown) => !(e instanceof DOMException && e.name === 'AbortError') && !(e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429 && e.code !== 'storage_rejected');

export async function uploadRecording(blob: Blob, opts: UploadOptions): Promise<Clip> {
  const { signal, onPhase, onProgress } = opts;
  const concurrency = opts.concurrency ?? 3, maxAttempts = opts.maxAttempts ?? 4, backoffBase = opts.backoffBaseMs ?? 500;
  const mimeType = (blob.type || 'video/webm').split(';')[0];
  onPhase('INITIALIZING', opts.resume);

  let clipId = opts.resume?.clipId;
  let partSize: number, totalParts: number;
  let done = new Set<number>();
  if (clipId) {
    const st = await api.uploadState(clipId);
    partSize = st.partSize; totalParts = st.totalParts; done = new Set(st.uploadedParts.map((p) => p.partNumber));
  } else {
    const started = await api.startRecording({ title: opts.title, source: opts.source, mimeType, sizeBytes: blob.size, durationMs: opts.durationMs });
    clipId = started.clip.id; partSize = started.upload.partSize; totalParts = started.upload.totalParts;
    onPhase('INITIALIZING', { clipId, clip: started.clip });
  }
  const handle: UploadHandle = { clipId };
  onPhase('UPLOADING', handle);

  const sent = new Array<number>(totalParts + 1).fill(0);                 // bytes sent per part (1-based)
  for (const n of done) sent[n] = Math.min(partSize, blob.size - (n - 1) * partSize);
  const report = () => onProgress(Math.min(99, Math.floor((sent.reduce((a, b) => a + b, 0) / Math.max(1, blob.size)) * 100)));
  report();

  const pending = Array.from({ length: totalParts }, (_, i) => i + 1).filter((n) => !done.has(n));
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const n = pending[cursor++];
      const start = (n - 1) * partSize, chunk = blob.slice(start, Math.min(start + partSize, blob.size));
      for (let attempt = 1; ; attempt++) {
        try {
          const signed = await api.signParts(clipId!, [n]);                // a fresh URL per attempt: URLs expire
          await putPart(signed.urls[String(n)], chunk, (b) => { sent[n] = b; report(); }, signal);
          sent[n] = chunk.size; report();
          break;
        } catch (e) {
          sent[n] = 0; report();
          if (attempt >= maxAttempts || !retryable(e)) throw e;
          await sleep(Math.min(8000, backoffBase * 2 ** (attempt - 1)) + Math.random() * (backoffBase / 2), signal);
        }
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
    onPhase('ASSEMBLING', handle);
    const { clip } = await api.completeUpload(clipId);
    onProgress(100);
    onPhase('SUCCESS', { clipId, clip });
    return clip;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') { await api.abortUpload(clipId).catch(() => null); }
    throw e;
  }
}
