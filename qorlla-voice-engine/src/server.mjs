// Production entry point: reads configuration from the environment and starts the engine.
import store, { pool } from './store.mjs';
import { authenticate } from './auth.mjs';
import { createVoiceApp } from './app.mjs';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
if (!process.env.VOICE_ALLOWED_ORIGIN) console.warn('VOICE_ALLOWED_ORIGIN is empty: no browser origin can call the API or open the WebSocket');
if (!process.env.VOICE_JWKS_URL || !process.env.VOICE_JWT_ISSUER || !process.env.VOICE_JWT_AUDIENCE) console.warn('Identity is not configured (VOICE_JWKS_URL, VOICE_JWT_ISSUER, VOICE_JWT_AUDIENCE): every request will be refused');
const voice = createVoiceApp({ store, db: pool, authenticate });
const port = await voice.listen(Number(process.env.PORT || 4600));
console.log(`Qorlla voice listening on ${port} (internet voice only: no PSTN, no carrier)`);
const shutdown = async () => { await voice.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
