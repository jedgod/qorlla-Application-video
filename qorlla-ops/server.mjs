import pg from 'pg';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createOpsApp } from './app.mjs';

for (const key of ['DATABASE_URL', 'JWT_ISSUER', 'JWT_AUDIENCE', 'JWKS_URI']) if (!process.env[key]) throw new Error(`Missing ${key}`);
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const jwks = createRemoteJWKSet(new URL(process.env.JWKS_URI));
const verify = async (token) => (await jwtVerify(token, jwks, { issuer: process.env.JWT_ISSUER, audience: process.env.JWT_AUDIENCE, algorithms: ['ES256', 'RS256'] })).payload;
createOpsApp({ db, verify, ratePerMinute: Number(process.env.OPS_RATE_PER_MIN || 120) }).listen(Number(process.env.PORT || 6080), '127.0.0.1', () => console.log('Qorlla ops control listening'));
