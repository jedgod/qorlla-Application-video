/**
 * BillingProcessor - provider-neutral webhook ingestion (runs with the `qorlla_sub_billing` role).
 *
 *  1. Signature is verified over the EXACT raw bytes before anything is stored or parsed.
 *  2. The event lands in a transactional inbox keyed by (provider, event_id): replays are ignored, a replay with
 *     different bytes is flagged as an attack.
 *  3. A subscription snapshot is applied only if its revision is HIGHER than the stored one, under a per-customer lock:
 *     duplicates and out-of-order delivery cannot move state backwards.
 *  4. The provider customer must already be linked to a Qorlla customer by an administrator; a webhook can never
 *     attach itself to a tenant.
 *  5. A durable outbox row is written in the same transaction; a publisher drains it at-least-once.
 *  6. reconcile() re-reads the provider's authoritative state and applies it as a higher-revision snapshot.
 * Nothing here collects payment or talks to a provider.
 */

import { createPool, ensureSearchPath } from './schema.js';
import { createHash } from 'node:crypto';
import { withTx } from './db.js';
import { ENTITLEMENT_TYPES, validateEvent } from './billingAdapters.js';
import { BillingEventError, BillingSignatureError, SubscriptionError } from './errors.js';

const MAX_BODY_BYTES = 1024 * 1024;

export class BillingProcessor {
  constructor(opts = {}) {
    this.adapters = {};
    for (const a of opts.adapters || []) this.adapters[a.provider] = a;
    this.ownsPool = !opts.pool;
    this.pool = opts.pool || createPool(opts.connectionString || process.env.DATABASE_URL, { max: opts.poolMax || 4 });
    this.maxAttempts = opts.maxAttempts || 5;
    this.onSubscriptionChanged = typeof opts.onSubscriptionChanged === 'function' ? opts.onSubscriptionChanged : () => {};
    this.lockTimeoutMs = opts.lockTimeoutMs || 5000;
  }

  _tx(fn) {
    return withTx(this.pool, fn, { lockTimeoutMs: this.lockTimeoutMs, statementTimeoutMs: this.lockTimeoutMs + 10_000 });
  }

  async _security(type, severity, customerId, details) {
    try {
      await this.pool.query('INSERT INTO security_events (event_type, severity, customer_id, details) VALUES ($1, $2, $3, $4)',
        [type, severity, customerId ?? null, JSON.stringify(details || {})]);
    } catch (e) { console.error('[subscription-access] security event write failed:', e.message); }
  }

  /**
   * @param {{provider:string, rawBody:Buffer, headers:object, nowMs?:number}} req  rawBody MUST be the unparsed bytes
   *        (express.raw / a verify callback), never JSON.stringify(req.body).
   * @returns {Promise<{status:'applied'|'stale'|'ignored'|'dead'|'duplicate', ...}>}
   */
  async ingest({ provider, rawBody, headers = {}, nowMs = Date.now() }) {
    await ensureSearchPath(this.pool);
    const adapter = this.adapters[provider];
    if (!adapter) throw new BillingEventError('unknown provider', 'unknown_provider');
    if (!Buffer.isBuffer(rawBody)) throw new BillingEventError('raw body bytes required', 'raw_body_required');
    if (rawBody.length > MAX_BODY_BYTES) throw new BillingEventError('payload too large', 'webhook_too_large');

    const v = adapter.verify(rawBody, headers, nowMs);
    if (!v.ok) {
      await this._security('webhook_signature_invalid', 'warning', null, { provider, reason: v.reason });
      throw new BillingSignatureError(v.reason);
    }
    let event;
    try { event = validateEvent(provider, adapter.parse(rawBody)); } catch (e) {
      await this._security('webhook_payload_invalid', 'warning', null, { provider, error: String(e.message).slice(0, 200) });
      throw e instanceof BillingEventError ? e : new BillingEventError('payload could not be parsed');
    }
    return this._process(provider, event, createHash('sha256').update(rawBody).digest('hex'), JSON.parse(rawBody.toString('utf8')));
  }

  async _process(provider, event, sha, payload) {
    const out = await this._tx(async (c) => {
      const ins = await c.query(
        `INSERT INTO billing_inbox (provider, event_id, event_type, revision, raw_sha256, payload)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
        [provider, event.eventId, event.type.slice(0, 80), event.revision ?? null, sha, JSON.stringify(payload)]);
      let inboxId;
      if (ins.rowCount) {
        inboxId = ins.rows[0].id;
      } else {
        const ex = (await c.query('SELECT id, status, attempts, raw_sha256 FROM billing_inbox WHERE provider = $1 AND event_id = $2 FOR UPDATE', [provider, event.eventId])).rows[0];
        if (ex.raw_sha256 !== sha) {
          await c.query(`INSERT INTO security_events (event_type, severity, details) VALUES ('webhook_replay_mismatch', 'critical', $1)`, [JSON.stringify({ provider, eventId: event.eventId })]);
          return { status: 'duplicate', conflict: true };
        }
        if (ex.status !== 'failed' && ex.status !== 'received') return { status: 'duplicate', previous: ex.status };
        if (ex.attempts >= this.maxAttempts) {
          await c.query(`UPDATE billing_inbox SET status = 'dead', error = 'max_attempts', processed_at = now() WHERE id = $1`, [ex.id]);
          return { status: 'dead', reason: 'max_attempts' };
        }
        inboxId = ex.id;
      }
      return this._apply(c, inboxId, provider, event);
    });
    if (out.changedCustomer) this.onSubscriptionChanged(out.changedCustomer);
    if (out.failed) throw new SubscriptionError('The event could not be processed; retry later', 'webhook_processing_failed', {}, 503);
    return out;
  }

  /** Applies one stored event inside the caller's transaction, using a savepoint so a failure is recorded, not lost. */
  async _apply(c, inboxId, provider, event) {
    await c.query('SAVEPOINT apply_sp');
    try {
      const finish = async (status, extra = {}, error = null, customerId = null) => {
        await c.query(`UPDATE billing_inbox SET status = $2, error = $3, customer_id = $4, processed_at = now(), attempts = attempts + 1 WHERE id = $1`,
          [inboxId, status, error, customerId]);
        await c.query('RELEASE SAVEPOINT apply_sp');
        return { status, eventId: event.eventId, ...extra };
      };
      if (event.unknownType) return await finish('ignored', {}, 'unknown_event_type');

      const map = (await c.query('SELECT customer_id FROM billing_customers WHERE provider = $1 AND external_customer_id = $2', [provider, event.externalCustomerId])).rows[0];
      if (!map) {
        await c.query(`INSERT INTO security_events (event_type, severity, details) VALUES ('webhook_unmapped_customer', 'warning', $1)`, [JSON.stringify({ provider, eventId: event.eventId })]);
        return await finish('dead', { reason: 'unmapped_customer' }, 'unmapped_customer');
      }
      const customerId = map.customer_id;
      // The provider may state which Qorlla customer a purchase was made for (Stripe subscription metadata). If it disagrees with
      // the administrator-controlled link, neither is trusted: the event is parked and an operator is alerted.
      if (event.claimedCustomerId && String(event.claimedCustomerId).toLowerCase() !== customerId) {
        await c.query(`INSERT INTO security_events (event_type, severity, customer_id, details) VALUES ('webhook_identity_mismatch', 'critical', $1, $2)`,
          [customerId, JSON.stringify({ provider, eventId: event.eventId })]);
        return await finish('dead', { reason: 'identity_mismatch' }, 'identity_mismatch', customerId);
      }

      let status = 'applied'; let changedCustomer = null;
      if (ENTITLEMENT_TYPES.includes(event.type) && event.subscription) {
        const r = await this._applySnapshot(c, customerId, provider, event);
        if (r === 'stale') status = 'stale';
        else if (r === 'conflict') return await finish('dead', { reason: 'subscription_conflict' }, 'subscription_conflict', customerId);
        else changedCustomer = customerId;
      }
      await c.query(
        `INSERT INTO billing_outbox (dedupe_key, topic, customer_id, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (dedupe_key) DO NOTHING`,
        [`${provider}:${event.eventId}`, `billing.${event.type}`, customerId,
          JSON.stringify({ provider, eventId: event.eventId, type: event.type, revision: event.revision ?? null, occurredAt: event.occurredAt, applied: status === 'applied', invoice: event.invoice ?? null })]);
      return await finish(status, { customerId, changedCustomer }, null, customerId);
    } catch (err) {
      await c.query('ROLLBACK TO SAVEPOINT apply_sp');
      await c.query(`UPDATE billing_inbox SET status = 'failed', error = $2, attempts = attempts + 1 WHERE id = $1`, [inboxId, String(err.message).slice(0, 300)]);
      await c.query('RELEASE SAVEPOINT apply_sp');
      return { status: 'failed', failed: true };
    }
  }

  async _applySnapshot(c, customerId, provider, event) {
    const s = event.subscription;
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`sub:${customerId}`]);
    // Store purchases (App Store / Google Play via RevenueCat) belong to PERSONAL accounts only. A link that points one at an
    // organization (an administrator's mistake or an attack) never grants the organization anything.
    if (provider === 'revenuecat') {
      const kind = (await c.query('SELECT kind FROM customers WHERE id = $1', [customerId])).rows[0]?.kind;
      if (kind !== 'personal') {
        await c.query(`INSERT INTO security_events (event_type, severity, customer_id, details) VALUES ('store_purchase_for_non_personal', 'critical', $1, $2)`,
          [customerId, JSON.stringify({ provider, eventId: event.eventId })]);
        return 'conflict';
      }
    }
    const cur = (await c.query(
      `SELECT provider, external_id, provider_revision,
              (status IN ('active','trialing','past_due','paused') AND greatest(current_period_end, coalesce(grace_period_ends_at, current_period_end)) > now()) AS live
         FROM subscriptions WHERE customer_id = $1 FOR UPDATE`, [customerId])).rows[0];
    // The underlying PURCHASE (a Stripe subscription, an App Store / Play original transaction) can belong to one customer only,
    // whichever provider reports it. This is what stops the same purchase being applied twice or moved to another account.
    if (event.purchase) {
      const owner = (await c.query('SELECT customer_id FROM purchase_identities WHERE source = $1 AND source_id = $2', [event.purchase.source, event.purchase.id])).rows[0];
      if (owner && owner.customer_id !== customerId) {
        await c.query(`INSERT INTO security_events (event_type, severity, customer_id, details) VALUES ('purchase_claimed_by_other_customer', 'critical', $1, $2)`,
          [customerId, JSON.stringify({ provider, eventId: event.eventId, source: event.purchase.source })]);
        return 'conflict';
      }
    }
    // The provider's subscription id must belong to THIS customer only. Seeing it on another tenant is a mapping error or an attack.
    const clash = await c.query('SELECT 1 FROM subscriptions WHERE provider = $1 AND external_id = $2 AND customer_id <> $3', [provider, s.externalId, customerId]);
    if (clash.rowCount) {
      await c.query(`INSERT INTO security_events (event_type, severity, customer_id, details) VALUES ('webhook_subscription_collision', 'critical', $1, $2)`,
        [customerId, JSON.stringify({ provider, eventId: event.eventId })]);
      return 'conflict';
    }
    const vals = [provider, s.externalId, event.revision, s.planCode, s.status, s.quantity ?? 1, s.trialEndsAt ?? null,
      s.currentPeriodStart, s.currentPeriodEnd, s.gracePeriodEndsAt ?? null, s.cancelAtPeriodEnd === true, s.canceledAt ?? null, s.pausedAt ?? null, customerId];
    const remember = async () => {
      if (event.purchase) await c.query('INSERT INTO purchase_identities (source, source_id, customer_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [event.purchase.source, event.purchase.id, customerId]);
      await c.query("UPDATE checkout_intents SET status = 'completed' WHERE customer_id = $1 AND status = 'open'", [customerId]);
    };
    if (!cur) {
      await c.query(
        `INSERT INTO subscriptions (provider, external_id, provider_revision, plan_code, status, quantity, trial_ends_at,
           current_period_start, current_period_end, grace_period_ends_at, cancel_at_period_end, canceled_at, paused_at, customer_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, vals);
      await remember();
      return 'created';
    }
    // A customer has one subscription, owned by one provider. While it is LIVE, a different provider or subscription id is a second,
    // overlapping subscription (double billing): it is never merged, and an operator is alerted so the duplicate can be refunded.
    // Once the existing one has ended, the customer may legitimately start over - on any channel.
    const differs = (cur.provider && cur.provider !== provider) || (cur.external_id && cur.external_id !== s.externalId);
    if (differs && cur.live) {
      await c.query(`INSERT INTO security_events (event_type, severity, customer_id, details) VALUES ('duplicate_subscription_detected', 'critical', $1, $2)`,
        [customerId, JSON.stringify({ existingProvider: cur.provider, incomingProvider: provider, eventId: event.eventId })]);
      return 'conflict';
    }
    if (!differs && Number(event.revision) <= Number(cur.provider_revision)) return 'stale';
    await c.query(
      `UPDATE subscriptions SET provider=$1, external_id=$2, provider_revision=$3, plan_code=$4, status=$5, quantity=$6, trial_ends_at=$7,
         current_period_start=$8, current_period_end=$9, grace_period_ends_at=$10, cancel_at_period_end=$11, canceled_at=$12, paused_at=$13
       WHERE customer_id=$14`, vals);
    await remember();
    return 'updated';
  }

  /** Re-drives a stored event (for example after an administrator linked the missing customer). Skips signature checks: it was verified on receipt. */
  async redrive(provider, eventId) {
    await ensureSearchPath(this.pool);
    const out = await this._tx(async (c) => {
      const row = (await c.query(`SELECT id, status, payload, raw_sha256 FROM billing_inbox WHERE provider = $1 AND event_id = $2 AND status IN ('dead','failed') FOR UPDATE`, [provider, eventId])).rows[0];
      if (!row) return { status: 'not_redrivable' };
      const event = validateEvent(provider, row.payload);
      await c.query(`UPDATE billing_inbox SET status = 'received', attempts = 0 WHERE id = $1`, [row.id]);
      return this._apply(c, row.id, provider, event);
    });
    if (out.changedCustomer) this.onSubscriptionChanged(out.changedCustomer);
    return out;
  }

  /**
   * Compare with the provider's authoritative state. `fetchSnapshot({provider, externalId, externalCustomerId})` returns
   * { revision, subscription } and is supplied by the provider-specific code.
   */
  async reconcile(customerId, provider, fetchSnapshot) {
    await ensureSearchPath(this.pool);
    const link = (await this.pool.query('SELECT external_customer_id FROM billing_customers WHERE provider = $1 AND customer_id = $2', [provider, customerId])).rows[0];
    if (!link) return { status: 'not_linked' };
    const sub = (await this.pool.query('SELECT external_id, provider_revision, plan_code, status, current_period_end FROM subscriptions WHERE customer_id = $1', [customerId])).rows[0];
    const snap = await fetchSnapshot({ provider, externalId: sub?.external_id ?? null, externalCustomerId: link.external_customer_id });
    if (!snap?.subscription || !Number.isSafeInteger(snap.revision)) return { status: 'no_snapshot' };
    const drift = !sub || sub.plan_code !== snap.subscription.planCode || sub.status !== snap.subscription.status
      || new Date(sub.current_period_end).getTime() !== new Date(snap.subscription.currentPeriodEnd).getTime();
    if (drift) await this._security('reconcile_drift', 'warning', customerId, { provider, localRevision: sub ? Number(sub.provider_revision) : null, providerRevision: snap.revision });
    const event = validateEvent(provider, {
      provider, eventId: `reconcile:${snap.subscription.externalId}:${snap.revision}`, type: 'subscription.updated', revision: snap.revision,
      occurredAt: new Date().toISOString(), externalCustomerId: link.external_customer_id, subscription: snap.subscription,
    });
    const raw = JSON.stringify(event);
    return { ...(await this._process(provider, event, createHash('sha256').update(raw).digest('hex'), JSON.parse(raw))), drift };
  }

  /** Publishes pending outbox rows at-least-once. `publish(row)` must be idempotent on row.dedupe_key. */
  async drainOutbox(publish, { batch = 50 } = {}) {
    await ensureSearchPath(this.pool);
    return this._tx(async (c) => {
      const { rows } = await c.query(
        `SELECT id, dedupe_key, topic, customer_id, payload FROM billing_outbox WHERE published_at IS NULL
          ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [batch]);
      let published = 0; let failed = 0;
      for (const row of rows) {
        await c.query('SAVEPOINT pub_sp');
        try {
          await publish(row);
          await c.query('UPDATE billing_outbox SET published_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1', [row.id]);
          published++;
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT pub_sp');
          await c.query('UPDATE billing_outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1', [row.id, String(e.message).slice(0, 300)]);
          failed++;
        }
        await c.query('RELEASE SAVEPOINT pub_sp');
      }
      return { published, failed };
    });
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}
