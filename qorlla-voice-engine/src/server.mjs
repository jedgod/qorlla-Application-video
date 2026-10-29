// Production entry point: reads configuration from the environment and starts the engine.
import store, { pool } from './store.mjs';
import { authenticate } from './auth.mjs';
import { createVoiceApp } from './app.mjs';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
if (!process.env.VOICE_ALLOWED_ORIGIN) console.warn('VOICE_ALLOWED_ORIGIN is empty: no browser origin can call the API or open the WebSocket');
if (!process.env.VOICE_JWKS_URL || !process.env.VOICE_JWT_ISSUER || !process.env.VOICE_JWT_AUDIENCE) console.warn('Identity is not configured (VOICE_JWKS_URL, VOICE_JWT_ISSUER, VOICE_JWT_AUDIENCE): every request will be refused');
if (!process.env.REDIS_URL) console.warn('REDIS_URL is not set: running as a SINGLE instance. Several replicas need Redis (use rediss:// with a password outside a private test network).');
if (!process.env.TURN_URLS) console.warn('TURN_URLS is not set: calls between different networks will fail behind strict firewalls. Deploy coturn (see the runbook).');
process.on('unhandledRejection', (e) => console.error('voice: unhandled rejection', e?.code || e?.message || 'unknown'));
const voice = createVoiceApp({ store, db: pool, authenticate });
const port = await voice.listen(Number(process.env.PORT || 4600));
console.log(`Qorlla voice listening on ${port} (internet voice only: no PSTN, no carrier)`);
// Graceful stop: sockets are closed with 1001 so clients reconnect (to another replica, or to this one after a restart) and resume from their cursor; undelivered events stay in PostgreSQL.
const shutdown = async () => { await voice.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
