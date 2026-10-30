// Shared test harness: disposable PostgreSQL database per suite, a stand-in for MAIN's identity (JWKS + session introspection),
// and a signed-in HTTP client. The payment provider is replaced by tests/fake-stripe.mjs (a TEST DOUBLE - see that file).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';
import { createApp } from '../server/app.mjs';
import { loadConfig } from '../server/config.mjs';
import { createLogger } from '../server/log.mjs';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres';
export const ORIGIN = 'https://qorlla.test';
const sql = (f) => fs.readFileSync(path.join(here, '..', 'sql', f), 'utf8');
const meetSyncSql = (f) => fs.readFileSync(path.join(here, '..', '..', 'meet-sync', 'sql', f), 'utf8');

export async function freshDatabase({ migrate = true, ai = true } = {}) {
  const admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect();
  const name = 'portal_t_' + crypto.randomBytes(5).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  const url = ADMIN_URL.replace(/\/[^/]*$/, '/' + name);
  const pool = new pg.Pool({ connectionString: url, max: 12 });
  // MAIN's Meet-sync tables + the narrow directory view the portal reads (public schema), exactly as in the deployment
  await pool.query(meetSyncSql('001.sql')); await pool.query(meetSyncSql('006_meeting_directory.sql'));
  await pool.query(sql('001_portal.sql'));
  if (migrate) await pool.query(sql('002_billing.sql'));
  if (migrate && ai) { await pool.query(sql('004_meeting_ai.sql')); await pool.query(sql('005_phone.sql')); await pool.query(sql('006_workspace_tools.sql')); await pool.query(sql('007_billing_launch.sql')); await pool.query(sql('008_enterprise_ops.sql')); }
  return { pool, name, url, sql,
    async drop() { await pool.end(); const a = new pg.Client({ connectionString: ADMIN_URL }); await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end(); } };
}

export async function startMainStandIn() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key-1', alg: 'RS256', use: 'sig' };
  const other = await generateKeyPair('RS256'); // an attacker's key, not in the JWKS
  const sessions = new Map(); // sid -> active
  const server = http.createServer((req, res) => {
    const m = /^\/introspect\/([0-9a-f]{64})$/.exec(req.url);
    if (req.headers.authorization !== 'Bearer ' + SECRET) { res.writeHead(401); return res.end('{}'); }
    if (server.down) { res.writeHead(500); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ active: m ? sessions.get(m[1]) === true : false }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const SECRET = 's'.repeat(40);
  const base = { issuer: 'https://qorlla.test', audience: 'qorlla-workplace' };
  async function mint({ sub = crypto.randomUUID(), sid = crypto.randomBytes(32).toString('hex'), active = true, csrf = crypto.randomBytes(16).toString('base64url'), expIn = 900, iat = Math.floor(Date.now() / 1000), key = privateKey, iss = base.issuer, aud = base.audience, alg = 'RS256', mfa = false, authTime } = {}) {
    sessions.set(sid, active);
    const jwt = await new SignJWT({ sid, csrf: crypto.createHash('sha256').update(csrf).digest('hex'), ...(mfa ? { amr: ['pwd', 'mfa'], auth_time: authTime ?? iat } : {}) }).setProtectedHeader({ alg, kid: 'test-key-1' })
      .setSubject(sub).setIssuer(iss).setAudience(aud).setIssuedAt(iat).setExpirationTime(iat + expIn).sign(key);
    return { sub, sid, csrf, jwt };
  }
  return { jwks: createLocalJWKSet({ keys: [jwk] }), mint, other, sessions, secret: SECRET, introspectionUrl: `http://127.0.0.1:${server.address().port}/introspect`, server,
    close: () => new Promise((r) => server.close(r)) };
}

export function testConfig(over = {}, main) {
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'x', PORTAL_ALLOWED_ORIGIN: ORIGIN, MAIN_AUTH_ISSUER: ORIGIN, MAIN_AUTH_JWKS_URL: ORIGIN + '/.well-known/jwks.json',
    MAIN_INTROSPECTION_URL: main?.introspectionUrl, PORTAL_INTROSPECTION_SECRET: main?.secret, AUTH_REQUIRE_INTROSPECTION: 'true', ...over.env });
  // functional tests make many calls in a minute; the rate-limit behaviour itself is covered by tests/limits.test.mjs with its own values
  return Object.assign(cfg, { rateLimits: { ai: 100000, draft: 100000, job: 100000, call: 100000, refund: 100000, webhook: 1000000 } }, over.cfg || {});
}

export async function startApp({ pool, cfg, jwks, fetchImpl, stripe, ai, ops }) {
  const quiet = process.env.TEST_LOG ? createLogger() : createLogger(() => {});
  const built = createApp({ pool, cfg, jwks, fetchImpl, log: quiet, stripe, ai, ops });
  const { app, billing } = built;
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, billing, launch: built.launch, flags: built.flags, ai: built.ai, close: () => new Promise((r) => server.close(r)),
    /** HTTP client acting as a signed-in browser (cookies + same-origin headers). */
    client(session, { origin = ORIGIN, workspace } = {}) {
      const call = async (method, p, body, extra = {}) => {
        const headers = { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(workspace ? { 'x-workspace-id': workspace } : {}), ...extra };
        if (session) headers.cookie = `qorlla_portal_session=${session.jwt}; qorlla_csrf=${session.csrf}`;
        if (method !== 'GET' && !('origin' in extra)) headers.origin = origin;
        if (method !== 'GET' && session && !('x-csrf-token' in extra)) headers['x-csrf-token'] = session.csrf;
        const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
        const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
        return { status: r.status, body: json, headers: r.headers };
      };
      return { get: (p, h) => call('GET', p, undefined, h), post: (p, b, h) => call('POST', p, b, h), patch: (p, b, h) => call('PATCH', p, b, h), put: (p, b, h) => call('PUT', p, b, h), del: (p, h) => call('DELETE', p, undefined, h) };
    } };
}

/** Make `sub` the owner of a new workspace directly in the DB (what POST /workspaces does), returning the workspace id. */
export async function seedWorkspace(pool, ownerSub, name = 'WS') {
  const ws = (await pool.query('INSERT INTO portal.workspaces(name) VALUES($1) RETURNING id', [name])).rows[0].id;
  await pool.query(`INSERT INTO portal.members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [ws, ownerSub]);
  await pool.query(`INSERT INTO portal.subscriptions(workspace_id,plan_slug,status) VALUES($1,'basic','active')`, [ws]);
  return ws;
}
export async function addMember(pool, ws, sub, role) { await pool.query('INSERT INTO portal.members(workspace_id,user_id,role) VALUES($1,$2,$3)', [ws, sub, role]); }

/** A Meet meeting as MAIN's sync records it (scheduled by `ownerSub`, registered with Meet): what the portal's directory view exposes. */
export async function seedMeeting(pool, ownerSub, { title = 'Weekly sync', status = 'synced' } = {}) {
  const meet = crypto.randomUUID(); const src = crypto.randomUUID();
  await pool.query(`INSERT INTO qorlla_schedules(source_id,legacy_code,title,owner_name,scheduled_at,status,meet_uuid,meet_code,owner_user_id) VALUES($1,$2,$3,'Host',now(),$4,$5,$6,$7)`,
    [src, String(Math.floor(1e10 + Math.random() * 9e10)), title, status, meet, String(Math.floor(1e11 + Math.random() * 9e11)), ownerSub]);
  return meet;
}
