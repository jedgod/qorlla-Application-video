// Test helpers: an isolated PostgreSQL schema per test file, and real ES256 tokens verified through a real JWKS endpoint.
import fs from 'node:fs';
import http from 'node:http';
import pg from 'pg';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { migrate } from '../src/migrate.mjs';

/** VOICE_TEST_DATABASE_URL, or the repository's dev-stack database. null = no database available (tests that need one are skipped). */
export function testDbUrl() {
  if (process.env.VOICE_TEST_DATABASE_URL) return process.env.VOICE_TEST_DATABASE_URL;
  try { const s = JSON.parse(fs.readFileSync(new URL('../../.dev-stack/secrets.json', import.meta.url), 'utf8')); return `postgres://qorlla:${s.dbPassword}@127.0.0.1:35432/qorlla_meet`; } catch { return null; }
}
export async function reachable(url) { if (!url) return false; const p = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2500 }); try { await p.query('SELECT 1'); return true; } catch { return false; } finally { await p.end().catch(() => {}); } }

export async function isolatedDb() {
  const url = testDbUrl(); if (!(await reachable(url))) return null;
  const schema = 'qv_' + Math.random().toString(36).slice(2, 10);
  const admin = new pg.Pool({ connectionString: url }); await admin.query('CREATE SCHEMA ' + schema);
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema, max: 25, application_name: 'qv_test_' + schema });
  pool.on('error', () => { /* a test may kill connections on purpose */ });
  await migrate(pool);
  return { pool, schema, appName: 'qv_test_' + schema, admin, async drop() { await pool.end().catch(() => {}); await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end(); } };
}

/** A real signing key, a real JWKS server, and a function that mints tokens the engine's real verifier accepts (or, with overrides, must refuse). */
export async function identityProvider() {
  const { publicKey, privateKey } = await generateKeyPair('ES256'), jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  const other = await generateKeyPair('ES256');
  const srv = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const jwksUrl = 'http://127.0.0.1:' + srv.address().port + '/jwks.json';
  const token = async (sub, o = {}) => new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: o.kid || 'k1' }).setSubject(sub).setIssuer(o.iss || 'qorlla-main').setAudience(o.aud || 'qorlla-voice').setIssuedAt().setExpirationTime(o.exp || '5m').sign(o.wrongKey ? other.privateKey : privateKey);
  return { jwksUrl, token, close: () => new Promise((r) => srv.close(r)) };
}
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
