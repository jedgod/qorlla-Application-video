import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, here } from './helpers.mjs';
import { createSbacs, mintServiceToken } from '../server/sbacs.mjs';

// SBACS Phase 2: the engine is connected to real endpoints. A subscription is necessary, never sufficient: membership, roles, document rights, AI flags
// and the AI gateway still apply (their own suites run in the same `npm test`). Subscription state is written to PostgreSQL directly, as after a verified webhook.
const KEYS = { meet: 'm'.repeat(40), clips: 'c'.repeat(40), storage: 's'.repeat(40), docs: 'd'.repeat(40) };
const tok = (service = 'meet', o = {}) => mintServiceToken({ service, key: KEYS[service], ...o });
describe('SBACS enforcement on real endpoints', () => {
  let db, main, app, sbacs;
  before(async () => { db = await freshDatabase(); main = await startMainStandIn(); sbacs = createSbacs({ pool: db.pool }); app = await startApp({ pool: db.pool, cfg: testConfig({ cfg: { sbacsServiceKeys: KEYS } }, main), jwks: main.jwks }); });
  after(async () => { await app.close(); await main.close(); await db.drop(); });
  const sql = (q, a) => db.pool.query(q, a);
  const newWs = async (plan = 'basic', status = 'active') => {
    const u = await main.mint(); const ws = await seedWorkspace(db.pool, u.sub);
    if (plan !== 'basic') await sql(`UPDATE portal.subscriptions SET plan_slug=$2,status=$3,billing_interval='month',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [ws, plan, status]);
    return { u, ws, c: app.client(u) };
  };
  const mkDoc = (c, extra = {}) => c.post('/api/v1/documents', { kind: 'doc', title: 'D', ...extra });
  const usage = async (ws, f) => (await sql(`SELECT used::int, reserved::int FROM portal.subscription_usage WHERE workspace_id=$1 AND feature=$2`, [ws, f])).rows[0] || { used: 0, reserved: 0 };

  test('Free keeps basic version history but cannot invoke restore or call analytics directly; Professional can', async () => {
    const free = await newWs(), pro = await newWs('pro');
    for (const w of [free, pro]) w.doc = (await mkDoc(w.c)).body;
    assert.equal((await free.c.get(`/api/v1/documents/${free.doc.id}/versions`)).status, 200, 'basic history stays free'); assert.equal((await free.c.get(`/api/v1/documents/${free.doc.id}/versions/1`)).status, 200);
    assert.equal((await free.c.get(`/api/v1/documents/${pro.doc.id}/versions`)).status, 404, 'history still needs access to THAT document');
    for (const [m, p, b] of [['post', `/api/v1/documents/${free.doc.id}/restore`, { version_no: 1, base_version: 1 }], ['get', '/api/v1/phone/analytics']]) {
      const r = await free.c[m](p, b); assert.equal(r.status, 403, p); assert.deepEqual({ e: r.body.error, reason: r.body.reason }, { e: 'subscription_access_denied', reason: 'not_in_plan' }); assert.equal(r.body.upgradeAvailable, true);
    }
    assert.equal((await pro.c.get(`/api/v1/documents/${pro.doc.id}/versions`)).status, 200);
    assert.equal((await pro.c.get(`/api/v1/documents/${free.doc.id}/versions`)).status, 404, 'a subscription never opens another workspace\'s document');
    assert.equal((await free.c.get(`/api/v1/documents/${free.doc.id}`)).status, 200, 'reading and editing your own document stays free');
  });

  test('document creation is metered per kind: concurrent creates cannot exceed the ceiling, replays and failures are not charged, deletes do not refund', async () => {
    const { c, ws, u } = await newWs();
    await sql(`INSERT INTO portal.entitlement_overrides(workspace_id,feature,enabled,quota,reason,created_by) VALUES($1,'docs.create',true,3,'test ceiling',$2)`, [ws, crypto.randomUUID()]);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => mkDoc(c, { title: 'n' + i, idempotency_key: 'create-key-' + i })));
    assert.equal(rs.filter((r) => r.status === 201).length, 3); const denied = rs.filter((r) => r.status === 403); assert.equal(denied.length, 7); assert.equal(denied[0].body.reason, 'quota_exhausted');
    assert.deepEqual(await usage(ws, 'docs.create'), { used: 3, reserved: 0 });
    const first = rs.find((r) => r.status === 201); const idx = rs.indexOf(first);
    const again = await mkDoc(c, { title: 'n' + idx, idempotency_key: 'create-key-' + idx }); assert.equal(again.status, 200, 'a retry returns the same document'); assert.equal(again.body.id, first.body.id);
    assert.deepEqual(await usage(ws, 'docs.create'), { used: 3, reserved: 0 }, 'the retry was not charged');
    await c.del(`/api/v1/documents/${first.body.id}`);
    assert.equal((await mkDoc(c, { idempotency_key: 'create-key-new' })).status, 403, 'deleting does not hand the creation back this month');
    assert.equal((await c.post('/api/v1/documents', { kind: 'doc', title: '' })).status, 400); assert.deepEqual(await usage(ws, 'docs.create'), { used: 3, reserved: 0 }, 'a rejected request reserves nothing');
    assert.equal((await c.post('/api/v1/documents', { kind: 'sheet', title: 'S' })).status, 201, 'sheets are a separate counter');
    assert.equal((await usage(ws, 'sheets.create')).used, 1);
    assert.equal(u.sub !== undefined, true);
  });

  test('a suspended workspace is DENIED everywhere (not downgraded), even when paid, overridden or holding a valid session; other workspaces are untouched', async () => {
    const a = await newWs('business'), b = await newWs('business'); const admin = crypto.randomUUID();
    await sql(`INSERT INTO portal.entitlement_overrides(workspace_id,feature,enabled,quota,reason,created_by) VALUES($1,'docs.create',true,NULL,'unlimited pilot',$2)`, [a.ws, admin]);
    assert.equal((await mkDoc(a.c)).status, 201);
    await sbacs.setSuspended({ workspaceId: a.ws, suspended: true, reason: 'chargeback', actorId: admin });
    for (const [m, p, body] of [['get', '/api/v1/notes'], ['post', '/api/v1/notes', { title: 'x' }], ['post', '/api/v1/documents', { kind: 'doc', title: 'x' }], ['get', '/api/v1/documents'], ['get', '/api/v1/members'], ['post', '/api/v1/ai/qorllamate/chat', { content: 'hi', idempotency_key: 'k-12345678' }], ['get', '/api/v1/entitlements']]) {
      const r = await a.c[m](p, body); assert.equal(r.status, 403, m + ' ' + p); assert.equal(r.body.code, 'account_suspended');
    }
    const cur = await a.c.get('/api/v1/subscriptions/current'); assert.equal(cur.status, 200); assert.equal(cur.body.suspended, true, 'the owner can still see why');
    assert.equal((await a.c.get('/api/v1/workspace')).status, 200);
    assert.equal((await mkDoc(b.c)).status, 201, 'another workspace is unaffected');
    const internal = await fetch(app.base + '/internal/v1/entitlements/check', { method: 'POST', headers: { authorization: 'Bearer ' + tok('docs'), 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: a.ws, feature: 'docs.create' }) });
    assert.equal((await internal.json()).reason, 'account_suspended', 'the cross-service interface agrees');
    await sbacs.setSuspended({ workspaceId: a.ws, suspended: false, actorId: admin }); assert.equal((await mkDoc(a.c)).status, 201, 'lifting it restores access at once (nothing is cached)');
  });

  test('cross-workspace isolation: a member cannot select, read or change another workspace\'s subscription or usage', async () => {
    const a = await newWs('pro'), b = await newWs();
    const sneaky = app.client(a.u, { workspace: b.ws });
    for (const p of ['/api/v1/subscriptions/current', '/api/v1/subscriptions/entitlements', '/api/v1/subscriptions/usage', '/api/v1/entitlements']) assert.equal((await sneaky.get(p)).status, 403, p);
    assert.equal((await a.c.get('/api/v1/subscriptions/current')).body.plan, 'pro'); assert.equal((await b.c.get('/api/v1/subscriptions/current')).body.plan, 'basic');
    for (const p of ['/api/v1/subscriptions/current']) for (const m of ['post', 'put', 'patch', 'del']) assert.ok([404, 403, 405].includes((await a.c[m](p, { plan: 'enterprise' })).status), 'no write path exists on the read-only endpoints: ' + m);
    assert.equal((await sql(`SELECT plan_slug FROM portal.subscriptions WHERE workspace_id=$1`, [b.ws])).rows[0].plan_slug, 'basic');
  });

  test('the internal interface refuses a missing, malformed, wrong-key, forged, expired or out-of-scope credential; with a valid service token it works within that service scope', async () => {
    const { ws } = await newWs('enterprise'); const call = (p, body, token) => fetch(app.base + '/internal/v1/entitlements/' + p, { method: 'POST', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const q = { workspaceId: ws, feature: 'meet.recording' }; const good = tok('meet');
    const bad = { missing: null, garbage: 'wrong-token-wrong-token-wrong', 'wrong key': mintServiceToken({ service: 'meet', key: 'x'.repeat(40) }),
      'unknown service': mintServiceToken({ service: 'billing', key: 'b'.repeat(40) }), expired: tok('meet', { now: Date.now() - 10 * 60_000 }), 'long-lived (1 h)': tok('meet', { ttlSec: 3600 }),
      'from the future': tok('meet', { now: Date.now() + 10 * 60_000 }), 'tampered claims': (() => { const [a, b, c] = good.split('.'); const j = JSON.parse(Buffer.from(b, 'base64url')); j.svc = 'storage'; return [a, Buffer.from(JSON.stringify(j)).toString('base64url'), c].join('.'); })() };
    for (const [why, t] of Object.entries(bad)) assert.equal((await call('check', q, t)).status, 404, why);
    assert.equal((await (await call('check', q, good)).json()).allowed, true);
    assert.equal((await call('check', { workspaceId: ws, feature: 'storage.mb' }, good)).status, 403, 'the meet credential cannot ask about storage');
    assert.equal((await call('check', { workspaceId: ws, feature: 'phone.pstn' }, good)).status, 403, 'nor about telephony');
    await sql(`INSERT INTO portal.entitlement_overrides(workspace_id,feature,enabled,quota,reason,created_by) VALUES($1,'storage.mb',true,1000,'test ceiling',$2)`, [ws, crypto.randomUUID()]);
    const st = tok('storage'), r = await (await call('reserve', { workspaceId: ws, feature: 'storage.mb', units: 500, idempotencyKey: 'upload-0001' }, st)).json(); assert.equal(r.ok, true);
    assert.equal((await (await call('reserve', { workspaceId: ws, feature: 'storage.mb', units: 500, idempotencyKey: 'upload-0001' }, st)).json()).replay, true);
    assert.equal((await call('finalize', { reservationId: r.reservationId }, good)).status, 403, 'another service cannot settle storage reservations');
    assert.equal((await (await call('finalize', { reservationId: r.reservationId }, st)).json()).ok, true); assert.deepEqual(await usage(ws, 'storage.mb'), { used: 500, reserved: 0 });
    const over = await call('reserve', { workspaceId: ws, feature: 'storage.mb', units: 600, idempotencyKey: 'upload-0002' }, st); assert.equal(over.status, 403); assert.equal((await over.json()).reason, 'quota_exhausted');
    assert.equal((await call('check', { workspaceId: 'not-a-uuid', feature: 'meet.x' }, good)).status, 400);
    const off = await startApp({ pool: db.pool, cfg: testConfig({}, main), jwks: main.jwks });                     // no SBACS_SERVICE_KEYS configured: the interface does not exist
    try { assert.equal((await fetch(off.base + '/internal/v1/entitlements/check', { method: 'POST', headers: { authorization: 'Bearer ' + good, 'content-type': 'application/json' }, body: JSON.stringify(q) })).status, 404); } finally { await off.close(); }
  });

  test('worker restarts: reservations a crashed worker left behind are given back, a late finalize is still recorded, and state survives an application restart', async () => {
    const { ws } = await newWs(); const restarted = createSbacs({ pool: db.pool });                      // a "new process" over the same database
    const r = await sbacs.reserve({ workspaceId: ws, featureKey: 'clips.create', units: 9, idempotencyKey: 'crash-0001', ttlMs: 1 });
    assert.deepEqual(await usage(ws, 'clips.create'), { used: 0, reserved: 9 });
    await new Promise((x) => setTimeout(x, 20));
    assert.ok((await restarted.reapExpired()) >= 1); assert.deepEqual(await usage(ws, 'clips.create'), { used: 0, reserved: 0 });
    assert.equal((await restarted.reserve({ workspaceId: ws, featureKey: 'clips.create', units: 10, idempotencyKey: 'after-0001' })).ok, true, 'the whole allowance is available again');
    const late = await restarted.finalize(r.reservationId); assert.equal(late.late, true); assert.equal((await usage(ws, 'clips.create')).used, 9, 'work that did happen is not lost');
    assert.equal((await restarted.release(r.reservationId)).ok, false, 'a finalized reservation cannot be released afterwards');
    const before = await restarted.effective(ws); await app.close(); app = await startApp({ pool: db.pool, cfg: testConfig({ cfg: { sbacsServiceKeys: KEYS } }, main), jwks: main.jwks });
    const w = await newWs('pro'); assert.equal((await w.c.get('/api/v1/subscriptions/current')).body.plan, 'pro'); assert.deepEqual((await restarted.effective(ws)).features['clips.create'].used, before.features['clips.create'].used);
  });

  test('downgrade over quota: content stays readable and editable, new creations and Professional tools stop, nothing is deleted', async () => {
    const w = await newWs('pro'); const ids = [];
    for (let i = 0; i < 27; i++) { const r = await mkDoc(w.c, { title: 'd' + i, idempotency_key: 'bulk-key-' + i }); assert.equal(r.status, 201); ids.push(r.body.id); }
    assert.equal((await w.c.get(`/api/v1/documents/${ids[0]}/versions`)).status, 200);
    await sql(`UPDATE portal.entitlements SET quota_approved=true WHERE plan_slug='basic' AND feature='docs.create'`);     // Qorlla approves the Free ceiling (it is provisional until then)
    await sql(`UPDATE portal.subscriptions SET status='canceled' WHERE workspace_id=$1`, [w.ws]);                  // period ended: back to Free (27 used > 25 allowed)
    const blocked = await mkDoc(w.c, { idempotency_key: 'bulk-key-after' }); assert.equal(blocked.status, 403); assert.equal(blocked.body.reason, 'quota_exhausted');
    assert.equal((await w.c.get(`/api/v1/documents/${ids[0]}/versions`)).status, 200, 'basic history is still readable');
    assert.equal((await w.c.post(`/api/v1/documents/${ids[0]}/restore`, { version_no: 1, base_version: 1 })).status, 403, 'restore is a paid tool');
    const list = (await w.c.get('/api/v1/documents')).body; assert.equal((Array.isArray(list) ? list : list.documents).length, 27, 'every document is still there');
    assert.equal((await w.c.get(`/api/v1/documents/${ids[26]}`)).status, 200);
    assert.equal((await sql(`SELECT count(*)::int n FROM portal.documents WHERE workspace_id=$1 AND deleted_at IS NULL`, [w.ws])).rows[0].n, 27);
  });

  test('audit protections hold for the application role: no UPDATE, DELETE or TRUNCATE on the event log, nothing for PUBLIC, usage rows cannot be deleted', async () => {
    const d = await freshDatabase(); const f = (...p) => fs.readFileSync(path.join(here, '..', 'sql', ...p), 'utf8'); const client = await d.pool.connect();
    try {
      await d.pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='qorlla_portal_app') THEN CREATE ROLE qorlla_portal_app NOLOGIN; END IF; END $$`);
      await d.pool.query(`CREATE ROLE sbacs_nobody NOLOGIN`).catch(() => {});
      // exactly what sql/003_roles.sh grants the application role
      await d.pool.query(`GRANT USAGE ON SCHEMA portal TO qorlla_portal_app, sbacs_nobody; GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA portal TO qorlla_portal_app; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA portal TO qorlla_portal_app`);
      await d.pool.query(f('013_sbacs_enforcement.sql'));                                                         // idempotent; applies the role-specific REVOKEs
      await client.query('SET ROLE qorlla_portal_app');
      await client.query(`INSERT INTO portal.entitlement_events(kind) VALUES('x')`);
      for (const q of [`UPDATE portal.entitlement_events SET kind='y'`, `DELETE FROM portal.entitlement_events`, `TRUNCATE portal.entitlement_events`, `DELETE FROM portal.subscription_usage`, `DELETE FROM portal.usage_reservations`]) await assert.rejects(client.query(q), /permission denied/, q);
      await client.query('RESET ROLE'); await client.query('SET ROLE sbacs_nobody');
      for (const t of ['entitlement_events', 'entitlement_overrides', 'subscription_usage', 'usage_reservations']) await assert.rejects(client.query(`SELECT * FROM portal.${t}`), /permission denied/, 'PUBLIC has no access to ' + t);
    } finally { await client.query('RESET ROLE').catch(() => {}); client.release(); await d.pool.query('DROP OWNED BY qorlla_portal_app').catch(() => {}); await d.pool.query('DROP OWNED BY sbacs_nobody').catch(() => {}); await d.drop(); await db.pool.query('DROP ROLE IF EXISTS qorlla_portal_app').catch(() => {}); await db.pool.query('DROP ROLE IF EXISTS sbacs_nobody').catch(() => {}); }
  });

  test('rollback refuses to rewrite history and archives instead of dropping usage, reservations, overrides and events', async () => {
    const f = (...p) => fs.readFileSync(path.join(here, '..', 'sql', ...p), 'utf8'); const d = await freshDatabase(); const p = d.pool;
    try {
      const ws = (await p.query(`INSERT INTO portal.workspaces(name) VALUES('Hist') RETURNING id`)).rows[0].id; await p.query(`INSERT INTO portal.subscriptions(workspace_id,plan_slug,status,current_period_end) VALUES($1,'starter','active',now()+interval '1 day')`, [ws]);
      await assert.rejects(p.query(f('rollback', '012_sbacs.down.sql')), /Starter plan or in the suspended state/);
      await p.query(`UPDATE portal.subscriptions SET plan_slug='pro' WHERE workspace_id=$1`, [ws]); await p.query(`UPDATE portal.workspaces SET suspended_at=now() WHERE id=$1`, [ws]);
      await assert.rejects(p.query(f('rollback', '012_sbacs.down.sql')), /suspended workspaces exist/);
      await p.query(`UPDATE portal.workspaces SET suspended_at=NULL WHERE id=$1`, [ws]);
      await p.query(`INSERT INTO portal.subscription_usage(workspace_id,feature,period_start,used) VALUES($1,'docs.create',date_trunc('month',now())::date,7)`, [ws]);
      await p.query(`INSERT INTO portal.entitlement_events(workspace_id,kind) VALUES($1,'billing.upgrade')`, [ws]);
      await p.query(f('rollback', '013_sbacs_enforcement.down.sql')); await p.query(f('rollback', '012_sbacs.down.sql'));
      const t = (await p.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='portal' AND table_name LIKE '%_archived_%' ORDER BY 1`)).rows.map((r) => r.table_name.replace(/_archived_\d+$/, ''));
      assert.deepEqual(t, ['entitlement_events', 'entitlement_overrides', 'subscription_usage', 'usage_reservations']);
      const arch = (await p.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='portal' AND table_name LIKE 'subscription_usage_archived_%'`)).rows[0].table_name;
      assert.equal((await p.query(`SELECT used::int FROM portal.${arch}`)).rows[0].used, 7);
      const evArch = (await p.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='portal' AND table_name LIKE 'entitlement_events_archived_%'`)).rows[0].table_name;
      await assert.rejects(p.query(`DELETE FROM portal.${evArch}`), /append-only/, 'the archived log is still immutable');
    } finally { await d.drop(); }
  });
});
