import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The real network is replaced at its two edges: the API client (vi.mock) and XMLHttpRequest (a controllable fake), so this exercises the
// real state machine in src/lib/upload.ts: phases, parallelism, retry, resume, cancel.
vi.mock('@/lib/api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/api')>();
  return { ...orig, api: { startRecording: vi.fn(), uploadState: vi.fn(), signParts: vi.fn(), completeUpload: vi.fn(), abortUpload: vi.fn() } };
});
import { api, ApiError } from '@/lib/api';
import { uploadRecording, type UploadPhase } from '@/lib/upload';

type Put = { url: string; size: number };
type Reply = { status: number } | 'network';
let puts: Put[]; let inflight: number; let maxInflight: number;
let onPut: (put: Put, attempt: number, ctl: { progress: (n: number) => void }) => Reply | Promise<Reply>;
const attempts = new Map<string, number>();

class FakeXHR {
  upload: { onprogress: null | ((e: { lengthComputable: boolean; loaded: number }) => void) } = { onprogress: null };
  onload: null | (() => void) = null; onerror: null | (() => void) = null; ontimeout: null | (() => void) = null;
  status = 0; timeout = 0; private url = ''; private aborted = false;
  open(_m: string, url: string) { this.url = url; }
  send(body: Blob) {
    const put = { url: this.url, size: body.size }; puts.push(put);
    const n = (attempts.get(this.url.split('?')[0] + '#' + this.url.split('part=')[1]?.split('&')[0]) ?? 0) + 1;
    attempts.set(this.url.split('?')[0] + '#' + this.url.split('part=')[1]?.split('&')[0], n);
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    Promise.resolve(onPut(put, n, { progress: (b) => this.upload.onprogress?.({ lengthComputable: true, loaded: b }) })).then((r) => {
      inflight--; if (this.aborted) return;
      if (r === 'network') this.onerror?.(); else { this.status = r.status; this.onload?.(); }
    });
  }
  abort() { this.aborted = true; }
}

const blobOf = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: 'video/webm;codecs=vp9,opus' });
type ClipDto = import('@/lib/api').Clip;
const clip = (id = 'clip-1') => ({ id, title: 't', status: 'UPLOADING' }) as unknown as ClipDto;
const A = vi.mocked(api);

function arrange(opts: { partSize: number; totalParts: number; done?: number[] }) {
  A.startRecording.mockResolvedValue({ clip: clip(), upload: { partSize: opts.partSize, totalParts: opts.totalParts } });
  A.uploadState.mockResolvedValue({ status: 'UPLOADING', partSize: opts.partSize, totalParts: opts.totalParts, uploadedParts: (opts.done ?? []).map((n) => ({ partNumber: n, size: opts.partSize })) });
  A.signParts.mockImplementation(async (id: string, nums: number[]) => ({ urls: Object.fromEntries(nums.map((n) => [String(n), `https://store.test/${id}?part=${n}&sig=${Math.random()}`])), expiresInSeconds: 1800 }));
  A.completeUpload.mockResolvedValue({ clip: { ...clip(), status: 'READY' } as ClipDto });
  A.abortUpload.mockResolvedValue({ ok: true });
}
const run = (blob: Blob, extra: Partial<Parameters<typeof uploadRecording>[1]> = {}) => {
  const phases: UploadPhase[] = [], progress: number[] = [];
  const p = uploadRecording(blob, { onPhase: (ph) => phases.push(ph), onProgress: (n) => progress.push(n), backoffBaseMs: 1, ...extra });
  return { p, phases, progress };
};

beforeEach(() => {
  puts = []; inflight = 0; maxInflight = 0; attempts.clear();
  onPut = () => ({ status: 200 });
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  Object.values(A).forEach((m) => m.mockReset());
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('uploadRecording', () => {
  test('the happy path: phases in order, every part sent once with the right length, progress rises to 100 only after completion', async () => {
    arrange({ partSize: 5, totalParts: 3 });
    const { p, phases, progress } = run(blobOf(12));
    await p;
    expect([...new Set(phases)]).toEqual(['INITIALIZING', 'UPLOADING', 'ASSEMBLING', 'SUCCESS']);
    expect(puts.map((x) => x.size).sort()).toEqual([2, 5, 5]);                               // 12 bytes in 5-byte parts: 5 + 5 + 2
    expect(A.startRecording).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'video/webm', sizeBytes: 12 }));   // codec parameters stripped
    expect(A.completeUpload).toHaveBeenCalledTimes(1);
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);   // never goes backwards
    expect(progress[progress.length - 1]).toBe(100);
    expect(progress.slice(0, -1).every((n) => n <= 99)).toBe(true);                          // 100 means saved, not "all bytes sent"
  });

  test('every part is signed separately, so a retry always gets a fresh, unexpired URL', async () => {
    arrange({ partSize: 5, totalParts: 3 });
    await run(blobOf(12)).p;
    expect(A.signParts.mock.calls.map((c) => c[1])).toEqual(expect.arrayContaining([[1], [2], [3]]));
    expect(new Set(puts.map((x) => x.url)).size).toBe(3);
  });

  test('no more than `concurrency` parts are in flight at once', async () => {
    arrange({ partSize: 1, totalParts: 12 });
    onPut = () => new Promise<Reply>((r) => setTimeout(() => r({ status: 200 }), 5));
    await run(blobOf(12), { concurrency: 3 }).p;
    expect(maxInflight).toBe(3);
    puts = []; maxInflight = 0; attempts.clear();
    await run(blobOf(12), { concurrency: 1 }).p;
    expect(maxInflight).toBe(1);
  });

  test('a network failure is retried with a new URL and the upload still succeeds', async () => {
    arrange({ partSize: 5, totalParts: 2 });
    onPut = (put, attempt) => (put.url.includes('part=1&') && attempt === 1 ? 'network' : { status: 200 });
    const { p, phases } = run(blobOf(8));
    await p;
    expect(phases).toContain('SUCCESS');
    expect(puts.filter((x) => x.url.includes('part=1&')).length).toBe(2);                    // sent twice
    expect(A.signParts.mock.calls.filter((c) => c[1][0] === 1).length).toBe(2);              // signed twice
  });

  test.each([[500], [503], [429], [408]])('storage answering %i is treated as temporary and retried', async (status) => {
    arrange({ partSize: 5, totalParts: 1 });
    onPut = (_p, attempt) => (attempt < 3 ? { status } : { status: 200 });
    await run(blobOf(5)).p;
    expect(puts.length).toBe(3);
  });

  test('it gives up after maxAttempts, reports the failure, and never completes', async () => {
    arrange({ partSize: 5, totalParts: 1 });
    onPut = () => 'network';
    const { p, phases } = run(blobOf(5), { maxAttempts: 3 });
    await expect(p).rejects.toMatchObject({ code: 'network' });
    expect(puts.length).toBe(3);
    expect(phases).not.toContain('SUCCESS'); expect(phases).not.toContain('ASSEMBLING');
    expect(A.completeUpload).not.toHaveBeenCalled();
  });

  test('a refusal from storage (403: expired or wrong signature) is retried once with a fresh URL only if storage_rejected allows it, then fails', async () => {
    arrange({ partSize: 5, totalParts: 1 });
    onPut = () => ({ status: 403 });
    await expect(run(blobOf(5), { maxAttempts: 2 }).p).rejects.toMatchObject({ status: 403 });
    expect(puts.length).toBe(2);                                                              // a re-signed URL is worth one more try
    expect(A.completeUpload).not.toHaveBeenCalled();
  });

  test('a clear client error from the API (not temporary) is not retried', async () => {
    arrange({ partSize: 5, totalParts: 2 });
    A.signParts.mockRejectedValue(new ApiError(404, 'not_found', 'Not found.'));
    await expect(run(blobOf(8)).p).rejects.toMatchObject({ status: 404 });
    expect(puts.length).toBe(0);
    expect(A.signParts.mock.calls.length).toBeLessThanOrEqual(3);                             // one per worker at most, none retried
  });

  test('429 while signing is retried', async () => {
    arrange({ partSize: 5, totalParts: 1 });
    let n = 0;
    A.signParts.mockImplementation(async (_id: string, nums: number[]) => {
      if (++n === 1) throw new ApiError(429, 'rate_limited', 'Slow down.');
      return { urls: { [String(nums[0])]: 'https://store.test/x?part=1&sig=1' }, expiresInSeconds: 1800 };
    });
    await run(blobOf(5)).p;
    expect(n).toBe(2);
  });

  test('the server refusing to start (503) surfaces its message and nothing is sent to storage', async () => {
    A.startRecording.mockRejectedValue(new ApiError(503, 'storage_unavailable', 'Video storage is not configured on this server.'));
    const { p, phases } = run(blobOf(5));
    await expect(p).rejects.toThrow('Video storage is not configured on this server.');
    expect(puts.length).toBe(0); expect(phases).toEqual(['INITIALIZING']);
  });

  test('resume: parts storage already holds are skipped, progress starts above zero, and no new clip is created', async () => {
    arrange({ partSize: 5, totalParts: 3, done: [1, 2] });
    const { p, progress } = run(blobOf(12), { resume: { clipId: 'clip-1' } });
    await p;
    expect(A.startRecording).not.toHaveBeenCalled();
    expect(puts.map((x) => x.size)).toEqual([2]);                                             // only the last part
    expect(progress[0]).toBeGreaterThanOrEqual(80);                                           // 10 of 12 bytes were already there
    expect(A.completeUpload).toHaveBeenCalledWith('clip-1');
  });

  test('cancelling aborts the upload on the server, stops sending, and never completes', async () => {
    arrange({ partSize: 5, totalParts: 4 });
    const c = new AbortController();
    onPut = () => new Promise<Reply>((r) => setTimeout(() => r({ status: 200 }), 30));
    const { p, phases } = run(blobOf(20), { concurrency: 1, signal: c.signal });
    setTimeout(() => c.abort(), 40);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(A.abortUpload).toHaveBeenCalledWith('clip-1');
    expect(A.completeUpload).not.toHaveBeenCalled();
    expect(phases).not.toContain('SUCCESS');
    expect(puts.length).toBeLessThan(4);
  });

  test('the server refusing to complete (parts missing) is an error: SUCCESS is never reported', async () => {
    arrange({ partSize: 5, totalParts: 1 });
    A.completeUpload.mockRejectedValue(new ApiError(409, 'incomplete_upload', 'Some parts are missing or have the wrong size.'));
    const { p, phases } = run(blobOf(5));
    await expect(p).rejects.toMatchObject({ code: 'incomplete_upload' });
    expect(phases).toContain('ASSEMBLING'); expect(phases).not.toContain('SUCCESS');
  });

  test('the source (RECORDING or UPLOAD) and title are passed to the server', async () => {
    arrange({ partSize: 5, totalParts: 1 });
    await run(blobOf(5), { source: 'UPLOAD', title: 'holiday', durationMs: 1234 }).p;
    expect(A.startRecording).toHaveBeenCalledWith({ title: 'holiday', source: 'UPLOAD', mimeType: 'video/webm', sizeBytes: 5, durationMs: 1234 });
  });

  test('a file with no type is announced as WebM (the server then validates it)', async () => {
    arrange({ partSize: 5, totalParts: 1 });
    await run(new Blob([new Uint8Array(5)])).p;
    expect(A.startRecording).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'video/webm' }));
  });
});
