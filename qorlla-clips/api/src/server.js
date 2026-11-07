import { PrismaClient } from '@prisma/client';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createStorage } from './storage.js';
import { sweepUploads } from './uploads.js';

const config = loadConfig();
const prisma = new PrismaClient();
const storage = config.storageEnabled ? createStorage(config.s3) : null;
if (storage && config.s3.autoCreateBucket) await storage.ensureBucket();
const app = createApp({ prisma, config, storage });
const server = app.listen(config.port, () => {
  console.log(`Qorlla Clips API on :${config.port}  (db: ${config.provider}, auth: ${config.authMode}, video storage: ${storage ? config.s3.bucket : 'not configured'})`);
});

// unfinished uploads must not hold storage forever: abort them when the server starts and then hourly
if (storage) {
  const sweep = () => sweepUploads({ prisma, storage, ttlMs: config.uploadTtlMs }).catch((e) => console.error('[clips-api] upload sweep failed', e && e.message));
  void sweep(); setInterval(sweep, 3600 * 1000).unref();
}

async function stop() { server.close(); await prisma.$disconnect(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
