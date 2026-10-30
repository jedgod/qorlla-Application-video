// Qorlla operations control: staff tickets and external-calling purchase REQUESTS. A request is not a payment and nothing here activates PSTN, assigns a number or contacts a carrier.
// createOpsApp({ db, verify }) takes its dependencies so tests can run it on real PostgreSQL with a real signing key; server.mjs wires the production ones.
import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';

export const STAFF = ['super_admin', 'ops_admin', 'supervisor', 'support_agent', 'billing_agent', 'technical_agent'];
const LEADS = ['super_admin', 'ops_admin', 'supervisor'];
const CATEGORIES = ['meeting', 'audio', 'video', 'chat', 'billing', 'number', 'external_call', 'account', 'abuse', 'other'];
const STATUSES = ['open', 'triaged', 'assigned', 'pending_customer', 'escalated', 'resolved', 'closed'];
// who can move a ticket where; "closed" is final
export const TRANSITIONS = { open: ['triaged', 'assigned', 'escalated', 'closed'], triaged: ['assigned', 'escalated', 'closed'], assigned: ['pending_customer', 'escalated', 'resolved'], pending_customer: ['assigned', 'resolved', 'closed'], escalated: ['assigned', 'resolved'], resolved: ['closed', 'assigned'], closed: [] };
const ticketSchema = z.object({ customer_id: z.string().uuid(), category: z.enum(CATEGORIES), subject: z.string().trim().min(3).max(200), description: z.string().trim().min(3).max(10000), priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal') }).strict();
const uuid = z.string().uuid();

export function createOpsApp({ db, verify, ratePerMinute = 120 }) {
  const app = express(); app.disable('x-powered-by'); app.use(helmet()); app.use(express.json({ limit: '32kb' }));
  const hits = new Map();
  const limited = (actor) => { const now = Date.now(), h = (hits.get(actor) || []).filter((t) => now - t < 60000); h.push(now); hits.set(actor, h); if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60000)) hits.delete(k); return h.length > ratePerMinute; };
  async function auth(req, res, next) {
    try {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); if (!m) return res.sendStatus(401);
      const payload = await verify(m[1]); if (!payload || typeof payload.sub !== 'string' || !uuid.safeParse(payload.sub).success || !Array.isArray(payload.roles)) return res.sendStatus(403);
      const roles = payload.roles.filter((r) => STAFF.includes(r)); if (!roles.length) return res.sendStatus(403);
      if (limited(payload.sub)) return res.set('Retry-After', '30').status(429).json({ error: 'rate_limited' });
      req.actor = { id: payload.sub, roles }; next();
    } catch { res.sendStatus(401); }
  }
  const allow = (...permitted) => (req, res, next) => (req.actor.roles.some((r) => permitted.includes(r)) ? next() : res.sendStatus(403));
  const isLead = (a) => a.roles.some((r) => LEADS.includes(r));
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  async function tx(fn) { const c = await db.connect(); try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); } }
  const bad = (res) => res.status(400).json({ error: 'invalid_input' });

  app.get('/healthz', (_req, res) => res.json({ status: 'up' }));
  app.get('/readyz', wrap(async (_req, res) => { await db.query('SELECT 1'); res.json({ status: 'ready' }); }));

  app.post('/api/ops/tickets', auth, allow(...STAFF), wrap(async (req, res) => {
    const p = ticketSchema.safeParse(req.body); if (!p.success) return bad(res); const d = p.data;
    const t = await tx(async (c) => {
      const { rows: [row] } = await c.query('INSERT INTO ops_tickets(customer_id,category,subject,description,priority) VALUES($1,$2,$3,$4,$5) RETURNING *', [d.customer_id, d.category, d.subject, d.description, d.priority]);
      await c.query('INSERT INTO ops_ticket_events(ticket_id,actor_id,event_type) VALUES($1,$2,$3)', [row.id, req.actor.id, 'created']); return row;
    });
    res.status(201).json(t);
  }));
  app.get('/api/ops/tickets', auth, allow(...STAFF), wrap(async (req, res) => {
    const status = req.query.status; if (status !== undefined && !STATUSES.includes(status)) return bad(res);
    const { rows } = await db.query('SELECT id,customer_id,category,subject,priority,status,assignee_id,created_at FROM ops_tickets WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC LIMIT 100', [status ?? null]); res.json({ items: rows });
  }));
  app.get('/api/ops/tickets/:id', auth, allow(...STAFF), wrap(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res);
    const { rows: [t] } = await db.query('SELECT * FROM ops_tickets WHERE id=$1', [req.params.id]); if (!t) return res.sendStatus(404);
    const { rows: events } = await db.query('SELECT id,actor_id,event_type,details,occurred_at FROM ops_ticket_events WHERE ticket_id=$1 ORDER BY occurred_at, id', [t.id]); res.json({ ...t, events });
  }));
  // Assigning is a lead action. Moving status is allowed for a lead, or for the agent the ticket is assigned to.
  app.post('/api/ops/tickets/:id/assign', auth, allow(...LEADS), wrap(async (req, res) => {
    const p = z.object({ assignee_id: uuid }).strict().safeParse(req.body); if (!p.success || !uuid.safeParse(req.params.id).success) return bad(res);
    const out = await tx(async (c) => {
      const { rows: [t] } = await c.query('SELECT id,status,assignee_id FROM ops_tickets WHERE id=$1 FOR UPDATE', [req.params.id]); if (!t) return { code: 404 };
      if (!TRANSITIONS[t.status].includes('assigned') && t.status !== 'assigned') return { code: 409, error: 'invalid_transition' };
      const { rows: [u] } = await c.query("UPDATE ops_tickets SET assignee_id=$2, status='assigned', updated_at=now() WHERE id=$1 RETURNING *", [t.id, p.data.assignee_id]);
      await c.query('INSERT INTO ops_ticket_events(ticket_id,actor_id,event_type,details) VALUES($1,$2,$3,$4)', [t.id, req.actor.id, 'assigned', JSON.stringify({ from: t.assignee_id, to: p.data.assignee_id, status_from: t.status })]); return { code: 200, body: u };
    });
    res.status(out.code).json(out.body || (out.error ? { error: out.error } : {}));
  }));
  app.post('/api/ops/tickets/:id/status', auth, allow(...STAFF), wrap(async (req, res) => {
    const p = z.object({ status: z.enum(STATUSES) }).strict().safeParse(req.body); if (!p.success || !uuid.safeParse(req.params.id).success) return bad(res);
    const out = await tx(async (c) => {
      const { rows: [t] } = await c.query('SELECT id,status,assignee_id FROM ops_tickets WHERE id=$1 FOR UPDATE', [req.params.id]); if (!t) return { code: 404 };
      if (!isLead(req.actor) && t.assignee_id !== req.actor.id) return { code: 403 };
      if (p.data.status === 'assigned') return { code: 400, error: 'use_assign' };                            // an assignment needs an assignee
      if (!TRANSITIONS[t.status].includes(p.data.status)) return { code: 409, error: 'invalid_transition' };
      const { rows: [u] } = await c.query('UPDATE ops_tickets SET status=$2, updated_at=now() WHERE id=$1 RETURNING *', [t.id, p.data.status]);
      await c.query('INSERT INTO ops_ticket_events(ticket_id,actor_id,event_type,details) VALUES($1,$2,$3,$4)', [t.id, req.actor.id, 'status_changed', JSON.stringify({ from: t.status, to: p.data.status })]); return { code: 200, body: u };
    });
    res.status(out.code).json(out.body || (out.error ? { error: out.error } : {}));
  }));

  // External calling: a purchase REQUEST only. 'verified' can be set only by the entitlement/payment authority (not built here); this service can create and cancel.
  app.post('/api/ops/external-call-requests', auth, allow('super_admin', 'ops_admin', 'billing_agent'), wrap(async (req, res) => {
    const p = z.object({ customer_id: uuid, plan_code: z.string().regex(/^[A-Z0-9_-]{2,40}$/) }).strict().safeParse(req.body); if (!p.success) return bad(res);
    try { const { rows: [item] } = await db.query('INSERT INTO ops_external_call_requests(customer_id,plan_code) VALUES($1,$2) RETURNING id,status,created_at', [p.data.customer_id, p.data.plan_code]); res.status(202).json(item); }
    catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'already_pending' }); throw e; }
  }));
  app.get('/api/ops/external-call-requests', auth, allow('super_admin', 'ops_admin', 'billing_agent', 'supervisor'), wrap(async (_req, res) => { const { rows } = await db.query('SELECT id,customer_id,plan_code,status,created_at FROM ops_external_call_requests ORDER BY created_at DESC LIMIT 100'); res.json({ items: rows }); }));
  app.post('/api/ops/external-call-requests/:id/cancel', auth, allow('super_admin', 'ops_admin', 'billing_agent'), wrap(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res);
    const { rows: [r] } = await db.query("UPDATE ops_external_call_requests SET status='cancelled' WHERE id=$1 AND status='pending_verification' RETURNING id,status", [req.params.id]);
    r ? res.json(r) : res.status(409).json({ error: 'not_pending_or_unknown' });
  }));

  app.use((err, _req, res, _next) => { console.error('request_error', err?.code || 'internal'); res.status(500).json({ error: 'internal_error' }); });
  return app;
}
