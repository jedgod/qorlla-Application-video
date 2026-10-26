// v4.5 HTTP surface: workspace billing operations (plan change, usage, overage) and the PLATFORM ADMIN console
// (billing overview, refunds, usage prices, sales-inquiry workflow, kill switches, health, metrics).
// Platform admins are named in PLATFORM_ADMIN_USER_IDS (MAIN user ids). Everyone else gets 404 - the console does not advertise itself.
import crypto from 'node:crypto';
import { z } from 'zod';
import { UUID_RE } from '../auth.mjs';
import { BillingError } from './service.mjs';
import { FLAG_KEYS } from '../flags.mjs';
import { OVERAGE_FEATURES } from './overage.mjs';

const BILLING_ROLES = ['owner', 'admin', 'billing'];
const uuid = z.string().regex(UUID_RE);
const SALES_NEXT = { new: ['contacted', 'lost', 'closed'], contacted: ['qualified', 'lost', 'closed'], qualified: ['won', 'lost', 'closed'], won: ['closed'], lost: ['new', 'closed'], closed: ['new'] };

export function registerBillingLaunch(app, { pool, cfg, auth, h, log, billing, launch, flags }) {
  const { member, identity, roles } = auth;
  const billingRoles = roles(...BILLING_ROLES);
  const handle = (fn) => h(async (req, res) => { try { return await fn(req, res); } catch (e) { if (e instanceof BillingError) return res.status(e.status).json({ error: e.message, code: e.code, ...e.extra }); throw e; } });

  // ------------------------------------------------------------------ workspace: plan changes, usage, overage
  const changeBody = z.object({ plan: z.enum(['pro', 'business']), interval: z.enum(['month', 'year']), seats: z.number().int().min(1).max(cfg.billing.maxSeats), idempotency_key: z.string().min(8).max(100).optional() });
  app.post('/api/v1/billing/change-plan/preview', member, billingRoles, handle(async (req, res) => {
    const p = changeBody.parse(req.body); res.set('Cache-Control', 'no-store').json(await launch.previewChange({ workspaceId: req.workspace, plan: p.plan, interval: p.interval, seats: p.seats }));
  }));
  app.post('/api/v1/billing/change-plan', member, billingRoles, handle(async (req, res) => {
    const p = changeBody.parse(req.body); const out = await launch.changePlan({ workspaceId: req.workspace, userId: req.actor, plan: p.plan, interval: p.interval, seats: p.seats, idempotencyKey: p.idempotency_key });
    res.status(out.duplicate ? 200 : 202).json(out);
  }));
  app.get('/api/v1/billing/pending-change', member, billingRoles, handle(async (req, res) => res.set('Cache-Control', 'no-store').json({ change: await launch.pendingChange(req.workspace) })));
  app.delete('/api/v1/billing/change-plan/:id', member, billingRoles, handle(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' }); res.json(await launch.cancelChange(req.workspace, req.params.id));
  }));
  app.get('/api/v1/billing/usage', member, billingRoles, handle(async (req, res) => res.set('Cache-Control', 'no-store').json(await launch.usageSummary(req.workspace))));
  app.put('/api/v1/billing/overage', member, billingRoles, handle(async (req, res) => {
    const p = z.object({ enabled: z.boolean(), accept_terms: z.boolean().optional() }).parse(req.body);
    res.json(await launch.setOverage({ workspaceId: req.workspace, userId: req.actor, enabled: p.enabled, acceptTerms: p.accept_terms === true }));
  }));

  // ------------------------------------------------------------------ platform admin
  const admins = new Set((cfg.platformAdmins || []).map((x) => x.toLowerCase()));
  const adminOnly = (req, res, next) => identity(req, res, (err) => {
    if (err) return next(err);
    if (!admins.has(String(req.actor || '').toLowerCase())) return res.status(404).json({ error: 'Not found' });
    next();
  });
  const A = '/api/v1/admin';
  app.get(`${A}/me`, adminOnly, (req, res) => res.set('Cache-Control', 'no-store').json({ platform_admin: true, billing_available: billing.available() }));

  async function overview() {
    const [subs, mrr, inv, refunds, events, sales, flagsList] = await Promise.all([
      pool.query(`SELECT plan_slug, status, count(*)::int n, COALESCE(sum(seats),0)::int seats FROM portal.subscriptions WHERE plan_slug <> 'basic' GROUP BY 1,2 ORDER BY 1,2`),
      pool.query(`SELECT COALESCE(round(sum(CASE WHEN s.billing_interval='year' THEN pr.amount_cents*s.seats/12.0 ELSE pr.amount_cents*s.seats END)),0)::bigint v
                  FROM portal.subscriptions s JOIN portal.plan_prices pr ON pr.plan_slug=s.plan_slug AND pr.billing_interval=s.billing_interval AND pr.active AND pr.currency='usd' WHERE s.status IN ('active','trialing')`),
      pool.query(`SELECT COALESCE(sum(amount_paid_cents) FILTER (WHERE status IN ('paid','partially_refunded','refunded')),0)::bigint paid, count(*) FILTER (WHERE status='payment_failed')::int failed FROM portal.invoices WHERE created_at > now() - interval '30 days'`),
      pool.query(`SELECT COALESCE(sum(amount_cents),0)::bigint v, count(*)::int n FROM portal.refunds WHERE created_at > now() - interval '30 days'`),
      pool.query(`SELECT outcome, count(*)::int n FROM portal.billing_events WHERE received_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC`),
      pool.query(`SELECT status, count(*)::int n FROM portal.sales_inquiries GROUP BY 1 ORDER BY 1`),
      flags.list()]);
    return { billing_available: billing.available(), billing_unavailable_reasons: billing.available() ? [] : cfg.billing.unavailableReasons, subscriptions: subs.rows,
      mrr_estimate_cents: Number(mrr.rows[0].v), mrr_note: 'Estimated from current list prices x seats of active subscriptions; not accounting-grade revenue.',
      last_30_days: { paid_cents: Number(inv.rows[0].paid), failed_invoices: inv.rows[0].failed, refunded_cents: Number(refunds.rows[0].v), refunds: refunds.rows[0].n },
      events_24h: events.rows, sales_inquiries: sales.rows, flags: flagsList.map((f) => ({ key: f.key, enabled: f.enabled, reason: f.reason, updated_at: f.updated_at })) };
  }
  app.get(`${A}/billing/overview`, adminOnly, h(async (req, res) => res.set('Cache-Control', 'no-store').json(await overview())));

  app.get(`${A}/billing/subscriptions`, adminOnly, h(async (req, res) => {
    const q = z.object({ status: z.enum(['active', 'trialing', 'past_due', 'canceled', 'expired', 'incomplete']).optional(), q: z.string().trim().max(100).optional() }).parse(req.query);
    res.set('Cache-Control', 'no-store').json((await pool.query(`SELECT s.workspace_id, w.name, s.plan_slug, s.status, s.billing_interval, s.seats, s.current_period_end, s.cancel_at_period_end, s.provider_subscription_id
      FROM portal.subscriptions s JOIN portal.workspaces w ON w.id=s.workspace_id WHERE s.plan_slug <> 'basic' AND ($1::text IS NULL OR s.status=$1) AND ($2::text IS NULL OR w.name ILIKE '%'||$2||'%' OR w.id::text=$2) ORDER BY s.updated_at DESC LIMIT 100`, [q.status ?? null, q.q ?? null])).rows);
  }));
  app.get(`${A}/billing/invoices`, adminOnly, h(async (req, res) => {
    const q = z.object({ status: z.enum(['open', 'paid', 'payment_failed', 'void', 'refunded', 'partially_refunded']).optional(), workspace_id: uuid.optional() }).parse(req.query);
    res.set('Cache-Control', 'no-store').json((await pool.query(`SELECT i.id, i.workspace_id, w.name AS workspace_name, i.number, i.status, i.currency, i.amount_paid_cents, i.amount_refunded_cents, i.hosted_invoice_url, i.created_at, (i.provider_payment_intent IS NOT NULL) AS refundable
      FROM portal.invoices i JOIN portal.workspaces w ON w.id=i.workspace_id WHERE ($1::text IS NULL OR i.status=$1) AND ($2::uuid IS NULL OR i.workspace_id=$2) ORDER BY i.created_at DESC LIMIT 100`, [q.status ?? null, q.workspace_id ?? null])).rows);
  }));
  app.get(`${A}/billing/events`, adminOnly, h(async (req, res) => {
    const q = z.object({ outcome: z.string().max(80).optional() }).parse(req.query);
    res.set('Cache-Control', 'no-store').json((await pool.query(`SELECT event_id, type, outcome, received_at, processed_at FROM portal.billing_events WHERE ($1::text IS NULL OR outcome=$1) ORDER BY received_at DESC LIMIT 100`, [q.outcome ?? null])).rows);
  }));
  app.post(`${A}/billing/refunds`, adminOnly, handle(async (req, res) => {
    const p = z.object({ invoice_id: uuid, amount_cents: z.number().int().positive().optional(), reason: z.string().trim().min(3).max(300), idempotency_key: z.string().min(8).max(100) }).parse(req.body);
    const out = await launch.refund({ actor: req.actor, invoiceId: p.invoice_id, amountCents: p.amount_cents, reason: p.reason, idempotencyKey: p.idempotency_key });
    res.status(out.duplicate ? 200 : 201).json(out);
  }));
  app.get(`${A}/billing/refunds`, adminOnly, h(async (req, res) => res.set('Cache-Control', 'no-store').json((await pool.query(`SELECT id, workspace_id, provider_invoice_id, amount_cents, reason, status, error_code, requested_by, created_at FROM portal.refund_requests ORDER BY created_at DESC LIMIT 100`)).rows)));

  app.get(`${A}/billing/usage-prices`, adminOnly, h(async (req, res) => res.set('Cache-Control', 'no-store').json((await pool.query('SELECT usage_feature, unit_amount_cents, currency, active, updated_at FROM portal.usage_prices ORDER BY 1')).rows)));
  app.put(`${A}/billing/usage-prices/:feature`, adminOnly, handle(async (req, res) => {
    if (!OVERAGE_FEATURES.includes(req.params.feature)) return res.status(400).json({ error: 'Unknown usage feature' });
    const p = z.object({ unit_amount_cents: z.number().int().min(1).max(100000), active: z.boolean() }).parse(req.body);
    await pool.query(`INSERT INTO portal.usage_prices(usage_feature,unit_amount_cents,currency,active,updated_by) VALUES($1,$2,'usd',$3,$4) ON CONFLICT (usage_feature) DO UPDATE SET unit_amount_cents=EXCLUDED.unit_amount_cents, active=EXCLUDED.active, updated_by=EXCLUDED.updated_by, updated_at=now()`, [req.params.feature, p.unit_amount_cents, p.active, req.actor]);
    await launch.platformAudit(pool, req.actor, 'billing.usage_price_set', req.params.feature, p); res.json({ updated: true });
  }));
  app.post(`${A}/billing/overage/report`, adminOnly, handle(async (req, res) => { const n = await launch.reportOverage(); await launch.platformAudit(pool, req.actor, 'billing.overage_reported', 'manual', { items: n }); res.json({ invoice_items_created: n }); }));

  // ---- kill switches
  app.get(`${A}/flags`, adminOnly, h(async (req, res) => res.set('Cache-Control', 'no-store').json(await flags.list())));
  app.put(`${A}/flags/:key`, adminOnly, h(async (req, res) => {
    if (!FLAG_KEYS.includes(req.params.key)) return res.status(400).json({ error: 'Unknown flag' });
    const p = z.object({ enabled: z.boolean(), reason: z.string().trim().max(300).optional() }).parse(req.body);
    if (!p.enabled && !p.reason) return res.status(400).json({ error: 'Say why you are switching this off' });
    await flags.set(req.params.key, p.enabled, p.reason, req.actor); await launch.platformAudit(pool, req.actor, p.enabled ? 'flag.on' : 'flag.off', req.params.key, { reason: p.reason });
    log.warn('platform flag changed', { key: req.params.key, enabled: p.enabled, by: req.actor }); res.json({ key: req.params.key, enabled: p.enabled });
  }));

  // ---- Enterprise / sales workflow
  app.get(`${A}/sales-inquiries`, adminOnly, h(async (req, res) => {
    const q = z.object({ status: z.enum(['new', 'contacted', 'qualified', 'won', 'lost', 'closed']).optional() }).parse(req.query);
    res.set('Cache-Control', 'no-store').json((await pool.query(`SELECT id, name, email, company, plan_interest, status, assignee_id, created_at, updated_at, left(message, 200) AS excerpt, (status='new' AND created_at < now() - interval '24 hours') AS overdue
      FROM portal.sales_inquiries WHERE ($1::text IS NULL OR status=$1) ORDER BY (status='new') DESC, created_at DESC LIMIT 200`, [q.status ?? null])).rows);
  }));
  app.get(`${A}/sales-inquiries/:id`, adminOnly, h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const i = (await pool.query('SELECT id, name, email, company, message, plan_interest, status, assignee_id, created_at, updated_at FROM portal.sales_inquiries WHERE id=$1', [req.params.id])).rows[0];
    if (!i) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'no-store').json({ ...i, allowed_next: SALES_NEXT[i.status], notes: (await pool.query('SELECT id, author_id, note, created_at FROM portal.sales_inquiry_notes WHERE inquiry_id=$1 ORDER BY created_at', [i.id])).rows });
  }));
  app.patch(`${A}/sales-inquiries/:id`, adminOnly, h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const p = z.object({ status: z.enum(['new', 'contacted', 'qualified', 'won', 'lost', 'closed']).optional(), assignee_id: uuid.nullable().optional() }).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = (await client.query('SELECT status FROM portal.sales_inquiries WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!cur) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
      if (p.status && p.status !== cur.status && !SALES_NEXT[cur.status].includes(p.status)) { await client.query('ROLLBACK'); return res.status(409).json({ error: `Cannot move from ${cur.status} to ${p.status}`, code: 'bad_transition', allowed: SALES_NEXT[cur.status] }); }
      await client.query(`UPDATE portal.sales_inquiries SET status=COALESCE($2,status), assignee_id=CASE WHEN $3::boolean THEN $4::uuid ELSE assignee_id END, updated_at=now(), updated_by=$5 WHERE id=$1`, [req.params.id, p.status ?? null, p.assignee_id !== undefined, p.assignee_id ?? null, req.actor]);
      await launch.platformAudit(client, req.actor, 'sales.updated', req.params.id, p); await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    res.json({ updated: true });
  }));
  app.post(`${A}/sales-inquiries/:id/notes`, adminOnly, h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const p = z.object({ note: z.string().trim().min(1).max(2000) }).parse(req.body);
    if (!(await pool.query('SELECT 1 FROM portal.sales_inquiries WHERE id=$1', [req.params.id])).rowCount) return res.status(404).json({ error: 'Not found' });
    res.status(201).json((await pool.query('INSERT INTO portal.sales_inquiry_notes(inquiry_id,author_id,note) VALUES($1,$2,$3) RETURNING id, created_at', [req.params.id, req.actor, p.note])).rows[0]);
  }));

  // ---- monitoring: alerts for humans, gauges for scrapers
  async function health() {
    const n = async (sql) => Number((await pool.query(sql)).rows[0].n);
    const [stuck, rejected, pastDue, refunds, changes, meetJobs, phoneJobs, overdue, flagList] = await Promise.all([
      n(`SELECT count(*) n FROM portal.billing_events WHERE processed_at IS NULL AND received_at < now() - interval '10 minutes'`),
      n(`SELECT count(*) n FROM portal.billing_events WHERE received_at > now() - interval '24 hours' AND (outcome LIKE 'rejected%' OR outcome LIKE 'unmatched%')`),
      n(`SELECT count(*) n FROM portal.subscriptions WHERE status='past_due'`),
      n(`SELECT count(*) n FROM portal.refund_requests WHERE status='requested' AND created_at < now() - interval '10 minutes'`),
      n(`SELECT count(*) n FROM portal.plan_changes WHERE status='requested' AND created_at < now() - interval '1 hour'`),
      n(`SELECT count(*) n FROM portal.meeting_ai_jobs WHERE status='queued' AND next_attempt_at < now() - interval '15 minutes'`),
      n(`SELECT count(*) n FROM portal.phone_ai_jobs WHERE status='queued' AND next_attempt_at < now() - interval '15 minutes'`),
      n(`SELECT count(*) n FROM portal.sales_inquiries WHERE status='new' AND created_at < now() - interval '24 hours'`),
      flags.list()]);
    const alerts = [];
    const add = (severity, code, message, count) => alerts.push({ severity, code, message, count });
    if (stuck) add('critical', 'billing_events_stuck', 'Provider events were received but not processed for over 10 minutes', stuck);
    if (rejected) add('critical', 'billing_events_rejected', 'Provider events were rejected or could not be matched in the last 24 hours (possible price mismatch or forged event)', rejected);
    if (refunds) add('warning', 'refund_unconfirmed', 'Refund requests are waiting for provider confirmation', refunds);
    if (changes) add('warning', 'plan_change_unconfirmed', 'Plan changes were sent to the provider but not confirmed', changes);
    if (pastDue) add('warning', 'subscriptions_past_due', 'Subscriptions are past due', pastDue);
    if (meetJobs) add('warning', 'meeting_ai_queue_stalled', 'Meeting AI jobs have been queued for over 15 minutes', meetJobs);
    if (phoneJobs) add('warning', 'phone_ai_queue_stalled', 'Voicemail summary jobs have been queued for over 15 minutes', phoneJobs);
    if (overdue) add('warning', 'sales_inquiries_overdue', 'Sales inquiries have been waiting over 24 hours', overdue);
    for (const f of flagList) if (!f.enabled) add('info', 'flag_off_' + f.key, `Kill switch "${f.key}" is OFF: ${f.reason || 'no reason recorded'}`, 1);
    if (cfg.billing.enabled && !billing.available()) add('info', 'billing_enabled_but_unavailable', 'Billing is enabled but unavailable: ' + cfg.billing.unavailableReasons.join(', '), 1);
    return { status: alerts.some((a) => a.severity === 'critical') ? 'critical' : alerts.some((a) => a.severity === 'warning') ? 'warning' : 'ok', alerts, checked_at: new Date().toISOString() };
  }
  app.get(`${A}/health`, adminOnly, h(async (req, res) => res.set('Cache-Control', 'no-store').json(await health())));

  /** Prometheus text format. Not routed by the public proxy; protected by a bearer token (METRICS_TOKEN) and disabled when none is set. */
  app.get('/internal/metrics', h(async (req, res) => {
    const token = cfg.metricsToken || '';
    const given = String(req.get('authorization') || '').replace(/^Bearer /, '');
    if (!token || given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) return res.status(404).type('text/plain').send('not found\n');
    const lines = [];
    const gauge = (name, help, rows) => { lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`); for (const [labels, v] of rows) lines.push(`${name}${labels ? `{${labels}}` : ''} ${v}`); };
    const q = async (sql) => (await pool.query(sql)).rows;
    gauge('qorlla_subscriptions', 'Subscriptions by plan and status', (await q(`SELECT plan_slug, status, count(*)::int n FROM portal.subscriptions GROUP BY 1,2`)).map((r) => [`plan="${r.plan_slug}",status="${r.status}"`, r.n]));
    gauge('qorlla_billing_events_unprocessed', 'Provider events not yet processed', [['', (await q(`SELECT count(*)::int n FROM portal.billing_events WHERE processed_at IS NULL`))[0].n]]);
    gauge('qorlla_billing_events_rejected_24h', 'Rejected or unmatched provider events in 24h', [['', (await q(`SELECT count(*)::int n FROM portal.billing_events WHERE received_at > now() - interval '24 hours' AND (outcome LIKE 'rejected%' OR outcome LIKE 'unmatched%')`))[0].n]]);
    gauge('qorlla_ai_jobs', 'AI jobs by queue and status', [...(await q(`SELECT status, count(*)::int n FROM portal.meeting_ai_jobs GROUP BY 1`)).map((r) => [`queue="meeting",status="${r.status}"`, r.n]), ...(await q(`SELECT status, count(*)::int n FROM portal.phone_ai_jobs GROUP BY 1`)).map((r) => [`queue="voicemail",status="${r.status}"`, r.n])]);
    gauge('qorlla_ai_oldest_queued_seconds', 'Age of the oldest queued AI job', [['queue="meeting"', Math.round((await q(`SELECT COALESCE(extract(epoch from now()-min(next_attempt_at)),0) s FROM portal.meeting_ai_jobs WHERE status='queued'`))[0].s)], ['queue="voicemail"', Math.round((await q(`SELECT COALESCE(extract(epoch from now()-min(next_attempt_at)),0) s FROM portal.phone_ai_jobs WHERE status='queued'`))[0].s)]]);
    gauge('qorlla_sales_inquiries_new', 'Sales inquiries awaiting first contact', [['', (await q(`SELECT count(*)::int n FROM portal.sales_inquiries WHERE status='new'`))[0].n]]);
    gauge('qorlla_flag_enabled', 'Platform kill switches (1 = feature on)', (await flags.list()).map((f) => [`flag="${f.key}"`, f.enabled ? 1 : 0]));
    gauge('qorlla_billing_available', 'Whether online billing is available', [['', billing.available() ? 1 : 0]]);
    gauge('qorlla_telephony_available', 'Whether telephony is enabled and acknowledged', [['', cfg.telephony?.enabled && cfg.telephony.complianceAck === 'confirmed-numbers-consent-and-regulatory-review' ? 1 : 0]]);
    res.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n');
  }));
}
