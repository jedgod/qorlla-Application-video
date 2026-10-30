// Enterprise operations HTTP surfaces, mounted only when OPS_ENABLED=true (otherwise these paths are the portal's ordinary 404):
//   /api/v1/ops/admin/*   administrators (role + MFA)        /api/v1/ops/staff/*  active staff with permissions        /api/v1/ops/support/*  customers (their own cases only)
// Everything runs behind the portal's `identity` chain. There is no endpoint that issues a number, activates calling, joins a meeting or moves money without the second person.
import { z } from 'zod';
import { UUID_RE } from '../auth.mjs';
import { createOpsAuth, PERMISSIONS, ROLES, ADMIN_ROLES } from './authz.mjs';
import { createAdapters, externalCallingDecision, AdapterUnavailable } from './adapters.mjs';
import { createOpsRefunds, audit } from './refunds.mjs';

const uuid = z.string().regex(UUID_RE).transform((s) => s.toLowerCase());
const CATEGORIES = ['meeting', 'audio', 'video', 'chat', 'billing', 'number', 'external_call', 'account', 'abuse', 'other'];
const PRIORITIES = ['low', 'normal', 'high', 'critical'];
const ticketBody = z.object({ category: z.enum(CATEGORIES), subject: z.string().trim().min(3).max(200), description: z.string().trim().min(3).max(10000), priority: z.enum(PRIORITIES).default('normal') }).strict();
const STATUSES = ['open', 'triaged', 'assigned', 'in_progress', 'waiting_customer', 'escalated', 'resolved', 'closed'];
// Moves through status. 'assigned' is reached only by assign/claim (it needs an assignee); closed is final.
export const TRANSITIONS = { open: ['triaged', 'escalated', 'closed'], triaged: ['escalated', 'closed'], assigned: ['in_progress', 'triaged', 'escalated'], in_progress: ['waiting_customer', 'escalated', 'resolved', 'assigned'],
  waiting_customer: ['in_progress', 'resolved', 'closed'], escalated: ['resolved', 'in_progress'], resolved: ['closed', 'in_progress'], closed: [] };
const csvCell = (v) => { const s = String(v ?? ''); return '"' + (/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"'; };   // spreadsheet-formula injection guard for the payroll export
const fail = (status, code, message) => Object.assign(new Error(message || code), { http: { status, body: { error: message || code, code } } });

export function registerOps(app, { pool, cfg, auth, h, log, launch, limiters = {}, adapters: given = {}, now = () => Date.now() }) {
  const A = createOpsAuth({ cfg, pool, auth, log, now }), adapters = createAdapters(given), refunds = createOpsRefunds({ pool, launch, log, now });
  const lim = limiters.opsWrite || ((req, res, next) => next());
  async function tx(fn) { const c = await pool.connect(); try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); } }
  const event = (c, ticketId, actor, type, details = {}) => c.query('INSERT INTO portal.ops_ticket_events(ticket_id,actor_id,event_type,details) VALUES($1,$2,$3,$4)', [ticketId, actor, type, JSON.stringify(details)]);
  const adapterErr = (fn) => h(async (req, res) => { try { return await fn(req, res); } catch (e) { if (e instanceof AdapterUnavailable) return res.status(503).json({ error: e.code, code: e.code }); throw e; } });
  // may this staff member see this ticket? leads see all; others their own cases and the unassigned, unrestricted queue
  const visibleSql = '($1::boolean OR t.assignee_id=$2 OR (t.assignee_id IS NULL AND NOT t.restricted))';
  const loadVisible = async (c, staff, id, lock = false) => (await c.query(`SELECT t.* FROM portal.ops_tickets t WHERE t.id=$3 AND ${visibleSql} ${lock ? 'FOR UPDATE OF t' : ''}`, [staff.lead, staff.user_id, id])).rows[0];
  const ADMIN = '/api/v1/ops/admin', STAFF = '/api/v1/ops/staff', SUPPORT = '/api/v1/ops/support';

  // ================================================================== ADMIN
  app.get(`${ADMIN}/gates`, A.admin, h(async (req, res) => res.set('Cache-Control', 'no-store').json({ release: 'BLOCKED', gates: cfg.ops.gates, adminMfaRequired: cfg.ops.requireMfa, refundTwoPerson: cfg.ops.refundTwoPerson })));
  app.get(`${ADMIN}/staff`, A.admin, h(async (req, res) => res.set('Cache-Control', 'no-store').json({ items: (await pool.query('SELECT user_id,display_name,team,role,employment_status,permissions FROM portal.ops_staff ORDER BY display_name LIMIT 500')).rows })));
  // Creating staff: an administrator, or (bootstrap) a platform admin with MFA. Only a super_admin / platform admin may hand out an administrator role.
  app.post(`${ADMIN}/staff`, (req, res, next) => A.identity(req, res, (e) => (e ? next(e) : ((cfg.platformAdmins || []).includes(req.actor) ? A.platformAdmin(req, res, (e2) => { if (e2) return next(e2); req.bootstrap = true; next(); }) : A.admin(req, res, next)))), lim, h(async (req, res) => {
    const p = z.object({ user_id: uuid, display_name: z.string().trim().min(1).max(200), team: z.string().trim().min(2).max(80), role: z.enum(ROLES), permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).default([]) }).strict().parse(req.body);
    if (ADMIN_ROLES.includes(p.role) && !req.bootstrap && req.staff.role !== 'super_admin') return res.status(403).json({ error: 'Only a super administrator can grant an administrator role' });
    const out = await tx(async (c) => { const r = await c.query('INSERT INTO portal.ops_staff(user_id,display_name,team,role,permissions,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING user_id,role', [p.user_id, p.display_name, p.team, p.role, [...new Set(p.permissions)], req.actor]);
      if (r.rowCount) await audit(c, req.actor, 'staff.created', 'staff', p.user_id, { role: p.role }); return r.rows[0]; });
    out ? res.status(201).json(out) : res.status(409).json({ error: 'Already a staff member' });
  }));
  app.patch(`${ADMIN}/staff/:id`, A.admin, lim, h(async (req, res) => {
    const id = uuid.parse(req.params.id), p = z.object({ role: z.enum(ROLES).optional(), permissions: z.array(z.enum(PERMISSIONS)).optional(), employment_status: z.enum(['active', 'suspended', 'terminated']).optional() }).strict().parse(req.body);
    if (id === req.actor) return res.status(409).json({ error: 'You cannot change your own staff record' });
    if (p.role && ADMIN_ROLES.includes(p.role) && req.staff.role !== 'super_admin') return res.status(403).json({ error: 'Only a super administrator can grant an administrator role' });
    const out = await tx(async (c) => {
      const cur = (await c.query('SELECT role,employment_status FROM portal.ops_staff WHERE user_id=$1 FOR UPDATE', [id])).rows[0]; if (!cur) throw fail(404, 'staff_not_found');
      if (ADMIN_ROLES.includes(cur.role) && req.staff.role !== 'super_admin') throw fail(403, 'forbidden', 'Only a super administrator can change an administrator');
      await c.query('UPDATE portal.ops_staff SET role=COALESCE($2,role), permissions=COALESCE($3,permissions), employment_status=COALESCE($4,employment_status), updated_at=now() WHERE user_id=$1', [id, p.role ?? null, p.permissions ? [...new Set(p.permissions)] : null, p.employment_status ?? null]);
      let released = 0;
      if (p.employment_status && p.employment_status !== 'active') {   // a person who is no longer active gives their open cases back to the queue
        const rel = await c.query(`UPDATE portal.ops_tickets SET assignee_id=NULL, status=CASE WHEN status='assigned' THEN 'triaged' ELSE status END, updated_at=now() WHERE assignee_id=$1 AND status NOT IN ('resolved','closed') RETURNING id`, [id]);
        for (const t of rel.rows) await event(c, t.id, req.actor, 'released', { from: id, reason: p.employment_status }); released = rel.rowCount;
      }
      await audit(c, req.actor, 'staff.updated', 'staff', id, { ...p, released_tickets: released }); return { user_id: id, released_tickets: released };
    });
    res.json(out);
  }));
  app.get(`${ADMIN}/refunds`, A.admin, h(async (req, res) => res.set('Cache-Control', 'no-store').json({ items: (await pool.query('SELECT id,invoice_id,amount_cents,reason,requested_by,approved_by,status,error_code,reconcile_state,created_at,decided_at FROM portal.ops_refund_requests ORDER BY created_at DESC LIMIT 200')).rows })));
  for (const [path, approve] of [['approve', true], ['reject', false]]) app.post(`${ADMIN}/refunds/:id/${path}`, A.admin, lim, h(async (req, res) => {
    const p = z.object({ note: z.string().trim().max(300).optional() }).strict().parse(req.body || {});
    res.json(await refunds.decide({ actor: req.actor, id: uuid.parse(req.params.id), approve, note: p.note }));
  }));
  app.post(`${ADMIN}/refunds/process`, A.admin, lim, h(async (req, res) => res.json(await refunds.executeApproved({ limit: 10 }))));
  app.post(`${ADMIN}/refunds/reconcile`, A.admin, lim, h(async (req, res) => res.json(await refunds.reconcile())));
  app.get(`${ADMIN}/payroll/export`, A.admin, h(async (req, res) => {
    const q = z.object({ from: z.string().datetime(), to: z.string().datetime() }).parse(req.query);
    const rows = (await pool.query(`SELECT e.staff_id, s.display_name, round(sum(extract(epoch FROM (e.ended_at - e.started_at)))/3600.0, 2) AS hours, count(*)::int AS entries FROM portal.ops_time_entries e JOIN portal.ops_staff s ON s.user_id=e.staff_id WHERE e.approved_by IS NOT NULL AND e.started_at >= $1 AND e.started_at < $2 GROUP BY e.staff_id, s.display_name ORDER BY s.display_name`, [q.from, q.to])).rows;
    await pool.query('INSERT INTO portal.ops_audit_log(actor_id,action,resource_type,resource_id,details) VALUES($1,$2,$3,$4,$5)', [req.actor, 'payroll.exported', 'payroll', 'export', JSON.stringify({ from: q.from, to: q.to, rows: rows.length })]);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="payroll.csv"' }).send(['staff_id,name,approved_hours,entries', ...rows.map((r) => [r.staff_id, r.display_name, r.hours, r.entries].map(csvCell).join(','))].join('\r\n') + '\r\n');
  }));

  // ================================================================== STAFF
  app.get(`${STAFF}/me`, A.staff, h(async (req, res) => res.set('Cache-Control', 'no-store').json({ user_id: req.staff.user_id, display_name: req.staff.display_name, role: req.staff.role, permissions: req.staff.permissions, lead: req.staff.lead })));
  // ---- tickets
  app.get(`${STAFF}/tickets`, A.staff, A.can('ticket:read', 'ticket:work'), h(async (req, res) => {
    const q = z.object({ status: z.enum(STATUSES).optional(), mine: z.enum(['true', 'false']).optional() }).parse(req.query);
    const rows = (await pool.query(`SELECT t.id,t.customer_id,t.category,t.subject,t.priority,t.status,t.restricted,t.assignee_id,t.created_at FROM portal.ops_tickets t WHERE ${visibleSql} AND ($3::text IS NULL OR t.status=$3) AND ($4::boolean IS NOT TRUE OR t.assignee_id=$2) ORDER BY t.created_at DESC LIMIT 100`, [req.staff.lead, req.staff.user_id, q.status ?? null, q.mine === 'true'])).rows;
    res.set('Cache-Control', 'no-store').json({ items: rows });
  }));
  app.post(`${STAFF}/tickets`, A.staff, A.can('ticket:work'), lim, h(async (req, res) => {
    const b = ticketBody.extend({ customer_id: uuid }).strict().parse(req.body);
    const t = await tx(async (c) => { const r = (await c.query('INSERT INTO portal.ops_tickets(customer_id,category,subject,description,priority,restricted,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,status,category,subject,priority', [b.customer_id, b.category, b.subject, b.description, b.priority, b.category === 'abuse', req.actor])).rows[0]; await event(c, r.id, req.actor, 'created', { on_behalf: true }); return r; });
    res.status(201).json(t);
  }));
  app.get(`${STAFF}/tickets/:id`, A.staff, A.can('ticket:read', 'ticket:work'), h(async (req, res) => {
    const id = uuid.parse(req.params.id), t = await loadVisible(pool, req.staff, id); if (!t) return res.status(404).json({ error: 'Not found' });
    const [ev, ms] = await Promise.all([pool.query('SELECT actor_id,event_type,details,created_at FROM portal.ops_ticket_events WHERE ticket_id=$1 ORDER BY id', [id]), pool.query('SELECT id,author_id,author_kind,visibility,body,created_at FROM portal.ops_ticket_messages WHERE ticket_id=$1 ORDER BY created_at', [id])]);
    res.set('Cache-Control', 'no-store').json({ ...t, events: ev.rows, messages: ms.rows });
  }));
  app.post(`${STAFF}/tickets/:id/claim`, A.staff, A.can('ticket:work'), lim, h(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const out = await tx(async (c) => { const r = (await c.query(`UPDATE portal.ops_tickets SET assignee_id=$2, status='assigned', updated_at=now() WHERE id=$1 AND assignee_id IS NULL AND NOT restricted AND status IN ('open','triaged') RETURNING id,status,assignee_id`, [id, req.staff.user_id])).rows[0];
      if (r) await event(c, id, req.actor, 'claimed'); return r; });
    out ? res.json(out) : res.status(409).json({ error: 'Not claimable (already taken, restricted, or not in the queue)' });   // two agents claiming at once: exactly one wins
  }));
  app.post(`${STAFF}/tickets/:id/assign`, A.staff, A.lead, lim, h(async (req, res) => {
    const id = uuid.parse(req.params.id), p = z.object({ assignee_id: uuid }).strict().parse(req.body);
    res.json(await tx(async (c) => {
      const t = (await c.query('SELECT id,status,assignee_id FROM portal.ops_tickets WHERE id=$1 FOR UPDATE', [id])).rows[0]; if (!t) throw fail(404, 'ticket_not_found');
      if (['resolved', 'closed'].includes(t.status)) throw fail(409, 'invalid_transition', 'A resolved or closed ticket cannot be reassigned');
      const who = (await c.query(`SELECT 1 FROM portal.ops_staff WHERE user_id=$1 AND employment_status='active'`, [p.assignee_id])).rowCount; if (!who) throw fail(409, 'assignee_not_active', 'The assignee is not an active staff member');
      const next = ['open', 'triaged', 'escalated'].includes(t.status) ? 'assigned' : t.status;
      const r = (await c.query('UPDATE portal.ops_tickets SET assignee_id=$2, status=$3, updated_at=now() WHERE id=$1 RETURNING id,status,assignee_id', [id, p.assignee_id, next])).rows[0];
      await event(c, id, req.actor, 'assigned', { from: t.assignee_id, to: p.assignee_id, status_from: t.status }); await audit(c, req.actor, 'ticket.assigned', 'ticket', id, { to: p.assignee_id }); return r;
    }));
  }));
  app.post(`${STAFF}/tickets/:id/status`, A.staff, A.can('ticket:work'), lim, h(async (req, res) => {
    const id = uuid.parse(req.params.id), p = z.object({ status: z.enum(STATUSES) }).strict().parse(req.body);
    if (p.status === 'assigned') return res.status(400).json({ error: 'Use assign or claim: an assignment needs an assignee', code: 'use_assign' });
    res.json(await tx(async (c) => {
      const t = await loadVisible(c, req.staff, id, true); if (!t) throw fail(404, 'ticket_not_found');
      if (!req.staff.lead && t.assignee_id !== req.staff.user_id) throw fail(403, 'forbidden', 'Only the assignee or a supervisor can move this case');
      if (!TRANSITIONS[t.status].includes(p.status)) throw fail(409, 'invalid_transition');
      const r = (await c.query('UPDATE portal.ops_tickets SET status=$2, updated_at=now() WHERE id=$1 RETURNING id,status', [id, p.status])).rows[0]; await event(c, id, req.actor, 'status_changed', { from: t.status, to: p.status }); return r;
    }));
  }));
  app.post(`${STAFF}/tickets/:id/messages`, A.staff, A.can('ticket:work'), lim, h(async (req, res) => {
    const id = uuid.parse(req.params.id), p = z.object({ body: z.string().trim().min(1).max(10000), visibility: z.enum(['customer', 'internal']).default('internal') }).strict().parse(req.body);   // default INTERNAL: a customer sees only what staff explicitly send to them
    res.status(201).json(await tx(async (c) => {
      const t = await loadVisible(c, req.staff, id, true); if (!t) throw fail(404, 'ticket_not_found');
      if (!req.staff.lead && t.assignee_id !== req.staff.user_id) throw fail(403, 'forbidden', 'Only the assignee or a supervisor can write on this case');
      const r = (await c.query(`INSERT INTO portal.ops_ticket_messages(ticket_id,author_id,author_kind,visibility,body) VALUES($1,$2,'staff',$3,$4) RETURNING id,visibility,created_at`, [id, req.actor, p.visibility, p.body])).rows[0];
      await event(c, id, req.actor, 'message', { visibility: p.visibility }); return r;
    }));
  }));
  // ---- workforce
  app.post(`${STAFF}/clock-in`, A.staff, lim, h(async (req, res) => {
    try { res.status(201).json((await pool.query('INSERT INTO portal.ops_time_entries(staff_id) VALUES($1) RETURNING id,started_at', [req.actor])).rows[0]); }
    catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Already clocked in', code: 'already_clocked_in' }); throw e; }
  }));
  app.post(`${STAFF}/clock-out`, A.staff, lim, h(async (req, res) => { const r = (await pool.query('UPDATE portal.ops_time_entries SET ended_at=now() WHERE staff_id=$1 AND ended_at IS NULL RETURNING id,started_at,ended_at', [req.actor])).rows[0]; r ? res.json(r) : res.status(409).json({ error: 'Not clocked in' }); }));
  app.get(`${STAFF}/time-entries`, A.staff, h(async (req, res) => {
    const who = req.staff.lead && req.query.staff_id ? uuid.parse(req.query.staff_id) : req.actor;
    res.set('Cache-Control', 'no-store').json({ items: (await pool.query('SELECT id,staff_id,started_at,ended_at,approved_by,approved_at FROM portal.ops_time_entries WHERE staff_id=$1 ORDER BY started_at DESC LIMIT 200', [who])).rows });
  }));
  app.post(`${STAFF}/time-entries/:id/approve`, A.staff, A.lead, lim, h(async (req, res) => {
    const id = uuid.parse(req.params.id), cur = (await pool.query('SELECT staff_id,ended_at,approved_by FROM portal.ops_time_entries WHERE id=$1', [id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Not found' }); if (cur.staff_id === req.actor) return res.status(409).json({ error: 'You cannot approve your own hours', code: 'separation_of_duties' });
    const r = (await pool.query('UPDATE portal.ops_time_entries SET approved_by=$2, approved_at=now() WHERE id=$1 AND ended_at IS NOT NULL AND approved_by IS NULL AND staff_id<>$2 RETURNING id,approved_at', [id, req.actor])).rows[0];
    if (r) await pool.query('INSERT INTO portal.ops_audit_log(actor_id,action,resource_type,resource_id) VALUES($1,$2,$3,$4)', [req.actor, 'time.approved', 'time_entry', id]);
    r ? res.json(r) : res.status(409).json({ error: 'Not approvable (still open or already approved)' });
  }));
  app.post(`${STAFF}/shifts`, A.staff, A.lead, lim, h(async (req, res) => {
    const p = z.object({ staff_id: uuid, starts_at: z.string().datetime(), ends_at: z.string().datetime() }).strict().parse(req.body); if (Date.parse(p.ends_at) <= Date.parse(p.starts_at)) return res.status(400).json({ error: 'A shift must end after it starts' });
    res.status(201).json(await tx(async (c) => {
      await c.query('SELECT user_id FROM portal.ops_staff WHERE user_id=$1 FOR UPDATE', [p.staff_id]);
      if (!(await c.query(`SELECT 1 FROM portal.ops_staff WHERE user_id=$1 AND employment_status='active'`, [p.staff_id])).rowCount) throw fail(404, 'staff_not_found');
      if ((await c.query('SELECT 1 FROM portal.ops_shifts WHERE staff_id=$1 AND starts_at < $3 AND ends_at > $2', [p.staff_id, p.starts_at, p.ends_at])).rowCount) throw fail(409, 'shift_overlap');
      const r = (await c.query('INSERT INTO portal.ops_shifts(staff_id,starts_at,ends_at,created_by) VALUES($1,$2,$3,$4) RETURNING id', [p.staff_id, p.starts_at, p.ends_at, req.actor])).rows[0]; await audit(c, req.actor, 'shift.created', 'shift', r.id); return r;
    }));
  }));
  app.get(`${STAFF}/shifts`, A.staff, h(async (req, res) => res.set('Cache-Control', 'no-store').json({ items: (await pool.query('SELECT id,staff_id,starts_at,ends_at FROM portal.ops_shifts WHERE ($1::boolean OR staff_id=$2) AND ends_at > now() - interval \'1 day\' ORDER BY starts_at LIMIT 200', [req.staff.lead, req.actor])).rows })));
  app.post(`${STAFF}/leave`, A.staff, lim, h(async (req, res) => {
    const p = z.object({ kind: z.enum(['vacation', 'sick', 'unpaid', 'other']), starts_on: z.string().date(), ends_on: z.string().date() }).strict().parse(req.body); if (p.ends_on < p.starts_on) return res.status(400).json({ error: 'Leave must end on or after it starts' });
    res.status(201).json((await pool.query('INSERT INTO portal.ops_leave_requests(staff_id,kind,starts_on,ends_on) VALUES($1,$2,$3,$4) RETURNING id,status', [req.actor, p.kind, p.starts_on, p.ends_on])).rows[0]);
  }));
  app.get(`${STAFF}/leave`, A.staff, h(async (req, res) => res.set('Cache-Control', 'no-store').json({ items: (await pool.query('SELECT id,staff_id,kind,starts_on,ends_on,status,decided_by FROM portal.ops_leave_requests WHERE ($1::boolean OR staff_id=$2) ORDER BY created_at DESC LIMIT 200', [req.staff.lead, req.actor])).rows })));
  for (const [path, status] of [['approve', 'approved'], ['reject', 'rejected']]) app.post(`${STAFF}/leave/:id/${path}`, A.staff, A.lead, lim, h(async (req, res) => {
    const id = uuid.parse(req.params.id), cur = (await pool.query('SELECT staff_id,status FROM portal.ops_leave_requests WHERE id=$1', [id])).rows[0]; if (!cur) return res.status(404).json({ error: 'Not found' });
    if (cur.staff_id === req.actor) return res.status(409).json({ error: 'You cannot decide your own leave', code: 'separation_of_duties' });
    const r = (await pool.query(`UPDATE portal.ops_leave_requests SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1 AND status='pending' AND staff_id<>$3 RETURNING id,status`, [id, status, req.actor])).rows[0];
    r ? res.json(r) : res.status(409).json({ error: 'Already decided' });
  }));
  // ---- refunds: a billing agent REQUESTS; a different administrator approves (/admin); the billing service executes
  app.post(`${STAFF}/refunds`, A.staff, A.can('billing:refund:request'), lim, h(async (req, res) => {
    const p = z.object({ invoice_id: uuid, amount_cents: z.number().int().positive().max(100000000).optional(), reason: z.string().trim().min(3).max(300), idempotency_key: z.string().min(8).max(100) }).strict().parse(req.body);
    const out = await refunds.request({ actor: req.actor, invoiceId: p.invoice_id, amountCents: p.amount_cents, reason: p.reason, idempotencyKey: p.idempotency_key });
    res.status(out.duplicate ? 200 : 201).json({ id: out.id, status: out.status });
  }));
  app.get(`${STAFF}/refunds`, A.staff, A.can('billing:refund:request'), h(async (req, res) => res.set('Cache-Control', 'no-store').json({ items: (await pool.query('SELECT id,invoice_id,amount_cents,reason,status,created_at FROM portal.ops_refund_requests WHERE ($1::boolean OR requested_by=$2) ORDER BY created_at DESC LIMIT 100', [req.staff.lead, req.actor])).rows })));
  // ---- numbers and external calling: REQUESTS and read-only decisions only
  app.get(`${STAFF}/customers/:id/number`, A.staff, A.can('numbers:read'), adapterErr(async (req, res) => {
    const id = uuid.parse(req.params.id), a = await adapters.numberAuthority.lookupAssignment(id);
    await pool.query('INSERT INTO portal.ops_audit_log(actor_id,action,resource_type,resource_id) VALUES($1,$2,$3,$4)', [req.actor, 'number.lookup', 'customer', id]); res.set('Cache-Control', 'no-store').json({ assignment: a ?? null });
  }));
  app.post(`${STAFF}/number-requests`, A.staff, A.can('numbers:request'), lim, h(async (req, res) => {
    const p = z.object({ customer_id: uuid, country: z.string().regex(/^[A-Z]{2}$/), range_prefix: z.string().regex(/^[0-9]{4,8}$/) }).strict().parse(req.body);
    if (!(cfg.ops.approvedRanges[p.country] || []).some((pre) => p.range_prefix.startsWith(pre))) {
      await pool.query('INSERT INTO portal.ops_audit_log(actor_id,action,resource_type,resource_id,details) VALUES($1,$2,$3,$4,$5)', [req.actor, 'number.request.denied', 'customer', p.customer_id, JSON.stringify({ country: p.country, reason: 'range_not_approved' })]);
      return res.status(422).json({ error: 'That number range is not approved for issue', code: 'range_not_approved' });
    }
    // an approved range only lets the REQUEST be recorded: the Number Authority is the sole issuer and decides separately
    res.status(202).json(await tx(async (c) => { const r = (await c.query('INSERT INTO portal.ops_number_requests(customer_id,country,range_prefix,requested_by) VALUES($1,$2,$3,$4) RETURNING id,status', [p.customer_id, p.country, p.range_prefix, req.actor])).rows[0]; await audit(c, req.actor, 'number.requested', 'number_request', r.id); return r; }));
  }));
  app.get(`${STAFF}/customers/:id/external-calling`, A.staff, A.can('calling:read'), h(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const inv = (await pool.query(`SELECT i.id,i.status,i.amount_paid_cents,i.amount_refunded_cents FROM portal.invoices i JOIN portal.members m ON m.workspace_id=i.workspace_id AND m.user_id=$1 AND m.role='owner' ORDER BY i.id DESC LIMIT 1`, [id])).rows[0] || null;
    res.set('Cache-Control', 'no-store').json(externalCallingDecision({ gates: cfg.ops.gates, invoice: inv, shield: adapters.shield, carrier: adapters.carrier }));
  }));
  app.post(`${STAFF}/external-call-requests`, A.staff, A.can('calling:request'), lim, h(async (req, res) => {
    const p = z.object({ customer_id: uuid, plan_code: z.string().regex(/^[A-Z0-9_-]{2,40}$/) }).strict().parse(req.body);
    try { res.status(202).json((await pool.query('INSERT INTO portal.ops_external_call_requests(customer_id,plan_code,requested_by) VALUES($1,$2,$3) RETURNING id,status', [p.customer_id, p.plan_code, req.actor])).rows[0]); }
    catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'A request is already pending', code: 'already_pending' }); throw e; }
  }));
  // ---- meetings: read-only health. There is deliberately NO join, admit, mute, record or media route.
  app.get(`${STAFF}/meetings/:id/diagnostics`, A.staff, A.can('meetings:diagnose'), adapterErr(async (req, res) => {
    const id = uuid.parse(req.params.id), d = await adapters.meetings.health(id);
    await pool.query('INSERT INTO portal.ops_audit_log(actor_id,action,resource_type,resource_id) VALUES($1,$2,$3,$4)', [req.actor, 'meeting.diagnostics.read', 'meeting', id]); res.set('Cache-Control', 'no-store').json(d);
  }));

  // ================================================================== SUPPORT (customers): identity only, every query scoped to the signed-in user
  app.post(`${SUPPORT}/tickets`, A.identity, lim, h(async (req, res) => {
    const b = ticketBody.parse(req.body);
    const t = await tx(async (c) => {
      if (Number((await c.query(`SELECT count(*) FROM portal.ops_tickets WHERE customer_id=$1 AND status NOT IN ('resolved','closed')`, [req.actor])).rows[0].count) >= 20) throw fail(429, 'too_many_open_tickets');
      const r = (await c.query('INSERT INTO portal.ops_tickets(customer_id,category,subject,description,priority,restricted,created_by) VALUES($1,$2,$3,$4,$5,$6,$1) RETURNING id,status,category,subject,created_at', [req.actor, b.category, b.subject, b.description, b.priority === 'critical' ? 'high' : b.priority, b.category === 'abuse'])).rows[0];
      await event(c, r.id, req.actor, 'created'); return r;
    });
    res.status(201).json(t);
  }));
  app.get(`${SUPPORT}/tickets`, A.identity, h(async (req, res) => res.set('Cache-Control', 'no-store').json({ items: (await pool.query('SELECT id,category,subject,status,priority,created_at,updated_at FROM portal.ops_tickets WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100', [req.actor])).rows })));
  app.get(`${SUPPORT}/tickets/:id`, A.identity, h(async (req, res) => {
    const id = uuid.parse(req.params.id), t = (await pool.query('SELECT id,category,subject,description,status,priority,created_at,updated_at FROM portal.ops_tickets WHERE id=$1 AND customer_id=$2', [id, req.actor])).rows[0]; if (!t) return res.status(404).json({ error: 'Not found' });
    const messages = (await pool.query(`SELECT id,author_kind,body,created_at FROM portal.ops_ticket_messages WHERE ticket_id=$1 AND visibility='customer' ORDER BY created_at`, [id])).rows;   // internal notes, staff identities and events never leave this endpoint
    res.set('Cache-Control', 'no-store').json({ ...t, messages });
  }));
  app.post(`${SUPPORT}/tickets/:id/messages`, A.identity, lim, h(async (req, res) => {
    const id = uuid.parse(req.params.id), p = z.object({ body: z.string().trim().min(1).max(10000) }).strict().parse(req.body);
    res.status(201).json(await tx(async (c) => {
      const t = (await c.query('SELECT id,status FROM portal.ops_tickets WHERE id=$1 AND customer_id=$2 FOR UPDATE', [id, req.actor])).rows[0]; if (!t) throw fail(404, 'ticket_not_found'); if (t.status === 'closed') throw fail(409, 'ticket_closed');
      const r = (await c.query(`INSERT INTO portal.ops_ticket_messages(ticket_id,author_id,author_kind,visibility,body) VALUES($1,$2,'customer','customer',$3) RETURNING id,created_at`, [id, req.actor, p.body])).rows[0];
      if (t.status === 'waiting_customer') await c.query(`UPDATE portal.ops_tickets SET status='in_progress', updated_at=now() WHERE id=$1`, [id]);
      await event(c, id, req.actor, 'customer_message'); return r;
    }));
  }));

  let timer = null;
  const startWorker = (every = 30_000) => { if (timer) return; timer = setInterval(() => { refunds.executeApproved().then(() => refunds.reconcile()).catch((e) => log?.error('ops worker failed', { err: e.message })); }, every); timer.unref?.(); };
  const stopWorker = () => { clearInterval(timer); timer = null; };
  return { refunds, startWorker, stopWorker, adapters };
}
