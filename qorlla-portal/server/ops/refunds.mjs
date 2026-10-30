// Two-person refunds. The billing service stays the authority: a refund executes only through launch.refund (which re-checks the invoice, uses the provider idempotency key and records portal.refund_requests / portal.refunds).
// This module adds: a request by one person, approval by a DIFFERENT administrator (also enforced by a CHECK in the database), execution exactly once, and reconciliation against portal.refunds.
import { BillingError } from '../billing/service.mjs';

export const audit = (c, actor, action, type, id, details = {}) => c.query('INSERT INTO portal.ops_audit_log(actor_id,action,resource_type,resource_id,details) VALUES($1,$2,$3,$4,$5)', [actor, action, type, String(id), JSON.stringify(details)]);
const STALE_EXECUTING_MS = 5 * 60_000;

export function createOpsRefunds({ pool, launch, log, now = () => Date.now() }) {
  async function tx(fn) { const c = await pool.connect(); try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); } }
  const fail = (status, code, message) => Object.assign(new Error(message || code), { http: { status, body: { error: message || code, code } } });

  /** A billing agent asks for a refund. The invoice must be PAID with a recorded payment, and everything already requested (pending, approved, executing) plus this amount must fit in what is still refundable. */
  async function request({ actor, invoiceId, amountCents, reason, idempotencyKey }) {
    return tx(async (c) => {
      const prior = (await c.query('SELECT id,status,requested_by FROM portal.ops_refund_requests WHERE idempotency_key=$1', [idempotencyKey])).rows[0];
      if (prior) { if (prior.requested_by !== actor) throw fail(409, 'idempotency_key_in_use'); return { id: prior.id, status: prior.status, duplicate: true }; }
      const inv = (await c.query('SELECT id,status,provider_payment_intent,amount_paid_cents,amount_refunded_cents FROM portal.invoices WHERE id=$1 FOR UPDATE', [invoiceId])).rows[0];
      if (!inv) throw fail(404, 'invoice_not_found');
      if (!inv.provider_payment_intent || !['paid', 'partially_refunded'].includes(inv.status)) throw fail(409, 'payment_not_eligible', 'Only a paid invoice with a recorded payment can be refunded');
      const committed = Number((await c.query(`SELECT COALESCE(sum(amount_cents),0) s FROM portal.ops_refund_requests WHERE invoice_id=$1 AND status IN ('pending','approved','executing')`, [invoiceId])).rows[0].s);
      const refundable = Number(inv.amount_paid_cents) - Number(inv.amount_refunded_cents) - committed, amount = amountCents ?? refundable;
      if (!(amount > 0) || amount > refundable) throw fail(400, 'exceeds_refundable', `At most ${Math.max(refundable, 0)} can still be requested on this invoice`);
      const r = (await c.query('INSERT INTO portal.ops_refund_requests(invoice_id,amount_cents,reason,requested_by,idempotency_key) VALUES($1,$2,$3,$4,$5) RETURNING id,status', [invoiceId, amount, reason, actor, idempotencyKey])).rows[0];
      await audit(c, actor, 'refund.requested', 'refund', r.id, { invoice_id: invoiceId, amount_cents: amount }); return { ...r, duplicate: false };
    });
  }

  /** Approval by someone other than the requester. One conditional UPDATE decides: two simultaneous approvals cannot both succeed. */
  async function decide({ actor, id, approve, note }) {
    return tx(async (c) => {
      const cur = (await c.query('SELECT id,status,requested_by FROM portal.ops_refund_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw fail(404, 'refund_not_found');
      if (cur.status !== 'pending') throw fail(409, 'not_pending');
      if (cur.requested_by === actor) throw fail(409, 'separation_of_duties', 'The person who requested a refund cannot decide it');
      const r = (await c.query(`UPDATE portal.ops_refund_requests SET status=$2, approved_by=$3, decided_at=now() WHERE id=$1 AND status='pending' AND requested_by<>$3 RETURNING id,invoice_id,amount_cents,status`, [id, approve ? 'approved' : 'rejected', actor])).rows[0];
      if (!r) throw fail(409, 'not_pending');
      if (approve) await c.query('INSERT INTO portal.ops_outbox(topic,payload) VALUES($1,$2)', ['ops.refund.approved', JSON.stringify({ id: r.id, invoice_id: r.invoice_id, amount_cents: r.amount_cents })]);
      await audit(c, actor, approve ? 'refund.approved' : 'refund.rejected', 'refund', id, { note: note ? String(note).slice(0, 300) : undefined }); return r;
    });
  }

  /** Executes approved refunds one at a time. A row is claimed (approved -> executing) under SKIP LOCKED, so two workers never take the same refund; the provider call is idempotent on a key derived from the request id. */
  async function executeApproved({ limit = 10 } = {}) {
    const out = { succeeded: 0, failed: 0, deferred: 0 };
    for (let i = 0; i < limit; i++) {
      const row = (await pool.query(`UPDATE portal.ops_refund_requests SET status='executing', executed_at=now() WHERE id=(SELECT id FROM portal.ops_refund_requests WHERE status='approved' ORDER BY decided_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`)).rows[0];
      if (!row) break;
      try {
        const res = await launch.refund({ actor: row.approved_by, invoiceId: row.invoice_id, amountCents: Number(row.amount_cents), reason: row.reason, idempotencyKey: 'ops-' + row.id });
        if (res.duplicate && res.status !== 'succeeded') { await pool.query(`UPDATE portal.ops_refund_requests SET status='failed', error_code=$2 WHERE id=$1`, [row.id, 'billing_' + res.status]); out.failed++; continue; }
        const pid = res.provider_refund_id || (res.request_id ? (await pool.query('SELECT provider_refund_id FROM portal.refund_requests WHERE id=$1', [res.request_id])).rows[0]?.provider_refund_id : null) || null;
        await tx(async (c) => { await c.query(`UPDATE portal.ops_refund_requests SET status='succeeded', provider_refund_id=$2 WHERE id=$1`, [row.id, pid]); await audit(c, row.approved_by, 'refund.executed', 'refund', row.id, { provider_refund_id: pid }); });
        out.succeeded++;
      } catch (e) {
        if (e instanceof BillingError && e.code === 'billing_unavailable') { await pool.query(`UPDATE portal.ops_refund_requests SET status='approved' WHERE id=$1`, [row.id]); out.deferred++; break; }   // nothing was sent to the provider: keep it approved, try later
        await pool.query(`UPDATE portal.ops_refund_requests SET status='failed', error_code=$2 WHERE id=$1`, [row.id, String(e.code || 'error').slice(0, 60)]); out.failed++; log?.error('ops refund failed', { id: row.id, code: e.code });
      }
    }
    return out;
  }

  /** Compares what operations believes with the billing authority. 'succeeded' must have a matching portal.refunds row; an 'executing' row that has been stuck is resolved from billing's own idempotency record, else flagged for a person. */
  async function reconcile() {
    const out = { matched: 0, mismatch: 0, resolved: 0, needs_review: 0 };
    for (const r of (await pool.query(`SELECT * FROM portal.ops_refund_requests WHERE status='succeeded' AND reconcile_state IS DISTINCT FROM 'matched'`)).rows) {
      const m = r.provider_refund_id ? (await pool.query('SELECT amount_cents FROM portal.refunds WHERE provider_refund_id=$1', [r.provider_refund_id])).rows[0] : null;
      const ok = !!m && Number(m.amount_cents) === Number(r.amount_cents);
      await pool.query('UPDATE portal.ops_refund_requests SET reconcile_state=$2, reconciled_at=now() WHERE id=$1', [r.id, ok ? 'matched' : 'mismatch']); out[ok ? 'matched' : 'mismatch']++;
    }
    for (const r of (await pool.query(`SELECT * FROM portal.ops_refund_requests WHERE status='executing' AND executed_at < $1`, [new Date(now() - STALE_EXECUTING_MS)])).rows) {
      const b = (await pool.query('SELECT status, provider_refund_id FROM portal.refund_requests WHERE idempotency_key=$1', ['ops-' + r.id])).rows[0];
      if (b?.status === 'succeeded') { await pool.query(`UPDATE portal.ops_refund_requests SET status='succeeded', provider_refund_id=$2 WHERE id=$1`, [r.id, b.provider_refund_id]); out.resolved++; }
      else if (b?.status === 'failed') { await pool.query(`UPDATE portal.ops_refund_requests SET status='failed', error_code='billing_failed' WHERE id=$1`, [r.id]); out.resolved++; }
      else { await pool.query(`UPDATE portal.ops_refund_requests SET reconcile_state='needs_review', reconciled_at=now() WHERE id=$1`, [r.id]); out.needs_review++; }   // ambiguous: a person must check the provider, we never guess or resend
    }
    return out;
  }
  return { request, decide, executeApproved, reconcile };
}
