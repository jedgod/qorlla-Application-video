// Express application factory (kept separate from process start-up so tests can run it against a disposable PostgreSQL).
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { createAuth, UUID_RE } from './auth.mjs';
import { createLogger, requestLogger } from './log.mjs';
import { createBillingService, BillingError } from './billing/service.mjs';
import { createStripe } from './billing/stripe.mjs';
import { PlanLimitError, entitlementsFor, quotaFor, withWorkspaceLock } from './entitlements.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ALL_ROLES = ['owner', 'admin', 'billing', 'member'];
const MANAGE = ['owner', 'admin'];
const BILLING = ['owner', 'admin', 'billing'];

export function createApp({ pool, cfg, jwks, fetchImpl = fetch, log = createLogger(), now = () => Date.now(), stripe: stripeOverride } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxyHops);
  app.use(requestLogger(log));
  app.use(helmet({
    contentSecurityPolicy: { useDefaults: false, directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"],
      fontSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"] } },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
  }));

  const stripe = stripeOverride || (cfg.billing.available ? createStripe({ secretKey: cfg.billing.secretKey, webhookSecret: cfg.billing.webhookSecret, apiBase: cfg.billing.apiBase, fetchImpl, now }) : null);
  const billing = createBillingService({ pool, stripe, cfg, log, now });
  const auth = createAuth({ cfg, pool, jwks, fetchImpl, log, now });
  const { identity, member, roles } = auth;

  // ---- webhook FIRST: it needs the raw bytes, and its authenticity is the provider signature (no cookies, no CSRF) ----
  app.post('/api/v1/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), h(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const out = await billing.handleWebhook(req.body, req.get('stripe-signature'));
      res.json({ received: true, duplicate: !!out.duplicate });
    } catch (e) {
      if (e instanceof BillingError) return res.status(e.status).json({ error: e.code });
      log.error('webhook processing failed', { err: e.message });
      res.status(500).json({ error: 'processing_failed' }); // non-2xx => the provider retries
    }
  }));

  app.use(express.json({ limit: '128kb' }));
  app.use('/app/assets', express.static(path.join(root, 'assets'), { index: false, maxAge: '5m' }));

  // ---- public ----
  app.get('/api/v1/health', h(async (req, res) => {
    try { await pool.query('SELECT 1'); res.json({ status: 'ok', auth: cfg.authConfigured ? 'configured' : 'not_configured', billing: billing.available() ? 'available' : 'unavailable' }); }
    catch { res.status(503).json({ status: 'degraded' }); }
  }));
  app.get('/api/v1/products', h(async (req, res) => res.json((await pool.query('SELECT slug,name,description,category FROM portal.products WHERE enabled=true ORDER BY name')).rows)));
  app.get('/api/v1/plans', h(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await billing.catalog()); }));

  const inquiryLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: cfg.salesLimit ?? 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests. Please try again later.' } });
  app.post('/api/v1/sales-inquiries', inquiryLimiter, h(async (req, res) => {
    // Browser form: same-origin only. (A script elsewhere can still post, hence validation + rate limit + honeypot.)
    if (cfg.origin && req.get('origin') && req.get('origin') !== cfg.origin) return res.status(403).json({ error: 'Origin rejected' });
    const p = z.object({
      name: z.string().trim().min(1).max(120), email: z.string().trim().toLowerCase().email().max(200),
      company: z.string().trim().max(160).optional().default(''), message: z.string().trim().min(5).max(4000),
      plan_interest: z.enum(['basic', 'pro', 'business', 'enterprise']).optional(), website: z.string().max(0).optional().default('')
    }).parse(req.body);
    if (p.website) return res.status(201).json({ id: crypto.randomUUID() }); // honeypot: pretend success, store nothing
    const ipHash = crypto.createHash('sha256').update(cfg.salesIpPepper + '|' + (req.ip || '')).digest('hex');
    const r = await pool.query('INSERT INTO portal.sales_inquiries(name,email,company,message,plan_interest,source_ip_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [p.name, p.email, p.company || null, p.message, p.plan_interest || 'enterprise', ipHash]);
    log.info('sales inquiry received', { inquiry_id: r.rows[0].id });
    res.status(201).json({ id: r.rows[0].id });
  }));

  // ---- identity-only (no workspace needed): who am I / create my first workspace ----
  app.get('/api/v1/me', identity, h(async (req, res) => {
    const rows = (await pool.query('SELECT m.workspace_id,w.name,m.role FROM portal.members m JOIN portal.workspaces w ON w.id=m.workspace_id WHERE m.user_id=$1 ORDER BY w.created_at,w.id', [req.actor])).rows;
    res.set('Cache-Control', 'no-store').json({ user_id: req.actor, workspaces: rows });
  }));
  app.post('/api/v1/workspaces', identity, h(async (req, res) => {
    const p = z.object({ name: z.string().trim().min(1).max(120).default('My workspace') }).parse(req.body || {});
    const owned = Number((await pool.query(`SELECT count(*) FROM portal.members WHERE user_id=$1 AND role='owner'`, [req.actor])).rows[0].count);
    if (owned >= 5) return res.status(409).json({ error: 'Workspace limit reached' });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const ws = (await c.query('INSERT INTO portal.workspaces(name) VALUES($1) RETURNING id,name', [p.name])).rows[0];
      await c.query(`INSERT INTO portal.members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [ws.id, req.actor]);
      await c.query(`INSERT INTO portal.subscriptions(workspace_id,plan_slug,status) VALUES($1,'basic','active')`, [ws.id]);
      await c.query(`INSERT INTO portal.audit_events(workspace_id,actor_id,action,object_id) VALUES($1,$2,'workspace.created',$1)`, [ws.id, req.actor]);
      await c.query('COMMIT');
      res.status(201).json({ workspace_id: ws.id, name: ws.name, role: 'owner' });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));

  // ---- workspace-scoped (identity + membership; every query below is filtered by req.workspace) ----
  app.get('/api/v1/session', member, (req, res) => res.set('Cache-Control', 'no-store').json({ user_id: req.actor, workspace_id: req.workspace, role: req.role }));
  app.get('/api/v1/workspaces', identity, h(async (req, res) => res.set('Cache-Control', 'no-store').json((await pool.query('SELECT m.workspace_id,w.name,m.role FROM portal.members m JOIN portal.workspaces w ON w.id=m.workspace_id WHERE m.user_id=$1 ORDER BY w.name', [req.actor])).rows)));
  app.get('/api/v1/workspace', member, h(async (req, res) => {
    const q = await pool.query('SELECT w.id,w.name,e.plan_slug AS plan,s.status AS subscription_status FROM portal.workspaces w JOIN portal.workspace_effective_plan e ON e.workspace_id=w.id LEFT JOIN portal.subscriptions s ON s.workspace_id=w.id WHERE w.id=$1', [req.workspace]);
    res.json({ ...q.rows[0], role: req.role });
  }));
  app.patch('/api/v1/workspace', member, roles(...MANAGE), h(async (req, res) => {
    const p = z.object({ name: z.string().trim().min(1).max(120) }).parse(req.body);
    await pool.query('UPDATE portal.workspaces SET name=$2 WHERE id=$1', [req.workspace, p.name]);
    await pool.query(`INSERT INTO portal.audit_events(workspace_id,actor_id,action,object_id) VALUES($1,$2,'workspace.renamed',$1)`, [req.workspace, req.actor]);
    res.json({ id: req.workspace, name: p.name });
  }));

  // members
  app.get('/api/v1/members', member, h(async (req, res) => res.json((await pool.query('SELECT user_id,role FROM portal.members WHERE workspace_id=$1 ORDER BY role,user_id', [req.workspace])).rows)));
  app.post('/api/v1/members', member, roles(...MANAGE), h(async (req, res) => {
    const p = z.object({ user_id: z.string().regex(UUID_RE), role: z.enum(['admin', 'billing', 'member']) }).parse(req.body);
    const out = await withWorkspaceLock(pool, req.workspace, async (c) => {
      const q = await quotaFor(c, req.workspace, 'members.max');
      const n = Number((await c.query('SELECT count(*) FROM portal.members WHERE workspace_id=$1', [req.workspace])).rows[0].count);
      if (q.quota !== null && n >= q.quota) throw new PlanLimitError('members.max', q.quota, q.plan);
      const r = await c.query('INSERT INTO portal.members(workspace_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id,role', [req.workspace, p.user_id.toLowerCase(), p.role]);
      if (r.rowCount) await c.query(`INSERT INTO portal.audit_events(workspace_id,actor_id,action,object_id) VALUES($1,$2,'member.added',$3)`, [req.workspace, req.actor, p.user_id]);
      return r.rows[0];
    });
    if (!out) return res.status(409).json({ error: 'Already a member' });
    res.status(201).json(out);
  }));
  app.patch('/api/v1/members/:uid', member, roles('owner'), h(async (req, res) => {
    if (!UUID_RE.test(req.params.uid)) return res.status(400).json({ error: 'Invalid user' });
    const p = z.object({ role: z.enum(['owner', 'admin', 'billing', 'member']) }).parse(req.body);
    const out = await withWorkspaceLock(pool, req.workspace, async (c) => {
      const cur = (await c.query('SELECT role FROM portal.members WHERE workspace_id=$1 AND user_id=$2', [req.workspace, req.params.uid.toLowerCase()])).rows[0];
      if (!cur) return null;
      if (cur.role === 'owner' && p.role !== 'owner') {
        const owners = Number((await c.query(`SELECT count(*) FROM portal.members WHERE workspace_id=$1 AND role='owner'`, [req.workspace])).rows[0].count);
        if (owners <= 1) throw Object.assign(new Error('last owner'), { status: 409, code: 'last_owner' });
      }
      await c.query('UPDATE portal.members SET role=$3 WHERE workspace_id=$1 AND user_id=$2', [req.workspace, req.params.uid.toLowerCase(), p.role]);
      await c.query(`INSERT INTO portal.audit_events(workspace_id,actor_id,action,object_id) VALUES($1,$2,'member.role_changed',$3)`, [req.workspace, req.actor, req.params.uid]);
      return { user_id: req.params.uid.toLowerCase(), role: p.role };
    });
    if (!out) return res.status(404).json({ error: 'Not a member' });
    res.json(out);
  }));
  app.delete('/api/v1/members/:uid', member, roles(...MANAGE), h(async (req, res) => {
    if (!UUID_RE.test(req.params.uid)) return res.status(400).json({ error: 'Invalid user' });
    const out = await withWorkspaceLock(pool, req.workspace, async (c) => {
      const cur = (await c.query('SELECT role FROM portal.members WHERE workspace_id=$1 AND user_id=$2', [req.workspace, req.params.uid.toLowerCase()])).rows[0];
      if (!cur) return 404;
      if (cur.role === 'owner') {
        if (req.role !== 'owner') return 403;
        const owners = Number((await c.query(`SELECT count(*) FROM portal.members WHERE workspace_id=$1 AND role='owner'`, [req.workspace])).rows[0].count);
        if (owners <= 1) return 409;
      }
      await c.query('DELETE FROM portal.members WHERE workspace_id=$1 AND user_id=$2', [req.workspace, req.params.uid.toLowerCase()]);
      await c.query(`INSERT INTO portal.audit_events(workspace_id,actor_id,action,object_id) VALUES($1,$2,'member.removed',$3)`, [req.workspace, req.actor, req.params.uid]);
      return 204;
    });
    res.status(out).end();
  }));

  // entitlements + usage
  app.get('/api/v1/entitlements', member, h(async (req, res) => res.set('Cache-Control', 'no-store').json(await entitlementsFor(pool, req.workspace))));
  app.get('/api/v1/usage', member, h(async (req, res) => res.json((await pool.query(`SELECT feature,SUM(units)::int AS units FROM portal.usage_events WHERE workspace_id=$1 AND created_at >= date_trunc('month', now()) GROUP BY feature`, [req.workspace])).rows)));
  app.post('/api/v1/usage', member, h(async (req, res) => {
    const p = z.object({ feature: z.enum(['ai.queries_per_month']), units: z.number().int().min(1).max(1000), idempotency_key: z.string().min(8).max(100) }).parse(req.body);
    const out = await withWorkspaceLock(pool, req.workspace, async (c) => {
      const dup = await c.query('SELECT 1 FROM portal.usage_events WHERE workspace_id=$1 AND feature=$2 AND idempotency_key=$3', [req.workspace, p.feature, p.idempotency_key]);
      if (dup.rowCount) return { duplicate: true };
      const q = await quotaFor(c, req.workspace, p.feature);
      const used = Number((await c.query(`SELECT COALESCE(SUM(units),0) s FROM portal.usage_events WHERE workspace_id=$1 AND feature=$2 AND created_at >= date_trunc('month', now())`, [req.workspace, p.feature])).rows[0].s);
      if (!q.granted || (q.quota !== null && used + p.units > q.quota)) throw new PlanLimitError(p.feature, q.quota, q.plan, { used });
      await c.query('INSERT INTO portal.usage_events(workspace_id,feature,units,idempotency_key) VALUES($1,$2,$3,$4)', [req.workspace, p.feature, p.units, p.idempotency_key]);
      return { duplicate: false, used: used + p.units, limit: q.quota };
    });
    res.status(out.duplicate ? 200 : 201).json(out);
  }));

  // notes / tickets / reports
  app.get('/api/v1/notes', member, h(async (req, res) => res.json((await pool.query('SELECT id,title,body,author_id,created_at,updated_at FROM portal.notes WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT 100', [req.workspace])).rows)));
  app.post('/api/v1/notes', member, h(async (req, res) => {
    const p = z.object({ title: z.string().trim().min(1).max(160), body: z.string().max(50000).default('') }).parse(req.body);
    const row = await withWorkspaceLock(pool, req.workspace, async (c) => {
      const q = await quotaFor(c, req.workspace, 'notes.max');
      const n = Number((await c.query('SELECT count(*) FROM portal.notes WHERE workspace_id=$1', [req.workspace])).rows[0].count);
      if (q.quota !== null && n >= q.quota) throw new PlanLimitError('notes.max', q.quota, q.plan);
      return (await c.query('INSERT INTO portal.notes(workspace_id,author_id,title,body) VALUES($1,$2,$3,$4) RETURNING id,title,body,author_id,created_at,updated_at', [req.workspace, req.actor, p.title, p.body])).rows[0];
    });
    res.status(201).json(row);
  }));
  app.get('/api/v1/support/tickets', member, h(async (req, res) => res.json((await pool.query('SELECT id,subject,details,status,author_id,created_at FROM portal.support_tickets WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100', [req.workspace])).rows)));
  app.post('/api/v1/support/tickets', member, h(async (req, res) => {
    const p = z.object({ subject: z.string().trim().min(3).max(160), details: z.string().trim().min(5).max(10000) }).parse(req.body);
    res.status(201).json((await pool.query('INSERT INTO portal.support_tickets(workspace_id,author_id,subject,details) VALUES($1,$2,$3,$4) RETURNING id,subject,details,status,author_id,created_at', [req.workspace, req.actor, p.subject, p.details])).rows[0]);
  }));
  app.get('/api/v1/reports', member, h(async (req, res) => res.json((await pool.query('SELECT id,external_meeting_id,title,summary,created_at FROM portal.meeting_reports WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100', [req.workspace])).rows)));

  // ---- billing (owner / admin / billing role) ----
  app.get('/api/v1/billing', member, h(async (req, res) => {
    const s = await billing.subscriptionFor(req.workspace);
    res.set('Cache-Control', 'no-store').json({
      plan: s.effective_plan, subscription: s.plan_slug && (s.provider_subscription_id || s.plan_slug !== 'basic') ? {
        plan: s.plan_slug, status: s.status, interval: s.billing_interval, seats: s.seats, current_period_start: s.current_period_start, current_period_end: s.current_period_end, cancel_at_period_end: s.cancel_at_period_end } : null,
      checkout_available: billing.available(), unavailable_reasons: billing.available() ? [] : cfg.billing.unavailableReasons, can_manage: BILLING.includes(req.role) });
  }));
  app.get('/api/v1/billing/invoices', member, roles(...BILLING), h(async (req, res) => res.set('Cache-Control', 'no-store').json(await billing.invoices(req.workspace))));
  app.post('/api/v1/billing/checkout', member, roles(...BILLING), h(async (req, res) => {
    const p = z.object({ plan: z.enum(['pro', 'business']), interval: z.enum(['month', 'year']), seats: z.number().int().min(1).max(cfg.billing.maxSeats).default(1) }).parse(req.body);
    const out = await billing.createCheckout({ workspaceId: req.workspace, userId: req.actor, plan: p.plan, interval: p.interval, seats: p.seats, publicOrigin: cfg.origin });
    await pool.query(`INSERT INTO portal.audit_events(workspace_id,actor_id,action,object_id) VALUES($1,$2,'billing.checkout_started',$3)`, [req.workspace, req.actor, out.checkout_id]);
    res.status(201).json(out);
  }));
  app.post('/api/v1/billing/cancel', member, roles(...BILLING), h(async (req, res) => {
    const out = await billing.cancel(req.workspace);
    await pool.query(`INSERT INTO portal.audit_events(workspace_id,actor_id,action,object_id) VALUES($1,$2,'billing.cancel_requested',$1)`, [req.workspace, req.actor]);
    res.status(202).json(out);
  }));
  app.post('/api/v1/billing/reconcile', member, roles(...MANAGE), h(async (req, res) => res.json(await billing.reconcile(req.workspace))));

  app.get('/api/v1/:module/status', member, (req, res) => {
    const allowed = ['meet', 'receptionist', 'phone', 'mate', 'suite', 'solutions', 'ai'];
    if (!allowed.includes(req.params.module)) return res.status(404).json({ error: 'Unknown module' });
    res.json({ module: req.params.module, status: 'integration_required', message: 'UI available. Live provider/API integration is not yet configured.' });
  });
  app.use('/api/v1', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.get('/app', (req, res) => res.redirect(301, '/app/'));
  app.get('/app/*', (req, res) => res.sendFile(path.join(root, 'index.html')));

  app.use((err, req, res, next) => {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (err instanceof PlanLimitError) return res.status(402).json({ error: err.message, code: 'plan_limit', feature: err.feature, limit: err.limit, plan: err.plan, ...err.extra });
    if (err instanceof BillingError) return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
    if (err.status && err.code === 'last_owner') return res.status(409).json({ error: 'A workspace needs at least one owner', code: 'last_owner' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
    log.error('unhandled error', { req_id: req.id, err: err.message });
    res.status(500).json({ error: 'Server error' });
  });
  return { app, billing, auth };
}
