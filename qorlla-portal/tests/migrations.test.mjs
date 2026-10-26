import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { freshDatabase, here } from './helpers.mjs';

const sqlFile = (...p) => fs.readFileSync(path.join(here, '..', 'sql', ...p), 'utf8');
const tables = async (pool) => (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='portal' ORDER BY 1`)).rows.map((r) => r.table_name);
const cols = async (pool, t) => (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='portal' AND table_name=$1 ORDER BY 1`, [t])).rows.map((r) => r.column_name);

describe('PostgreSQL migration and rollback', () => {
  const dbs = []; after(async () => { for (const d of dbs) await d.drop(); });

  test('001 -> 002 is idempotent (safe to re-run) and seeds the authoritative catalogue', async () => {
    const db = await freshDatabase(); dbs.push(db);
    await db.pool.query(sqlFile('002_billing.sql')); await db.pool.query(sqlFile('002_billing.sql')); await db.pool.query(sqlFile('001_portal.sql'));
    const prices = (await db.pool.query(`SELECT plan_slug,billing_interval,amount_cents FROM portal.plan_prices ORDER BY 1,2`)).rows;
    assert.deepEqual(prices, [{ plan_slug: 'business', billing_interval: 'month', amount_cents: 2199 }, { plan_slug: 'business', billing_interval: 'year', amount_cents: 21996 }, { plan_slug: 'pro', billing_interval: 'month', amount_cents: 1699 }, { plan_slug: 'pro', billing_interval: 'year', amount_cents: 17988 }]);
    assert.equal(Number((await db.pool.query(`SELECT count(*) FROM portal.entitlements WHERE feature='notes.max'`)).rows[0].count), 4);
  });
  test('rollback restores the v4.0/4.1 schema and keeps pre-existing business data; re-applying works', async () => {
    const db = await freshDatabase({ migrate: false }); dbs.push(db); const p = db.pool;
    const before = { tables: await tables(p), subs: await cols(p, 'subscriptions'), plans: await cols(p, 'plans') };
    // data that exists BEFORE the migration must survive up and down
    const ws = (await p.query(`INSERT INTO portal.workspaces(name) VALUES('Legacy') RETURNING id`)).rows[0].id; const [u1, u2] = [crypto.randomUUID(), crypto.randomUUID()];
    await p.query(`INSERT INTO portal.members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')`, [ws, u1, u2]);
    await p.query(`INSERT INTO portal.subscriptions(workspace_id,plan_slug,status) VALUES($1,'pro','active')`, [ws]);
    await p.query(`INSERT INTO portal.notes(workspace_id,author_id,title) VALUES($1,$2,'keep me')`, [ws, u1]);
    await p.query(sqlFile('002_billing.sql'));
    await p.query(`UPDATE portal.members SET role='billing' WHERE user_id=$1`, [u2]);
    assert.ok((await tables(p)).includes('invoices')); assert.ok((await cols(p, 'subscriptions')).includes('provider_subscription_id'));
    assert.equal((await p.query(`SELECT plan_slug FROM portal.workspace_effective_plan WHERE workspace_id=$1`, [ws])).rows[0].plan_slug, 'pro');
    await p.query(sqlFile('rollback', '002_billing.down.sql'));
    assert.deepEqual(await tables(p), before.tables); assert.deepEqual(await cols(p, 'subscriptions'), before.subs); assert.deepEqual(await cols(p, 'plans'), before.plans);
    assert.equal((await p.query(`SELECT role FROM portal.members WHERE user_id=$1`, [u2])).rows[0].role, 'member', 'billing role downgraded, not lost');
    assert.equal((await p.query(`SELECT plan_slug,status FROM portal.subscriptions WHERE workspace_id=$1`, [ws])).rows[0].plan_slug, 'pro');
    assert.equal((await p.query(`SELECT title FROM portal.notes WHERE workspace_id=$1`, [ws])).rows[0].title, 'keep me');
    await assert.rejects(p.query(`INSERT INTO portal.members(workspace_id,user_id,role) VALUES($1,$2,'billing')`, [ws, crypto.randomUUID()]), /members_role_check/, 'old constraint is back');
    await p.query(sqlFile('002_billing.sql'));                                    // and forward again
    assert.ok((await tables(p)).includes('billing_events')); await p.query(sqlFile('rollback', '002_billing.down.sql')); await p.query(sqlFile('rollback', '002_billing.down.sql'));
  });
  test('004 (AI meeting intelligence): re-runnable; rollback restores the earlier schema and keeps data that pre-dates it', async () => {
    const db = await freshDatabase({ migrate: false }); dbs.push(db); const p = db.pool;
    await p.query(sqlFile('002_billing.sql'));
    const snapshot = async () => ({ tables: await tables(p), reports: await cols(p, 'meeting_reports'), shares: await cols(p, 'report_shares') });
    const before = await snapshot();
    const ws = (await p.query(`INSERT INTO portal.workspaces(name) VALUES('Legacy') RETURNING id`)).rows[0].id; const u = crypto.randomUUID();
    const rep = (await p.query(`INSERT INTO portal.meeting_reports(workspace_id,external_meeting_id,title,summary) VALUES($1,'legacy-1','Old report','old summary') RETURNING id`, [ws])).rows[0].id;
    await p.query(`INSERT INTO portal.report_shares(report_id,workspace_id,recipient_email,created_by) VALUES($1,$2,'a@b.co',$3)`, [rep, ws, u]);
    await p.query(sqlFile('004_meeting_ai.sql')); await p.query(sqlFile('004_meeting_ai.sql'));
    const legacy = (await p.query('SELECT status, visibility, decisions FROM portal.meeting_reports WHERE id=$1', [rep])).rows[0]; assert.deepEqual(legacy, { status: 'final', visibility: 'restricted', decisions: [] });
    assert.ok((await p.query('SELECT revoked_at FROM portal.report_shares WHERE report_id=$1', [rep])).rows[0].revoked_at, 'inert pre-4.2 shares are retired, not reinterpreted');
    for (const t of ['meeting_ai_consents', 'meeting_ai_jobs', 'meeting_transcripts', 'meeting_action_items', 'ai_usage_events']) assert.ok((await tables(p)).includes(t), t);
    // the share-shape rule: a share is either a member grant or a bearer link with a hash and an expiry - nothing in between
    await assert.rejects(p.query(`INSERT INTO portal.report_shares(report_id,workspace_id,kind,created_by) VALUES($1,$2,'link',$3)`, [rep, ws, u]), /report_shares_shape/);
    await assert.rejects(p.query(`INSERT INTO portal.meeting_ai_consents(workspace_id,meet_meeting_id,scope,notice_version,notice_text,granted_by) VALUES($1,$2,'everything','v1','x',$3)`, [ws, crypto.randomUUID(), u]), /check/i);
    const m = crypto.randomUUID(); const ins = () => p.query(`INSERT INTO portal.meeting_ai_consents(workspace_id,meet_meeting_id,scope,notice_version,notice_text,granted_by) VALUES($1,$2,'summary','v1','x',$3)`, [ws, m, u]);
    await ins(); await assert.rejects(ins(), /meeting_ai_consent_active_uq/, 'one ACTIVE consent per meeting and scope'); await p.query(`UPDATE portal.meeting_ai_consents SET revoked_at=now()`); await ins();
    await p.query(sqlFile('rollback', '004_meeting_ai.down.sql')); await p.query(sqlFile('rollback', '004_meeting_ai.down.sql'));
    assert.deepEqual(await snapshot(), before);
    assert.equal((await p.query('SELECT title FROM portal.meeting_reports WHERE id=$1', [rep])).rows[0].title, 'Old report'); assert.equal((await p.query('SELECT recipient_email FROM portal.report_shares WHERE report_id=$1', [rep])).rows[0].recipient_email, 'a@b.co');
    assert.equal(Number((await p.query(`SELECT count(*) FROM portal.entitlements WHERE feature='ai.meeting_reports_per_month'`)).rows[0].count), 0);
    await p.query(sqlFile('004_meeting_ai.sql')); assert.ok((await tables(p)).includes('meeting_ai_jobs'));
  });
  test('004 refuses to run without the Meet directory view (clear error, no half-applied schema)', async () => {
    const db = await freshDatabase({ migrate: false }); dbs.push(db); await db.pool.query(sqlFile('002_billing.sql'));
    await db.pool.query('DROP VIEW public.portal_meeting_directory');
    await assert.rejects(db.pool.query(sqlFile('004_meeting_ai.sql')), /006_meeting_directory/);
    assert.ok(!(await tables(db.pool)).includes('meeting_ai_jobs'));
  });
  test('database constraints block bad billing data (defence in depth behind the API)', async () => {
    const db = await freshDatabase(); dbs.push(db); const p = db.pool;
    await assert.rejects(p.query(`INSERT INTO portal.plan_prices(plan_slug,billing_interval,amount_cents) VALUES('pro','week',100)`), /check/i);
    await assert.rejects(p.query(`INSERT INTO portal.plan_prices(plan_slug,billing_interval,amount_cents) VALUES('pro','month',0)`), /check/i);
    await assert.rejects(p.query(`INSERT INTO portal.plan_prices(plan_slug,billing_interval,amount_cents) VALUES('nope','month',100)`), /foreign key/i);
    const ws = (await p.query(`INSERT INTO portal.workspaces(name) VALUES('x') RETURNING id`)).rows[0].id;
    await assert.rejects(p.query(`INSERT INTO portal.subscriptions(workspace_id,plan_slug,status) VALUES($1,'pro','paid-ish')`, [ws]), /subscriptions_status_check/);
    await p.query(`INSERT INTO portal.billing_events(provider,event_id,type,provider_created_at,payload) VALUES('stripe','evt_1','x',now(),'{}')`);
    await assert.rejects(p.query(`INSERT INTO portal.billing_events(provider,event_id,type,provider_created_at,payload) VALUES('stripe','evt_1','x',now(),'{}')`), /duplicate key/, 'an event id can only ever be stored once');
  });
});
