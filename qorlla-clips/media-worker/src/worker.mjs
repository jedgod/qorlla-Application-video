// Qorlla Clips media worker. Run: node src/worker.mjs   (see README.md for the environment)
import { Queue, Worker } from 'bullmq';
import { createApiClient, createUploader } from './clients.mjs';
import { processDraft, reportFailure } from './process.mjs';
import { renderPlaceholder } from './render.mjs';

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`media-worker: ${k} is required`); process.exit(2); } return v; };
const redisUrl = need('REDIS_URL'); const serviceKey = need('SERVICE_KEY'); const apiUrl = need('API_URL');
for (const k of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) need(k);

const QUEUE = 'avatar-render';
const connection = { url: redisUrl, maxRetriesPerRequest: null };
const api = createApiClient({ baseUrl: apiUrl, serviceKey });
const upload = createUploader();
const log = (m) => console.log(`[media-worker] ${m}`);
const render = (a) => renderPlaceholder({ ...a, ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg', font: process.env.RENDER_FONT || undefined });

const worker = new Worker(QUEUE, (job) => processDraft(job.data, { render, upload, api, log }), { connection, concurrency: Number(process.env.CONCURRENCY || 2) });
worker.on('failed', (job, err) => {
  log(`job ${job && job.id} failed (attempt ${job && job.attemptsMade}): ${err && err.message}`);
  if (job && job.attemptsMade >= (job.opts.attempts || 1)) void reportFailure(job.data, api, log);
});
worker.on('error', (e) => log(`worker error: ${e && e.message}`));

// Safety net: drafts that are PROCESSING but have no job (Redis was down when they were created, or a job was lost) are queued here.
// jobId = draft id, so a draft that already has a job is not queued twice.
const queue = new Queue(QUEUE, { connection });
queue.on('error', (e) => log(`queue error: ${e && e.message}`));
async function sweep() {
  try {
    for (const d of await api.pending()) {
      await queue.add('render', d, { jobId: d.draftId, attempts: 2, backoff: { type: 'exponential', delay: 10000 }, removeOnComplete: true, removeOnFail: 100 });
    }
  } catch (e) { log(`sweep failed: ${e.message}`); }
}
void sweep(); const timer = setInterval(sweep, 60000);

log(`online: queue "${QUEUE}", API ${apiUrl}, ffmpeg ${process.env.FFMPEG_PATH || 'ffmpeg'}`);
async function stop() { clearInterval(timer); await worker.close(); await queue.close(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
