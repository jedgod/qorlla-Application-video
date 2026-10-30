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
  test('005 (phone): re-runnable; DB constraints hold; rollback restores the 004 schema; forward again works', async () => {
    const db = await freshDatabase({ migrate: false }); dbs.push(db); const p = db.pool;
    await p.query(sqlFile('002_billing.sql')); await p.query(sqlFile('004_meeting_ai.sql'));
    const before = { tables: await tables(p), usage: (await p.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='ai_usage_events_feature_check'")).rows[0].d };
    await p.query(sqlFile('005_phone.sql')); await p.query(sqlFile('005_phone.sql'));
    for (const t of ['phone_numbers', 'call_sessions', 'call_routes', 'voicemails', 'receptionist_profiles', 'receptionist_calls', 'appointments', 'telephony_events', 'phone_ai_jobs']) assert.ok((await tables(p)).includes(t), t);
    const ws = (await p.query("INSERT INTO portal.workspaces(name) VALUES('Phone') RETURNING id")).rows[0].id; const u = crypto.randomUUID();
    await assert.rejects(p.query("INSERT INTO portal.phone_numbers(workspace_id,e164,created_by) VALUES($1,'12025550100',$2)", [ws, u]), /check/i);
    await p.query("INSERT INTO portal.phone_numbers(workspace_id,e164,created_by) VALUES($1,'+12025550100',$2)", [ws, u]);
    await assert.rejects(p.query("INSERT INTO portal.phone_numbers(workspace_id,e164,created_by) VALUES($1,'+12025550100',$2)", [ws, u]), /duplicate|unique/i, 'a number belongs to one workspace');
    await assert.rejects(p.query("INSERT INTO portal.call_sessions(workspace_id,direction,status) VALUES($1,'sideways','ringing')", [ws]), /check/i);
    await p.query("INSERT INTO portal.call_sessions(workspace_id,direction,provider_call_sid) VALUES($1,'inbound','CA1')", [ws]);
    await assert.rejects(p.query("INSERT INTO portal.call_sessions(workspace_id,direction,provider_call_sid) VALUES($1,'inbound','CA1')", [ws]), /duplicate|unique/i, 'one row per provider call');
    await assert.rejects(p.query("INSERT INTO portal.appointments(workspace_id,title,starts_at,ends_at,attendee_name) VALUES($1,'x',now(),now()-interval '1 hour','n')", [ws]), /check/i);
    await p.query("INSERT INTO portal.ai_usage_events(workspace_id,feature,units,idempotency_key) VALUES($1,'phone_minutes',2,'k1')", [ws]);
    await p.query(sqlFile('rollback', '005_phone.down.sql')); await p.query(sqlFile('rollback', '005_phone.down.sql'));
    assert.deepEqual({ tables: await tables(p), usage: (await p.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='ai_usage_events_feature_check'")).rows[0].d }, before);
    assert.equal(Number((await p.query("SELECT count(*) FROM portal.entitlements WHERE feature LIKE 'phone.%'")).rows[0].count), 0);
    await p.query(sqlFile('005_phone.sql')); assert.ok((await tables(p)).includes('voicemails'));
  });
  test('006 (notes, documents, assistant): legacy notes stay workspace-visible; re-runnable; rollback keeps the notes and restores the 005 schema', async () => {
    const db = await freshDatabase({ migrate: false }); dbs.push(db); const p = db.pool;
    await p.query(sqlFile('002_billing.sql')); await p.query(sqlFile('004_meeting_ai.sql')); await p.query(sqlFile('005_phone.sql'));
    const snapshot = async () => ({ tables: await tables(p), notes: await cols(p, 'notes'), usage: (await p.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='ai_usage_events_feature_check'")).rows[0].d });
    const before = await snapshot();
    const ws = (await p.query("INSERT INTO portal.workspaces(name) VALUES('Legacy') RETURNING id")).rows[0].id; const u = crypto.randomUUID();
    const note = (await p.query("INSERT INTO portal.notes(workspace_id,author_id,title,body) VALUES($1,$2,'Old note','pelican body') RETURNING id", [ws, u])).rows[0].id;
    await p.query(sqlFile('006_workspace_tools.sql')); await p.query(sqlFile('006_workspace_tools.sql'));
    assert.deepEqual((await p.query('SELECT visibility, source, pinned FROM portal.notes WHERE id=$1', [note])).rows[0], { visibility: 'workspace', source: 'manual', pinned: false }, 'notes that pre-date 4.4 keep the visibility they always had');
    assert.equal((await p.query("SELECT count(*)::int n FROM portal.notes WHERE search @@ to_tsquery('simple','pelican')")).rows[0].n, 1);
    for (const t of ['notebooks', 'documents', 'document_versions', 'document_permissions', 'assistant_threads', 'assistant_messages', 'assistant_tasks']) assert.ok((await tables(p)).includes(t), t);
    await assert.rejects(p.query("INSERT INTO portal.notes(workspace_id,author_id,title,visibility) VALUES($1,$2,'x','everyone')", [ws, u]), /check/i);
    await assert.rejects(p.query("INSERT INTO portal.documents(workspace_id,owner_id,kind,title) VALUES($1,$2,'video','x')", [ws, u]), /check/i);
    await assert.rejects(p.query("INSERT INTO portal.assistant_tasks(workspace_id,thread_id,user_id,kind,title,payload) VALUES($1,gen_random_uuid(),$2,'delete_everything','x','{}')", [ws, u]), /check|foreign key/i);
    const d = (await p.query("INSERT INTO portal.documents(workspace_id,owner_id,kind,title,current_version) VALUES($1,$2,'doc','Doc',1) RETURNING id", [ws, u])).rows[0].id;
    await p.query("INSERT INTO portal.document_versions(document_id,version_no,content,created_by) VALUES($1,1,'{}',$2)", [d, u]);
    await assert.rejects(p.query("INSERT INTO portal.document_versions(document_id,version_no,content,created_by) VALUES($1,1,'{}',$2)", [d, u]), /duplicate|unique/i, 'a version number is never reused');
    await p.query(sqlFile('rollback', '006_workspace_tools.down.sql')); await p.query(sqlFile('rollback', '006_workspace_tools.down.sql'));
    assert.deepEqual(await snapshot(), before);
    assert.equal((await p.query('SELECT title FROM portal.notes WHERE id=$1', [note])).rows[0].title, 'Old note');
    assert.equal(Number((await p.query("SELECT count(*) FROM portal.entitlements WHERE feature IN ('documents.max','ai.assistant_messages_per_month')")).rows[0].count), 0);
    await p.query(sqlFile('006_workspace_tools.sql')); assert.ok((await tables(p)).includes('documents'));
  });
  test('007 (billing launch): re-runnable; constraints hold; legacy sales statuses survive; rollback restores the 006 schema and keeps invoices and refunds', async () => {
    const db = await freshDatabase({ migrate: false }); dbs.push(db); const p = db.pool;
    for (const f of ['002_billing.sql', '004_meeting_ai.sql', '005_phone.sql', '006_workspace_tools.sql']) await p.query(sqlFile(f));
    const snapshot = async () => ({ tables: await tables(p), invoices: await cols(p, 'invoices'), sales: await cols(p, 'sales_inquiries') });
    const before = await snapshot();
    const ws = (await p.query("INSERT INTO portal.workspaces(name) VALUES('Billing') RETURNING id")).rows[0].id; const u = crypto.randomUUID();
    await p.query("INSERT INTO portal.sales_inquiries(name,email,message,status) VALUES('Old','o@x.co','hi','contacted')");
    const inv = (await p.query("INSERT INTO portal.invoices(workspace_id,provider,provider_invoice_id,status,currency,amount_due_cents,amount_paid_cents) VALUES($1,'stripe','in_1','paid','usd',100,100) RETURNING id", [ws])).rows[0].id;
    await p.query(sqlFile('007_billing_launch.sql')); await p.query(sqlFile('007_billing_launch.sql'));
    for (const t of ['plan_changes', 'refund_requests', 'usage_prices', 'usage_overage_events', 'usage_invoice_items', 'workspace_billing_settings', 'platform_flags', 'platform_audit', 'sales_inquiry_notes']) assert.ok((await tables(p)).includes(t), t);
    assert.equal(Number((await p.query('SELECT count(*) FROM portal.platform_flags WHERE enabled')).rows[0].count), 4, 'every switch starts ON');
    assert.equal(Number((await p.query('SELECT count(*) FROM portal.usage_prices')).rows[0].count), 0, 'no usage price is published by default');
    assert.equal((await p.query("SELECT status FROM portal.sales_inquiries WHERE email='o@x.co'")).rows[0].status, 'contacted');
    await assert.rejects(p.query("INSERT INTO portal.sales_inquiries(name,email,message,status) VALUES('x','x@x.co','m','hot')"), /check/i);
    await assert.rejects(p.query("INSERT INTO portal.platform_flags(key) VALUES ('everything')"), /check/i);
    await assert.rejects(p.query("INSERT INTO portal.usage_prices(usage_feature,unit_amount_cents,active) VALUES ('meeting_report',0,true)"), /check/i);
    const change = (status) => p.query("INSERT INTO portal.plan_changes(workspace_id,provider_subscription_id,kind,from_plan,from_interval,from_seats,to_plan,to_interval,to_seats,unit_amount_cents,currency,status,effective_at,requested_by) VALUES($1,'sub_1','upgrade','pro','month',1,'business','month',1,2199,'usd',$2,now(),$3)", [ws, status, u]);
    await change('requested'); await assert.rejects(change('scheduled'), /plan_changes_one_open/, 'one open change per workspace'); await p.query("UPDATE portal.plan_changes SET status='applied'"); await change('requested');
    await p.query("UPDATE portal.sales_inquiries SET status='won'");
    await p.query(sqlFile('rollback', '007_billing_launch.down.sql')); await p.query(sqlFile('rollback', '007_billing_launch.down.sql'));
    assert.deepEqual(await snapshot(), before);
    assert.equal((await p.query("SELECT status FROM portal.sales_inquiries WHERE email='o@x.co'")).rows[0].status, 'closed', 'workflow states collapse to closed');
    assert.equal((await p.query('SELECT amount_paid_cents FROM portal.invoices WHERE id=$1', [inv])).rows[0].amount_paid_cents, 100);
    await p.query(sqlFile('007_billing_launch.sql')); assert.ok((await tables(p)).includes('plan_changes'));
  });
  test('008 (enterprise operations): re-runnable; the database enforces two-person refunds, append-only history and refuses "issued"/"active" states; rollback drops only ops tables and keeps invoices, refunds and billing requests', async () => {
    const db = await freshDatabase(); dbs.push(db); const p = db.pool, ops = (all) => all.filter((t) => t.startsWith('ops_'));
    await p.query(sqlFile('rollback', '008_enterprise_ops.down.sql')); const base = await tables(p); assert.deepEqual(ops(base), []);   // the helper already applied 008: start from the pre-008 schema
    await p.query(sqlFile('008_enterprise_ops.sql')); await p.query(sqlFile('008_enterprise_ops.sql'));
    for (const t of ['ops_staff', 'ops_tickets', 'ops_ticket_events', 'ops_ticket_messages', 'ops_shifts', 'ops_time_entries', 'ops_leave_requests', 'ops_refund_requests', 'ops_outbox', 'ops_audit_log', 'ops_number_requests', 'ops_external_call_requests']) assert.ok((await tables(p)).includes(t), t);
    const ws = (await p.query("INSERT INTO portal.workspaces(name) VALUES('Ops') RETURNING id")).rows[0].id, [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const inv = (await p.query("INSERT INTO portal.invoices(workspace_id,provider,provider_invoice_id,status,currency,amount_due_cents,amount_paid_cents,provider_payment_intent) VALUES($1,'stripe','in_ops','paid','usd',500,500,'pi_1') RETURNING id", [ws])).rows[0].id;
    await p.query("INSERT INTO portal.refund_requests(workspace_id,provider_invoice_id,amount_cents,reason,requested_by,idempotency_key) VALUES($1,'in_ops',100,'billing own',$2,'k-billing-1')", [ws, a]);
    await p.query("INSERT INTO portal.refunds(workspace_id,provider,provider_refund_id,provider_invoice_id,amount_cents,currency,reason) VALUES($1,'stripe','re_1','in_ops',100,'usd','x')", [ws]);
    const r = (await p.query("INSERT INTO portal.ops_refund_requests(invoice_id,amount_cents,reason,requested_by,idempotency_key) VALUES($1,100,'because',$2,'k-ops-1') RETURNING id", [inv, a])).rows[0].id;
    await assert.rejects(p.query("UPDATE portal.ops_refund_requests SET status='approved', approved_by=requested_by WHERE id=$1", [r]), /check/i, 'two people');
    await assert.rejects(p.query("UPDATE portal.ops_refund_requests SET status='executing' WHERE id=$1", [r]), /must be approved/);
    await assert.rejects(p.query("UPDATE portal.ops_refund_requests SET amount_cents=999 WHERE id=$1", [r]), /cannot be altered/);
    await p.query("UPDATE portal.ops_refund_requests SET status='approved', approved_by=$2 WHERE id=$1", [r, b]); await assert.rejects(p.query("UPDATE portal.ops_refund_requests SET status='rejected' WHERE id=$1", [r]), /only start executing/);
    await p.query("UPDATE portal.ops_refund_requests SET status='executing' WHERE id=$1", [r]); await p.query("UPDATE portal.ops_refund_requests SET status='succeeded' WHERE id=$1", [r]); await assert.rejects(p.query("UPDATE portal.ops_refund_requests SET status='approved' WHERE id=$1", [r]), /already succeeded/);
    await assert.rejects(p.query("INSERT INTO portal.ops_number_requests(customer_id,country,range_prefix,requested_by,status) VALUES($1,'GB','0770090',$1,'issued')", [c]), /check/i); await assert.rejects(p.query("INSERT INTO portal.ops_external_call_requests(customer_id,plan_code,requested_by,status) VALUES($1,'X1',$1,'active')", [c]), /check/i);
    await p.query("INSERT INTO portal.ops_audit_log(actor_id,action,resource_type,resource_id) VALUES($1,'x','x','x')", [a]); await assert.rejects(p.query("UPDATE portal.ops_audit_log SET action='y'"), /append-only/); await assert.rejects(p.query('TRUNCATE portal.ops_audit_log'), /append-only/);
    await p.query(sqlFile('rollback', '008_enterprise_ops.down.sql')); await p.query(sqlFile('rollback', '008_enterprise_ops.down.sql'));
    assert.deepEqual(await tables(p), base, 'only the ops tables are gone'); assert.equal((await p.query('SELECT amount_paid_cents FROM portal.invoices WHERE id=$1', [inv])).rows[0].amount_paid_cents, 500);
    assert.equal(Number((await p.query('SELECT count(*) FROM portal.refund_requests')).rows[0].count), 1); assert.equal(Number((await p.query('SELECT count(*) FROM portal.refunds')).rows[0].count), 1, 'the billing authority keeps its records');
    await p.query(sqlFile('008_enterprise_ops.sql')); assert.ok((await tables(p)).includes('ops_staff'));
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
