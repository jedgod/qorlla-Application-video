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
