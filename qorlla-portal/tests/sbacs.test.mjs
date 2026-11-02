import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, here } from './helpers.mjs';
import { createSbacs } from '../server/sbacs.mjs';

// SBACS slice 1: entitlement engine, middleware, metering, audit, read-only endpoints. Subscription state is set directly in the database here,
// exactly as it is after a verified provider webhook (the webhook path itself is covered by billing.test.mjs).
describe('SBACS entitlement engine', () => {
  let db, main, app, sbacs;
  before(async () => { db = await freshDatabase(); main = await startMainStandIn(); sbacs = createSbacs({ pool: db.pool }); app = await startApp({ pool: db.pool, cfg: testConfig({}, main), jwks: main.jwks }); });
  after(async () => { await app.close(); await main.close(); await db.drop(); });
  const sql = (q, a) => db.pool.query(q, a);
  const newWs = async (plan = 'basic', status = 'active') => {
    const u = await main.mint(); const ws = await seedWorkspace(db.pool, u.sub);
    if (plan !== 'basic') await sql(`UPDATE portal.subscriptions SET plan_slug=$2,status=$3,billing_interval='month',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [ws, plan, status]);
    return { u, ws, c: app.client(u) };
  };
  const can = async (ws, feature) => (await sbacs.check({ workspaceId: ws, featureKey: feature }));

  test('free users are refused premium features by the engine and by the middleware (not just hidden in the UI)', async () => {
    const { ws } = await newWs();
    for (const f of ['meet.recording', 'docs.advanced', 'analytics.advanced', 'org.admin', 'org.sso']) { const r = await can(ws, f); assert.equal(r.allowed, false, f); assert.equal(r.reason, 'not_in_plan'); }
    assert.equal((await can(ws, 'meet.guest_join')).allowed, true); assert.equal((await can(ws, 'docs.create')).allowed, true);
    assert.equal((await can(ws, 'meet.recording')).upgradeAvailable, true, 'a listed plan offers it');
    const mw = sbacs.requireEntitlement('meet.recording'); let status, body, nexted = false;
    await mw({ actor: 'u', workspace: ws }, { status(s) { status = s; return this; }, json(b) { body = b; return this; } }, () => { nexted = true; });
    assert.equal(nexted, false); assert.equal(status, 403); assert.deepEqual(body, { error: 'subscription_access_denied', reason: 'not_in_plan', feature: 'meet.recording', upgradeAvailable: true });
    await mw({}, { status(s) { status = s; return this; }, json(b) { body = b; return this; } }, () => { nexted = true; }); assert.equal(status, 401);
    const pro = await newWs('pro'); assert.equal((await can(pro.ws, 'meet.recording')).allowed, true); await mw({ actor: 'u', workspace: pro.ws }, {}, () => { nexted = true; }); assert.equal(nexted, true);
  });

  test('the matrix: Business gets org admin, only Enterprise gets SSO, PSTN is never granted to anyone', async () => {
    const biz = await newWs('business'), ent = await newWs('enterprise');
    assert.equal((await can(biz.ws, 'org.admin')).allowed, true); assert.equal((await can(biz.ws, 'org.sso')).allowed, false); assert.equal((await can(ent.ws, 'org.sso')).allowed, true);
    for (const w of [biz.ws, ent.ws]) { assert.equal((await can(w, 'phone.pstn')).allowed, false); assert.equal((await can(w, 'phone.pstn')).reason, 'not_available'); assert.equal((await can(w, 'ai.private.external')).allowed, false); }
    assert.equal((await sql(`SELECT count(*)::int n FROM portal.entitlements WHERE feature='phone.pstn' AND enabled`)).rows[0].n, 0, 'no plan row enables PSTN');
    await assert.rejects(sbacs.setOverride({ workspaceId: ent.ws, feature: 'phone.pstn', enabled: true, reason: 'sales promised it', actorId: crypto.randomUUID() }), /cannot be enabled/);
    await sql(`INSERT INTO portal.entitlement_overrides(workspace_id,feature,enabled,reason,created_by) VALUES($1,'phone.pstn',true,'direct insert',$2)`, [ent.ws, crypto.randomUUID()]);
    assert.equal((await can(ent.ws, 'phone.pstn')).allowed, false, 'even a row written behind the API cannot unlock it');
  });

  test('cancellation keeps access to the paid period end; an ended or lapsed subscription falls back to Free; content is untouched', async () => {
    const w = await newWs('pro'); await sql(`UPDATE portal.subscriptions SET cancel_at_period_end=true WHERE workspace_id=$1`, [w.ws]);
    assert.equal((await can(w.ws, 'meet.recording')).allowed, true, 'cancel_at_period_end: still entitled until the period ends');
    await sql(`INSERT INTO portal.notes(workspace_id,author_id,title) VALUES($1,$2,'keep me')`, [w.ws, crypto.randomUUID()]);
    await sql(`UPDATE portal.subscriptions SET status='canceled' WHERE workspace_id=$1`, [w.ws]);
    assert.equal((await can(w.ws, 'meet.recording')).allowed, false);
    assert.equal((await sql(`SELECT count(*)::int n FROM portal.notes WHERE workspace_id=$1`, [w.ws])).rows[0].n, 1, 'downgrade never deletes content');
  });

  test('a suspended workspace stays blocked even when its subscription is paid; guest join is unaffected; lifting it restores access', async () => {
    const w = await newWs('business'); const admin = crypto.randomUUID();
    await sbacs.setSuspended({ workspaceId: w.ws, suspended: true, reason: 'abuse report', actorId: admin });
    for (const f of ['docs.create', 'meet.create', 'org.admin']) assert.deepEqual([(await can(w.ws, f)).allowed, (await can(w.ws, f)).reason], [false, 'account_suspended']);
    assert.equal((await can(w.ws, 'meet.guest_join')).allowed, true);
    const e = (await w.c.get('/api/v1/subscriptions/entitlements')).body; assert.equal(e.suspended, true); assert.equal(e.features['org.admin'].enabled, false);
    assert.equal((await sbacs.reserve({ workspaceId: w.ws, featureKey: 'ai.docs.draft', idempotencyKey: 'k1' })).ok, false);
    await sbacs.setSuspended({ workspaceId: w.ws, suspended: false, actorId: admin }); assert.equal((await can(w.ws, 'org.admin')).allowed, true);
    await sql(`UPDATE portal.subscriptions SET status='suspended' WHERE workspace_id=$1`, [w.ws]); assert.equal((await can(w.ws, 'org.admin')).reason, 'account_suspended', 'a suspended subscription blocks too');
  });

  test('quota: 40 concurrent reservations against a limit of 20 admit exactly 20; release frees a slot; finalize consumes it; replays are idempotent', async () => {
    const { ws } = await newWs();                                   // Free: ai.docs.draft = 20 / month
    const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => sbacs.reserve({ workspaceId: ws, featureKey: 'ai.docs.draft', idempotencyKey: 'c' + i })));
    assert.equal(rs.filter((r) => r.ok).length, 20); assert.equal(rs.filter((r) => r.reason === 'quota_exhausted').length, 20);
    assert.equal((await can(ws, 'ai.docs.draft')).reason, 'quota_exhausted');
    const ok = rs.filter((r) => r.ok);
    assert.equal((await sbacs.release(ok[0].reservationId)).ok, true); assert.equal((await sbacs.release(ok[0].reservationId)).ok, true, 'releasing twice is a no-op');
    assert.equal((await sbacs.finalize(ok[0].reservationId)).ok, false, 'a released reservation cannot be finalized');
    const again = await sbacs.reserve({ workspaceId: ws, featureKey: 'ai.docs.draft', idempotencyKey: 'again' }); assert.equal(again.ok, true);
    assert.equal((await sbacs.reserve({ workspaceId: ws, featureKey: 'ai.docs.draft', idempotencyKey: 'again' })).replay, true, 'same key = same reservation');
    assert.equal((await sbacs.reserve({ workspaceId: ws, featureKey: 'ai.docs.draft', idempotencyKey: 'nope' })).ok, false);
    for (const r of ok.slice(1)) await sbacs.finalize(r.reservationId); await sbacs.finalize(again.reservationId);
    const u = (await sql(`SELECT used::int, reserved::int FROM portal.subscription_usage WHERE workspace_id=$1 AND feature='ai.docs.draft'`, [ws])).rows[0]; assert.deepEqual(u, { used: 20, reserved: 0 });
  });

  test('an abandoned reservation is given back after it expires; a pro workspace has a higher ceiling than a free one', async () => {
    const { ws } = await newWs(); assert.equal((await sbacs.reserve({ workspaceId: ws, featureKey: 'clips.create', units: 10, idempotencyKey: 'a', ttlMs: 1 })).ok, true);
    assert.equal((await sbacs.reserve({ workspaceId: ws, featureKey: 'clips.create', idempotencyKey: 'b', ttlMs: 60000 })).ok, true, 'the crashed caller\'s units were reclaimed');
    const pro = await newWs('pro'); assert.equal((await sbacs.resolve(db.pool, pro.ws, 'ai.docs.draft')).quota, 1000);
  });

  test('overrides apply until they expire, change nothing for other workspaces, and every change is in the append-only event log', async () => {
    const a = await newWs(), b = await newWs(), admin = crypto.randomUUID();
    await sbacs.setOverride({ workspaceId: a.ws, feature: 'meet.recording', enabled: true, quota: 5, reason: 'pilot customer', actorId: admin });
    assert.equal((await can(a.ws, 'meet.recording')).allowed, true); assert.equal((await can(a.ws, 'meet.recording')).source, 'override'); assert.equal((await can(b.ws, 'meet.recording')).allowed, false);
    await sql(`UPDATE portal.entitlement_overrides SET expires_at = now() - interval '1 second' WHERE workspace_id=$1`, [a.ws]); assert.equal((await can(a.ws, 'meet.recording')).allowed, false);
    const ev = (await sql(`SELECT id, kind, detail FROM portal.entitlement_events WHERE workspace_id=$1`, [a.ws])).rows; assert.equal(ev.length, 1); assert.equal(ev[0].kind, 'override.set'); assert.equal(ev[0].detail.reason, 'pilot customer');
    await assert.rejects(sql(`UPDATE portal.entitlement_events SET kind='x'`), /append-only/); await assert.rejects(sql(`DELETE FROM portal.entitlement_events`), /append-only/); await assert.rejects(sql(`TRUNCATE portal.entitlement_events`), /append-only/);
  });

  test('endpoints: the signed-in workspace sees its own plan and usage; plans are public; the unlisted Starter plan is not offered; no cross-workspace reads', async () => {
    const a = await newWs('pro'), b = await newWs();
    const pl = (await (await fetch(app.base + '/api/v1/subscriptions/plans')).json()).plans;
    assert.deepEqual(pl.map((p) => p.slug), ['basic', 'pro', 'business', 'enterprise']); assert.equal(pl.find((p) => p.slug === 'enterprise').features['phone.pstn'].enabled, false);
    const ca = (await a.c.get('/api/v1/subscriptions/current')).body, cb = (await b.c.get('/api/v1/subscriptions/current')).body;
    assert.equal(ca.plan, 'pro'); assert.equal(cb.plan, 'basic'); assert.equal(ca.subscription.status, 'active');
    const ea = (await a.c.get('/api/v1/subscriptions/entitlements')).body; assert.equal(ea.features['meet.recording'].enabled, true); assert.equal(ea.features['phone.pstn'].enabled, false);
    const eb = (await b.c.get('/api/v1/subscriptions/entitlements')).body; assert.equal(eb.features['meet.recording'].enabled, false);
    await sbacs.reserve({ workspaceId: b.ws, featureKey: 'clips.create', idempotencyKey: 'u1' }); const rid = (await sql(`SELECT id FROM portal.usage_reservations WHERE workspace_id=$1`, [b.ws])).rows[0].id; await sbacs.finalize(rid);
    const ub = (await b.c.get('/api/v1/subscriptions/usage')).body.usage.find((x) => x.feature === 'clips.create'); assert.deepEqual([ub.used, ub.quota], [1, 10]);
    assert.equal((await a.c.get('/api/v1/subscriptions/usage')).body.usage.find((x) => x.feature === 'clips.create'), undefined, 'pro clips are unlimited, so there is no meter');
    const other = await main.mint(); assert.equal((await app.client(other).get('/api/v1/subscriptions/current')).status, 403, 'no membership, no data');
    assert.equal((await fetch(app.base + '/api/v1/subscriptions/current')).status, 401);
  });

  test('migration 012 is re-runnable and its rollback restores the previous catalogue', async () => {
    const f = (...p) => fs.readFileSync(path.join(here, '..', 'sql', ...p), 'utf8'); const d = await freshDatabase(); try {
      await d.pool.query(f('012_sbacs.sql')); await d.pool.query(f('012_sbacs.sql'));
      assert.equal((await d.pool.query(`SELECT count(*)::int n FROM portal.entitlements WHERE feature='meet.recording'`)).rows[0].n, 5);
      await d.pool.query(f('rollback', '012_sbacs.down.sql'));
      assert.equal((await d.pool.query(`SELECT count(*)::int n FROM portal.plans WHERE slug='starter'`)).rows[0].n, 0);
      assert.equal((await d.pool.query(`SELECT plan_slug FROM portal.workspace_effective_plan LIMIT 1`)).rowCount >= 0, true);
      await d.pool.query(f('012_sbacs.sql'));
    } finally { await d.drop(); }
  });
});
