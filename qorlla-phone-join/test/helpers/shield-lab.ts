import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * The REAL Security Shield (qorlla-voice-engine, loaded read-only from SHIELD_ENGINE_DIR, in process, on its own isolated schema) for the Chromium laboratory. Meet is started with the Shield enforcing; a transparent
 * proxy sits in front of the Shield so it can be made UNREACHABLE for Meet (connections destroyed) and restored, without touching the Shield. Suspension uses the Shield's own admin routes. Nothing is faked.
 * Credentials are generated per run and never printed. Lab only.
 */
export type ShieldLab = Awaited<ReturnType<typeof startShieldLab>>;
export async function startShieldLab(o: { engineDir: string; meetDir: string; dbUrl: string }) {
  const req = createRequire(path.join(o.engineDir, 'package.json')), jose = req('jose'), ISSUER = 'qorlla-workload';
  process.env.VOICE_TEST_DATABASE_URL = o.dbUrl;                                                                       // the engine's own helpers read this: a dedicated test database, isolated schema
  const imp = (base: string, f: string) => import(pathToFileURL(path.join(base, f)).href) as Promise<any>;
  const { isolatedDb, identityProvider } = await imp(o.engineDir, 'test/helpers.mjs'), { harness } = await imp(o.engineDir, 'test/harness.mjs'), { signWorkloadJwt } = await imp(o.meetDir, 'server/telephony/number-sync.mjs');
  const db = await isolatedDb(); if (!db) throw new Error('the Shield test database is not reachable');
  const keys: Record<string, { kid: string; pem: string; jwk: object }> = {};
  for (const [who, kid] of [['meet', 'wm'], ['ops', 'wo']] as const) { const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }); keys[who] = { kid, pem: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, jwk: { ...(await jose.exportJWK(await jose.importSPKI(kp.publicKey.export({ type: 'spki', format: 'pem' }) as string, 'ES256'))), kid, alg: 'ES256', use: 'sig' } }; }
  const jwks = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: Object.values(keys).map((k) => k.jwk) })); });
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', () => r()));
  const idp = await identityProvider(), h = harness({ db, idp });
  const engine = await h.replica({ env: { SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_WORKLOAD_JWKS_URL: 'http://127.0.0.1:' + (jwks.address() as { port: number }).port + '/', SHIELD_WORKLOAD_ISSUER: ISSUER,
    SHIELD_WORKLOAD_ALLOWED: 'svc:meet=meet.register|meet.signal|alerts.report;svc:ops=shield.admin|shield.suspend|alerts.report|alerts.read' } });
  const state = { down: false };
  const proxy = http.createServer((q, r) => { if (state.down) { q.socket.destroy(); return; } const u = new URL(engine.base + q.url); const up = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: q.method, headers: { ...q.headers, connection: 'close' }, agent: false }, (ur) => { r.writeHead(ur.statusCode!, ur.headers); ur.pipe(r); }); up.on('error', () => q.socket.destroy()); q.pipe(up); });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r())); const url = 'http://127.0.0.1:' + (proxy.address() as { port: number }).port;
  const call = async (who: 'meet' | 'ops', method: string, p: string, body?: object) => { const token = signWorkloadJwt({ privateKeyPem: keys[who].pem, kid: keys[who].kid, issuer: ISSUER, subject: 'svc:' + who }); const r = await fetch(engine.base + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, connection: 'close' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> }; };
  return {
    url,
    /** Environment that makes a Meet process use this Shield. `graceSeconds` shortens the connected-call outage grace for the test only (production default 120 s). */
    meetEnv: (graceSeconds?: number): Record<string, string> => ({ SHIELD_MEET_ENFORCE: 'true', SHIELD_URL: url, SHIELD_MEET_KEY_PEM: keys.meet.pem.replace(/\n/g, '\\n'), SHIELD_WORKLOAD_ISSUER: ISSUER, SHIELD_WORKLOAD_KID: keys.meet.kid, SHIELD_RECHECK_SECONDS: '1', ...(graceSeconds ? { SHIELD_RECHECK_GRACE_SECONDS: String(graceSeconds) } : {}) }),
    /** A verified host account in an organization, known to the Shield: what a telephone caller's meeting must have. */
    owner: async () => {
      const org = 'org-' + crypto.randomBytes(3).toString('hex'), host = 'acct-host-' + crypto.randomBytes(3).toString('hex');
      await db.pool.query('INSERT INTO shield_orgs(org_id) VALUES($1) ON CONFLICT DO NOTHING', [org]); await db.pool.query('INSERT INTO shield_principals(account_id, org_id, verified) VALUES($1,$2,true) ON CONFLICT (account_id) DO UPDATE SET org_id=$2', [host, org]);
      return { hostAccountId: host, orgId: org, suspendHost: async () => { const r = await call('ops', 'POST', `/v1/shield/admin/principals/${host}/suspend`, {}); if (r.status !== 200) throw new Error('suspend failed ' + r.status); },
        suspendOrg: async () => { const r = await call('ops', 'POST', `/v1/shield/admin/orgs/${org}/suspend`, {}); if (r.status !== 200) throw new Error('org suspend failed ' + r.status); } };
    },
    /** The Shield's own audit trail (append-only): a marker now, and everything recorded after it. This is the authoritative record of a revocation even when Meet's call ended by another mechanism first. */
    mark: async (): Promise<number> => Number((await db.pool.query('SELECT COALESCE(max(id),0) AS m FROM shield_events')).rows[0].m),
    eventsSince: async (id: number) => (await db.pool.query('SELECT id, actor, action, decision, reason FROM shield_events WHERE id > $1 ORDER BY id', [id])).rows as { id: number; actor: string; action: string; decision: string; reason: string }[],
    /** true = the Shield is unreachable for Meet (the Shield itself keeps running). */
    setOutage: (down: boolean) => { state.down = down; },
    close: async () => { proxy.closeAllConnections(); await new Promise<void>((r) => proxy.close(() => r())); try { await engine.voice.close(); } catch (e) { console.error('shield lab: engine close failed:', (e as Error).message); } await h.closeAll().catch(() => undefined); await new Promise((r) => setTimeout(r, 400));     // let the engine's workers finish their last tick before the pool goes away
       await new Promise<void>((r) => jwks.close(() => r())); await idp.close().catch(() => undefined); await db.drop().catch(() => undefined); }
  };
}
