import 'dotenv/config';
import pg from 'pg';
import { createRemoteJWKSet } from 'jose';
import { loadConfig } from './config.mjs';
import { createApp } from './app.mjs';
import { createLogger } from './log.mjs';

const log = createLogger();
const cfg = loadConfig();
if (!cfg.databaseUrl) { log.error('DATABASE_URL is required'); process.exit(1); }
if (!cfg.authConfigured) log.warn('authentication is NOT configured: every private endpoint answers 503 (fail closed)', { missing: cfg.authProblems });
if (cfg.billing.enabled && !cfg.billing.available) log.warn('billing enabled but unavailable', { reasons: cfg.billing.unavailableReasons });

const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: Number(process.env.PG_POOL_MAX || 10) });
pool.on('error', (e) => log.error('postgres pool error', { err: e.message }));
const jwks = cfg.authConfigured ? createRemoteJWKSet(new URL(cfg.jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000, timeoutDuration: 5000 }) : null;
const { app, billing, launch, ai, ops } = createApp({ pool, cfg, jwks, log });
if (ops && cfg.ops.workerEnabled) ops.startWorker();
if (cfg.ai.workerEnabled) { ai.worker.start(); ai.phoneWorker.start(); }
if (!ai.llm.available) log.warn('AI_LLM_API_KEY is not set: AI meeting jobs will be BLOCKED (no simulated output)');

const server = app.listen(cfg.port, () => log.info('listening', { port: cfg.port, production: cfg.production }));
const sweep = setInterval(() => {
  billing.expireLapsed().catch((e) => log.error('expiry sweep failed', { err: e.message }));
  launch.applyScheduledChanges().catch((e) => log.error('scheduled plan change sweep failed', { err: e.message }));
  launch.expireStaleChanges().catch((e) => log.error('stale plan change sweep failed', { err: e.message }));
  launch.reportOverage().catch((e) => log.error('overage reporting failed', { err: e.message }));
}, 15 * 60_000);
sweep.unref();
const stop = (sig) => { log.info('shutting down', { sig }); clearInterval(sweep); ai.worker.stop(); ai.phoneWorker.stop(); server.close(() => pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(1), 10_000).unref(); };
process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
