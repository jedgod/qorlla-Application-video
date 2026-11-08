import { PrismaClient } from '@prisma/client';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createStorage } from './storage.js';
import { sweepUploads } from './uploads.js';

const config = loadConfig();
const prisma = new PrismaClient();
const storage = config.storageEnabled ? createStorage(config.s3) : null;
if (storage && config.s3.autoCreateBucket) await storage.ensureBucket();
// the avatar render queue (BullMQ on Redis): only when AVATAR_RENDERER is on; the library is loaded lazily so it is not needed otherwise
let renderQueue = null;
if (config.avatarRenderer !== 'none') {
  const { Queue } = await import('bullmq');
  renderQueue = new Queue('avatar-render', { connection: { url: config.redisUrl, maxRetriesPerRequest: null } });
  renderQueue.on('error', (e) => console.error('[clips-api] render queue error:', e && e.message));
}
const app = createApp({ prisma, config, storage, renderQueue });
const server = app.listen(config.port, () => {
  console.log(`Qorlla Clips API on :${config.port}  (db: ${config.provider}, auth: ${config.authMode}, video storage: ${storage ? config.s3.bucket : 'not configured'}, avatar renderer: ${config.avatarRenderer})`);
});

// unfinished uploads must not hold storage forever: abort them when the server starts and then hourly
if (storage) {
  const sweep = () => sweepUploads({ prisma, storage, ttlMs: config.uploadTtlMs }).catch((e) => console.error('[clips-api] upload sweep failed', e && e.message));
  void sweep(); setInterval(sweep, 3600 * 1000).unref();
}

async function stop() { server.close(); await prisma.$disconnect(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
