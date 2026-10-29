// Qorlla Telephony v2 service: authorization, workflows, workers and the usage ledger. Every action is checked here, whatever the page sent.
import { FEATURES, FEATURE_IDS, cleanDesired, hashOf, evaluateFeature, featureSupport } from './features.mjs';
import { classifyProviderError, nextBackoffSeconds } from './number-authority.mjs';
import { err, normalizeE164, assertAdmin, assertActor, screenDestination, allowedCountries, nextState, fromTwilioStatus, TERMINAL, deriveCapabilities } from './core.mjs';

const KEY = /^[A-Za-z0-9_.:-]{8,80}$/;
const last4 = (n) => String(n || '').slice(-4);
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

export class TelephonyService {
  constructor({ db, carrier, bridge, audio, env = process.env }) { Object.assign(this, { db, carrier, bridge, audio, env }); }

  /** One transaction on a dedicated connection (the pool alone cannot hold a transaction). */
  async tx(fn) {
    const c = await this.db.connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  async audit(actorId, action, subject, detail, client) { await (client || this.db).query('INSERT INTO qphone_audit(actor_id,action,subject,detail) VALUES($1,$2,$3,$4)', [actorId || null, action, subject || null, JSON.stringify(detail || {})]).catch(() => {}); }

  // ------------------------------------------------------------------ evidence and capabilities
  async providerStatus() { const { rows: [r] } = await this.db.query('SELECT * FROM qphone_provider_status WHERE provider=$1', [this.carrier.name]); return r || null; }
  async gates() { const { rows } = await this.db.query('SELECT gate, certified_at FROM qphone_gates'); const g = {}; for (const r of rows) g[r.gate] = new Date(r.certified_at).toISOString(); return g; }
  // Independent feature flags (PHONE_FEATURES, a comma list of: dialin, carrier, bridge, billing, settings). Default: none. A flag AND a certified gate are both required.
  flags() { return new Set(String(this.env.PHONE_FEATURES || '').split(',').map((s) => s.trim()).filter(Boolean)); }
  async capabilities(actorId) {
    const st = await this.providerStatus(), certified = await this.gates(), flags = this.flags(), gates = {}, flagsOff = [];
    for (const [k, v] of Object.entries(certified)) { if (flags.has(k)) gates[k] = v; else flagsOff.push(k); }
    const one = async (sql, p = []) => Number((await this.db.query(sql, p)).rows[0].n);
    const caps = deriveCapabilities({ providerConfigured: this.carrier.configured, healthOk: !!(st && st.health_ok), healthCheckedAt: st && st.health_checked_at ? new Date(st.health_checked_at).toISOString() : null,
      webhookVerified: !!(st && st.webhook_verified_at), webhookVerifiedAt: st && st.webhook_verified_at ? new Date(st.webhook_verified_at).toISOString() : null, gates,
      dialInCount: await one("SELECT count(*)::int AS n FROM qphone_numbers WHERE kind='dialin' AND state='active'"),
      personalNumbers: actorId ? await one("SELECT count(*)::int AS n FROM qphone_numbers WHERE kind='personal' AND state='active' AND assigned_to=$1", [actorId]) : 0,
      flagsOff, bridgeReady: !!this.bridge.ready, reconciledUsage: await one("SELECT count(*)::int AS n FROM qphone_usage WHERE state='reconciled'") });
    return { ...caps, carrierName: this.carrier.name, webhookConfigured: !!this.carrier.webhookConfigured, flags: [...flags] };
  }
  async testConnection(actor) {
    assertAdmin(actor);
    const h = await this.carrier.healthCheck(); const name = this.carrier.name;
    await this.db.query('INSERT INTO qphone_provider_status(provider,health_ok,health_checked_at,health_detail) VALUES($1,$2,now(),$3) ON CONFLICT (provider) DO UPDATE SET health_ok=EXCLUDED.health_ok, health_checked_at=now(), health_detail=EXCLUDED.health_detail', [name, !!h.ok, String(h.detail || '').slice(0, 300)]);
    const st = await this.providerStatus(); await this.audit(actor.id, 'provider.test_connection', name, { ok: !!h.ok });
    const webhookVerified = !!(st && st.webhook_verified_at);
    return { provider: name, configured: this.carrier.configured, ok: !!h.ok, detail: h.detail, webhookConfigured: !!this.carrier.webhookConfigured, webhookVerified,
      next: !this.carrier.configured ? 'Set PHONE_CARRIER, the carrier credentials and PHONE_PUBLIC_BASE, then restart.' : !h.ok ? 'Fix the credentials or the carrier account, then test again.' : !this.carrier.webhookConfigured ? 'Set PHONE_PUBLIC_BASE to the public https address the carrier can reach.' : !webhookVerified ? 'Place a test call to a provisioned number (or trigger a status callback) so a signed webhook is received.' : 'Connected.' };
  }

  // ------------------------------------------------------------------ numbers
  async availableNumbers(actor, country, type) {
    assertAdmin(actor); country = String(country || '').toUpperCase(); if (!/^[A-Z]{2}$/.test(country)) throw err('INVALID_COUNTRY', 'Choose a country.');
    if (!allowedCountries(this.env).has(country)) throw err('COUNTRY_NOT_ALLOWED', 'That country is not allowed for this workspace.', 403);
    return { country, numbers: this.carrier.configured ? await this.carrier.listAvailableNumbers(country, type) : [], source: this.carrier.configured ? this.carrier.name : null };
  }
  async requestNumber(actor, { country, kind = 'personal', assignTo, idempotencyKey }) {
    assertAdmin(actor); country = String(country || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw err('INVALID_COUNTRY', 'Choose a country.'); if (!['personal', 'dialin'].includes(kind)) throw err('INVALID_KIND', 'The number type is not valid.');
    if (!KEY.test(String(idempotencyKey || ''))) throw err('IDEMPOTENCY_REQUIRED', 'An idempotency key (8-80 safe characters) is required.');
    if (!allowedCountries(this.env).has(country)) throw err('COUNTRY_NOT_ALLOWED', 'That country is not allowed for this workspace.', 403);
    const st = await this.providerStatus();
    if (!this.carrier.configured) throw err('PROVIDER_NOT_CONNECTED', 'The telephone provider is not connected, so no number can be provisioned.', 503);
    if (!st || !st.health_ok) throw err('PROVIDER_NOT_VERIFIED', 'The telephone provider has not passed a connection test. Run Test connection first.', 503);
    const to = kind === 'personal' ? String(assignTo || actor.id).slice(0, 64) : null;
    if (to) {
      const acct = (await this.db.query('SELECT verified, suspended FROM qphone_accounts WHERE account_id=$1', [to])).rows[0];
      if (!acct || !acct.verified || acct.suspended) throw err('TARGET_NOT_ELIGIBLE', 'Only a verified, active account can receive a number.', 403);
      const have = await this.db.query("SELECT (SELECT count(*) FROM qphone_numbers WHERE kind='personal' AND assigned_to=$1 AND state IN ('provisioning','active','suspended','releasing')) + (SELECT count(*) FROM qphone_provisioning_requests WHERE kind='personal' AND assign_to=$1 AND state IN ('requested','processing')) AS n", [to]);
      if (Number(have.rows[0].n) > 0 && !(await this.db.query('SELECT 1 FROM qphone_provisioning_requests WHERE actor_id=$1 AND idempotency_key=$2', [actor.id, idempotencyKey])).rowCount) throw err('DUPLICATE_OWNERSHIP', 'That account already has a number or a pending request.', 409);
    }
    const { rows: [ins] } = await this.db.query('INSERT INTO qphone_provisioning_requests(actor_id,country,kind,assign_to,idempotency_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT (actor_id,idempotency_key) DO NOTHING RETURNING *', [actor.id, country, kind, to, idempotencyKey]);
    if (!ins) { const { rows: [old] } = await this.db.query('SELECT * FROM qphone_provisioning_requests WHERE actor_id=$1 AND idempotency_key=$2', [actor.id, idempotencyKey]); return { ...this.reqView(old), duplicate: true }; }
    await this.audit(actor.id, 'number.requested', ins.id, { country, kind }); return this.reqView(ins);
  }
  reqView(r) { return { id: r.id, country: r.country, kind: r.kind, state: r.state, error: r.error_code || null, numberId: r.number_id || null, createdAt: r.created_at, updatedAt: r.updated_at }; }
  async listRequests(actor) { assertAdmin(actor); return (await this.db.query('SELECT * FROM qphone_provisioning_requests ORDER BY created_at DESC LIMIT 50')).rows.map((r) => this.reqView(r)); }
  numView(n) { return { id: n.id, number: n.e164, country: n.country, kind: n.kind, state: n.state, assignedTo: n.assigned_to || null, callerIdVerified: !!n.caller_id_verified, confirmedAt: n.confirmed_at }; }
  async listNumbers(actor, { kind } = {}) {
    assertActor(actor); const where = [], p = [];
    if (kind) { p.push(kind); where.push('kind=$' + p.length); } if (!actor.admin) { p.push(actor.id); where.push("(kind='dialin' OR assigned_to=$" + p.length + ')'); }
    return (await this.db.query("SELECT * FROM qphone_numbers WHERE state='active'" + (where.length ? ' AND ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC LIMIT 200', p)).rows.map((n) => this.numView(n));
  }
  async dialInDirectory() { return (await this.db.query("SELECT e164,country FROM qphone_numbers WHERE kind='dialin' AND state='active' ORDER BY created_at")).rows.map((n) => ({ number: n.e164, code: n.country, country: n.country, label: '', tollFree: false, confirmed: true })); }
  async setCallerIdVerified(actor, numberId, verified) {
    assertAdmin(actor);
    await this.tx(async (c) => {
      const n = (await c.query('SELECT * FROM qphone_numbers WHERE id=$1 FOR UPDATE', [numberId])).rows[0]; if (!n) throw err('NOT_FOUND', 'Not found.', 404);
      if (verified === true) {
        if (n.kind !== 'personal' || n.state !== 'active' || n.hold_reason || !n.assigned_to) throw err('NOT_ELIGIBLE', 'Only an active, assigned personal number can be a verified caller ID.', 409);
        const a = (await c.query('SELECT verified, suspended FROM qphone_accounts WHERE account_id=$1', [n.assigned_to])).rows[0]; if (!a || !a.verified || a.suspended) throw err('OWNER_NOT_ELIGIBLE', 'The owning account is not verified and active.', 403);
      }
      await c.query('UPDATE qphone_numbers SET caller_id_verified=$2 WHERE id=$1', [numberId, !!verified]); await this.audit(actor.id, 'number.caller_id', numberId, { verified: !!verified }, c);
    });
  }
  /** The main app reports each account's standing here (server to server). Reassignment, caller-ID verification and provisioning read ONLY this. */
  async syncAccount({ accountId, verified, suspended, orgId }) {
    if (!/^[A-Za-z0-9_.:@-]{1,128}$/.test(String(accountId || '')) || typeof verified !== 'boolean' || typeof suspended !== 'boolean') throw err('INVALID_INPUT', 'Invalid account record.', 400);
    await this.db.query('INSERT INTO qphone_accounts(account_id, verified, suspended, org_id) VALUES($1,$2,$3,$4) ON CONFLICT (account_id) DO UPDATE SET verified=$2, suspended=$3, org_id=$4, updated_at=now()', [accountId, verified, suspended, orgId || null]);
    await this.audit(accountId, 'account.synced', accountId, { verified, suspended }); return { accountId, verified, suspended };
  }
  async setNumberState(actor, numberId, state) {   // suspension and release are admin actions; release is a durable two-phase operation
    assertAdmin(actor); if (!['active', 'suspended', 'released'].includes(state)) throw err('INVALID_STATE', 'Choose active, suspended or released.');
    if (state === 'released') return this.releaseNumber(actor, numberId);
    return this.tx(async (c) => {
      const n = (await c.query('SELECT * FROM qphone_numbers WHERE id=$1 FOR UPDATE', [numberId])).rows[0]; if (!n) throw err('NOT_FOUND', 'Not found.', 404);
      if (n.state === 'released') throw err('ALREADY_RELEASED', 'That number was released.', 409);
      if (n.state === 'releasing' || n.state === 'provisioning' || n.hold_reason) throw err('NUMBER_LOCKED', 'A provider operation on this number is unresolved.', 409);
      await c.query('UPDATE qphone_numbers SET state=$2 WHERE id=$1', [n.id, state]); await this.audit(actor.id, 'number.' + state, n.id, { last4: last4(n.e164) }, c); return { id: n.id, state };
    });
  }
  /** Release in three durable steps. (1) record the intent and mark the number 'releasing' (committed); (2) call the carrier; (3) record what we KNOW.
   *  A timeout or error is not "it did not happen": unless the carrier gave a definitive refusal (4xx) the operation stays 'uncertain', the number stays locked, and reconcile() asks the carrier. */
  async releaseNumber(actor, numberId) {
    assertAdmin(actor);
    const started = await this.tx(async (c) => {
      const n = (await c.query('SELECT * FROM qphone_numbers WHERE id=$1 FOR UPDATE', [numberId])).rows[0]; if (!n) throw err('NOT_FOUND', 'Not found.', 404);
      if (n.state === 'released') throw err('ALREADY_RELEASED', 'That number was released.', 409);
      if (n.state === 'releasing' || n.hold_reason) throw err('OUTCOME_UNCERTAIN', 'A release is already in progress or its outcome is unknown; reconcile it first.', 409);
      await c.query("UPDATE qphone_numbers SET state='releasing', state_before_release=$2 WHERE id=$1", [n.id, n.state]);
      const op = (await c.query("INSERT INTO qphone_provider_operations(kind, state, number_id, provider_number_id, e164, attempts, actor_id) VALUES('release','in_flight',$1,$2,$3,1,$4) RETURNING id", [n.id, n.provider_number_id, n.e164, actor.id])).rows[0];
      await this.audit(actor.id, 'number.release_started', n.id, { last4: last4(n.e164) }, c); return { n, opId: op.id };
    });
    let outcome, detail = null;
    try { await this.carrier.releaseNumber(started.n.provider_number_id); outcome = 'confirmed'; } catch (e) { outcome = classifyProviderError(e, 'release'); detail = String(e.code || e.message).slice(0, 120); }
    await this.settleRelease(started.opId, started.n.id, outcome, detail, actor.id);
    return { id: started.n.id, state: outcome === 'confirmed' ? 'released' : outcome === 'failed' ? started.n.state : 'releasing', outcome };
  }
  async settleRelease(opId, numberId, outcome, detail, actorId) {
    await this.tx(async (c) => {
      const n = (await c.query('SELECT * FROM qphone_numbers WHERE id=$1 FOR UPDATE', [numberId])).rows[0];
      if (outcome === 'confirmed') { await c.query("UPDATE qphone_numbers SET state='released', released_at=now(), hold_reason=NULL WHERE id=$1", [numberId]); await c.query("UPDATE qphone_provider_operations SET state='confirmed', resolved_at=now(), updated_at=now() WHERE id=$1", [opId]); }
      else if (outcome === 'failed') { await c.query('UPDATE qphone_numbers SET state=$2, hold_reason=NULL WHERE id=$1', [numberId, n.state_before_release || 'active']); await c.query("UPDATE qphone_provider_operations SET state='failed', last_error=$2, resolved_at=now(), updated_at=now() WHERE id=$1", [opId, detail]); }
      else { await c.query("UPDATE qphone_numbers SET hold_reason='release_outcome_uncertain' WHERE id=$1", [numberId]); await c.query("UPDATE qphone_provider_operations SET state='uncertain', last_error=$2, updated_at=now() WHERE id=$1", [opId, detail]); }
      await this.audit(actorId, 'number.release_' + outcome, numberId, { detail }, c);
    });
  }
  /** Ask the carrier what really happened for every unresolved operation (uncertain, or in flight longer than staleSeconds, e.g. after a crash). Never guesses: if the carrier cannot be asked, nothing changes. */
  async reconcileOperations({ staleSeconds = 120 } = {}) {
    const ops = (await this.db.query("SELECT * FROM qphone_provider_operations WHERE state='uncertain' OR (state='in_flight' AND updated_at < now() - ($1 || ' seconds')::interval) ORDER BY created_at LIMIT 50", [String(staleSeconds)])).rows;
    const out = { checked: ops.length, confirmed: 0, reverted: 0, recorded: 0, unresolved: 0 };
    for (const op of ops) {
      try {
        if (op.kind === 'release') {
          const { exists } = await this.carrier.numberExists(op.provider_number_id);
          await this.settleRelease(op.id, op.number_id, exists ? 'failed' : 'confirmed', exists ? 'reconciled: carrier still owns the number' : null, null); exists ? out.reverted++ : out.confirmed++;
        } else {
          const owned = await this.carrier.findOwnedByE164(op.e164);
          if (!owned) { await this.db.query("UPDATE qphone_provider_operations SET state='failed', resolved_at=now(), updated_at=now(), last_error='reconciled: carrier does not own the number' WHERE id=$1", [op.id]); if (op.request_id) await this.db.query("UPDATE qphone_provisioning_requests SET state='failed', error_code='NOT_PURCHASED', updated_at=now() WHERE id=$1", [op.request_id]); out.reverted++; }
          else { await this.recordPurchased(op, owned); out.recorded++; }
        }
      } catch { out.unresolved++; }
    }
    return out;
  }
  /** A number the carrier says we own but our table lacks (crash or timeout after purchase): record it, assigned only if that is still safe. */
  async recordPurchased(op, owned) {
    await this.tx(async (c) => {
      const req = op.request_id ? (await c.query('SELECT * FROM qphone_provisioning_requests WHERE id=$1 FOR UPDATE', [op.request_id])).rows[0] : null;
      let id;
      for (const assign of req && req.assign_to ? [req.assign_to, null] : [null]) {
        await c.query('SAVEPOINT ins');
        try {
          id = (await c.query("INSERT INTO qphone_numbers(e164,provider,provider_number_id,country,kind,assigned_to,state,confirmed_at,hold_reason) VALUES($1,$2,$3,$4,$5,$6,'active',now(),$7) ON CONFLICT (e164) DO NOTHING RETURNING id", [owned.e164, this.carrier.name, owned.providerNumberId, req ? req.country : 'US', req ? req.kind : 'personal', assign, assign === null && req && req.assign_to ? 'assignment_conflict_needs_review' : null])).rows[0]?.id; await c.query('RELEASE SAVEPOINT ins'); break;
        } catch (e) { await c.query('ROLLBACK TO SAVEPOINT ins'); if (e.code !== '23505') throw e; }
      }
      await c.query("UPDATE qphone_provider_operations SET state='confirmed', number_id=$2, provider_number_id=$3, resolved_at=now(), updated_at=now() WHERE id=$1", [op.id, id || null, owned.providerNumberId]);
      if (req) await c.query("UPDATE qphone_provisioning_requests SET state='provisioned', number_id=$2, error_code=NULL, updated_at=now() WHERE id=$1", [req.id, id || null]);
      await this.audit(null, 'number.recorded_by_reconcile', id || op.id, { last4: last4(owned.e164) }, c);
    });
  }
  async reassignNumber(actor, numberId, to, reason) {
    assertAdmin(actor); to = String(to || ''); reason = String(reason || '').trim();
    if (!/^[A-Za-z0-9_.:@-]{1,128}$/.test(to)) throw err('INVALID_TARGET', 'Choose the account to transfer the number to.', 400);
    if (reason.length < 3 || reason.length > 200) throw err('REASON_REQUIRED', 'A reason (3-200 characters) is required for a transfer.', 400);
    try {
      return await this.tx(async (c) => {
        const n = (await c.query('SELECT * FROM qphone_numbers WHERE id=$1 FOR UPDATE', [numberId])).rows[0]; if (!n) throw err('NOT_FOUND', 'Not found.', 404);
        if (n.kind !== 'personal') throw err('NOT_TRANSFERABLE', 'Shared dial-in numbers cannot be assigned to a person.', 409);
        if (!['active', 'suspended'].includes(n.state) || n.hold_reason) throw err('NUMBER_LOCKED', 'The number is not in a state that can be transferred (release in progress or provider outcome unknown).', 409);
        if (n.assigned_to === to) throw err('NO_CHANGE', 'The number already belongs to that account.', 409);
        const t = (await c.query('SELECT verified, suspended FROM qphone_accounts WHERE account_id=$1', [to])).rows[0];
        if (!t || !t.verified || t.suspended) throw err('TARGET_NOT_ELIGIBLE', 'The target account is not verified and active.', 403);
        if ((await c.query("SELECT 1 FROM qphone_numbers WHERE kind='personal' AND assigned_to=$1 AND state IN ('provisioning','active','suspended','releasing')", [to])).rowCount) throw err('DUPLICATE_OWNERSHIP', 'The target account already has a number.', 409);
        await c.query('UPDATE qphone_numbers SET assigned_to=$2, caller_id_verified=false WHERE id=$1', [numberId, to]);     // the new owner must verify the caller ID again
        await this.audit(actor.id, 'number.reassigned', numberId, { from: n.assigned_to, to, reason, last4: last4(n.e164) }, c); return { id: numberId, assignedTo: to, callerIdVerified: false };
      });
    } catch (e) { if (e.code === '23505') throw err('DUPLICATE_OWNERSHIP', 'The target account already has a number.', 409); throw e; }
  }
  // ---- outbox delivery: at least once, in version order per number, never skipping a version that is still undelivered
  async deliverOutbox(sink, { limit = 50 } = {}) {
    const c = await this.db.connect(); let sent = 0, failed = 0;
    try {
      if (!(await c.query("SELECT pg_try_advisory_lock(hashtextextended('qphone_outbox',0)) AS ok")).rows[0].ok) return { sent, failed, busy: true };
      try {
        const rows = (await c.query("SELECT o.* FROM qphone_number_outbox o WHERE o.delivered_at IS NULL AND o.next_attempt_at <= now() AND NOT EXISTS (SELECT 1 FROM qphone_number_outbox e WHERE e.provider_number_id=o.provider_number_id AND e.version < o.version AND e.delivered_at IS NULL) ORDER BY o.created_at, o.version LIMIT $1", [limit])).rows;
        const blocked = new Set();
        for (const r of rows) {
          if (blocked.has(r.provider_number_id)) continue;
          try { await sink({ eventId: r.event_id, providerNumberId: r.provider_number_id, version: Number(r.version), type: r.type, payload: r.payload, createdAt: r.created_at }); await c.query('UPDATE qphone_number_outbox SET delivered_at=now(), last_error=NULL WHERE event_id=$1', [r.event_id]); sent++; }
          catch (e) { failed++; blocked.add(r.provider_number_id); await c.query("UPDATE qphone_number_outbox SET attempts=attempts+1, last_error=$2, next_attempt_at=now() + ($3 || ' seconds')::interval WHERE event_id=$1", [r.event_id, String(e.message || e).slice(0, 200), String(nextBackoffSeconds(r.attempts + 1))]); }
        }
      } finally { await c.query("SELECT pg_advisory_unlock(hashtextextended('qphone_outbox',0))"); }
    } finally { c.release(); }
    return { sent, failed };
  }
  /** Everything the consumer needs to reconcile: the authoritative state of every number, at its current version. */
  async numberSnapshot() { return (await this.db.query("SELECT provider_number_id, e164, country, kind, assigned_to, state, caller_id_verified, hold_reason IS NOT NULL AS hold, authority_version FROM qphone_numbers ORDER BY created_at")).rows.map((n) => ({ providerNumberId: n.provider_number_id, e164: n.e164, country: n.country, kind: n.kind, accountId: n.assigned_to, state: n.state, callerIdVerified: n.caller_id_verified, hold: n.hold, version: Number(n.authority_version) })); }

  // Provisioning worker: request -> carrier -> confirmation -> database -> active. A request is claimed with SKIP LOCKED so two workers never buy two numbers.
  async runProvisioning() {
    await this.db.query("UPDATE qphone_provisioning_requests SET state='failed', error_code='STALE_NEEDS_REVIEW', updated_at=now() WHERE state='processing' AND updated_at < now() - interval '10 minutes'");
    let done = 0;
    for (let i = 0; i < 5; i++) {
      const { rows: [r] } = await this.db.query("UPDATE qphone_provisioning_requests SET state='processing', updated_at=now() WHERE id=(SELECT id FROM qphone_provisioning_requests WHERE state='requested' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *");
      if (!r) break;
      try {
        const avail = await this.carrier.listAvailableNumbers(r.country, 'Local'); if (!avail.length) throw err('NO_NUMBERS_AVAILABLE', 'The carrier has no numbers available there.', 409);
        await this.db.query('UPDATE qphone_provisioning_requests SET provider_reference=$2 WHERE id=$1', [r.id, avail[0].e164]);
        const opId = (await this.db.query("INSERT INTO qphone_provider_operations(kind, state, e164, request_id, attempts, actor_id) VALUES('provision','in_flight',$1,$2,1,$3) RETURNING id", [avail[0].e164, r.id, r.actor_id])).rows[0].id;
        let got; try { got = await this.carrier.provisionNumber({ e164: avail[0].e164, friendlyName: 'Qorlla ' + r.kind }); } catch (pe) { const o = classifyProviderError(pe, 'provision'); await this.db.query('UPDATE qphone_provider_operations SET state=$2, last_error=$3, updated_at=now(), resolved_at=CASE WHEN $2=\'failed\' THEN now() END WHERE id=$1', [opId, o === 'failed' ? 'failed' : 'uncertain', String(pe.code || pe.message).slice(0, 120)]); if (o !== 'failed') { await this.db.query("UPDATE qphone_provisioning_requests SET error_code='PROVIDER_OUTCOME_UNCERTAIN', updated_at=now() WHERE id=$1", [r.id]); await this.audit(r.actor_id, 'number.uncertain', r.id, {}); done++; continue; } throw pe; }
        await this.recordPurchased({ id: opId, request_id: r.id, e164: got.e164 }, { providerNumberId: got.providerNumberId, e164: got.e164 });
        await this.audit(r.actor_id, 'number.provisioned', r.id, { country: r.country, kind: r.kind, last4: last4(got.e164) });
      } catch (e) { await this.db.query("UPDATE qphone_provisioning_requests SET state='failed', error_code=$2, updated_at=now() WHERE id=$1", [r.id, String(e.code || 'PROVISIONING_FAILED').slice(0, 60)]); await this.audit(r.actor_id, 'number.failed', r.id, { code: e.code || 'PROVISIONING_FAILED' }); }
      done++;
    }
    return done;
  }

  // ------------------------------------------------------------------ outbound calls
  intentView(c) { return { id: c.id, state: c.state, destinationLast4: last4(c.destination_e164), country: c.destination_country, error: c.error_code || null, createdAt: c.created_at, answeredAt: c.answered_at, endedAt: c.ended_at }; }
  async startCall(actor, { to, fromNumberId, idempotencyKey }) {
    assertActor(actor); const dest = normalizeE164(to);
    if (!KEY.test(String(idempotencyKey || ''))) throw err('IDEMPOTENCY_REQUIRED', 'An idempotency key (8-80 safe characters) is required.');
    const { rows: [dup] } = await this.db.query('SELECT * FROM qphone_call_intents WHERE actor_id=$1 AND idempotency_key=$2', [actor.id, idempotencyKey]); if (dup) return { ...this.intentView(dup), duplicate: true };   // a retry never places a second call
    const caps = await this.capabilities(actor.id);
    if (caps.carrier.status !== 'active' || caps.provider.status !== 'active') throw err('CARRIER_NOT_ENABLED', 'Carrier calling is not enabled: ' + caps.carrier.detail, 503);
    if (!['active', 'pending'].includes(caps.billing.status)) throw err('BILLING_NOT_CERTIFIED', 'Paid calling is off until telephony billing is certified.', 503);
    if (!this.audio.ready) throw err('AUDIO_GATEWAY_NOT_CONFIGURED', 'Browser calling needs a voice gateway, which is not installed. An API call alone gives no audio.', 503);
    const scr = screenDestination(dest, this.env); if (!scr.ok) throw err(scr.code, scr.message, 403);
    const { rows: [from] } = fromNumberId ? await this.db.query("SELECT * FROM qphone_numbers WHERE id=$1 AND kind='personal' AND state='active' AND assigned_to=$2", [fromNumberId, actor.id]) : await this.db.query("SELECT * FROM qphone_numbers WHERE kind='personal' AND state='active' AND assigned_to=$1 ORDER BY created_at LIMIT 1", [actor.id]);
    if (!from) throw err('NO_NUMBER', 'You have no active Qorlla number to call from.', 409);
    const perHour = num(this.env.PHONE_MAX_CALLS_PER_HOUR, 30);
    if (Number((await this.db.query("SELECT count(*)::int AS n FROM qphone_call_intents WHERE actor_id=$1 AND created_at > now() - interval '1 hour'", [actor.id])).rows[0].n) >= perHour) throw err('RATE_LIMITED', 'Too many calls this hour. Try again later.', 429);
    const { rows: [lim] } = await this.db.query('SELECT monthly_limit_micros FROM qphone_limits WHERE owner_id=$1', [actor.id]);
    const limit = lim ? Number(lim.monthly_limit_micros) : 0, reserve = num(this.env.PHONE_RESERVE_MICROS, 500000);
    const { rows: [sp] } = await this.db.query("SELECT COALESCE((SELECT SUM(customer_charge_micros+tax_micros) FROM qphone_usage WHERE actor_id=$1 AND created_at >= date_trunc('month', now())),0) + COALESCE((SELECT SUM(CASE a.kind WHEN 'refund' THEN -a.amount_micros ELSE a.amount_micros END) FROM qphone_adjustments a JOIN qphone_usage u ON u.id=a.usage_id WHERE u.actor_id=$1 AND a.created_at >= date_trunc('month', now())),0) + COALESCE((SELECT count(*) FROM qphone_call_intents WHERE actor_id=$1 AND state IN ('queued','placing','ringing','connected')),0) * $2 AS n", [actor.id, reserve]);
    if (limit <= 0 || Number(sp.n) + reserve > limit) throw err('SPENDING_LIMIT', limit <= 0 ? 'No spending limit is set, so paid calling is off. Ask an administrator.' : 'Your monthly calling limit has been reached.', 402);
    const { rows: [c] } = await this.db.query('INSERT INTO qphone_call_intents(actor_id,from_number_id,destination_e164,destination_country,idempotency_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT (actor_id,idempotency_key) DO NOTHING RETURNING *', [actor.id, from.id, dest, scr.country, idempotencyKey]);
    if (!c) { const { rows: [again] } = await this.db.query('SELECT * FROM qphone_call_intents WHERE actor_id=$1 AND idempotency_key=$2', [actor.id, idempotencyKey]); return { ...this.intentView(again), duplicate: true }; }
    await this.audit(actor.id, 'call.requested', c.id, { country: scr.country, last4: last4(dest) }); return this.intentView(c);
  }
  async listCalls(actor) { assertActor(actor); const { rows } = await this.db.query('SELECT * FROM qphone_call_intents ' + (actor.admin ? '' : 'WHERE actor_id=$1 ') + 'ORDER BY created_at DESC LIMIT 50', actor.admin ? [] : [actor.id]); return rows.map((c) => ({ ...this.intentView(c), ...(actor.admin ? { actorId: c.actor_id } : {}) })); }
  async getCall(actor, id) { assertActor(actor); const { rows: [c] } = await this.db.query('SELECT * FROM qphone_call_intents WHERE id=$1' + (actor.admin ? '' : ' AND actor_id=$2'), actor.admin ? [id] : [id, actor.id]).catch(() => ({ rows: [] })); if (!c) throw err('NOT_FOUND', 'Not found.', 404); return this.intentView(c); }
  async endCall(actor, id) {
    assertActor(actor); const { rows: [c] } = await this.db.query('SELECT * FROM qphone_call_intents WHERE id=$1' + (actor.admin ? '' : ' AND actor_id=$2'), actor.admin ? [id] : [id, actor.id]).catch(() => ({ rows: [] })); if (!c) throw err('NOT_FOUND', 'Not found.', 404);
    if (TERMINAL.has(c.state)) return this.intentView(c);
    if (c.provider_call_id) await this.carrier.endCall(c.provider_call_id); else await this.db.query("UPDATE qphone_call_intents SET state='cancelled', ended_at=now() WHERE id=$1 AND state='queued'", [c.id]);
    await this.audit(actor.id, 'call.end_requested', c.id, {}); const { rows: [again] } = await this.db.query('SELECT * FROM qphone_call_intents WHERE id=$1', [c.id]); return this.intentView(again);
  }
  async runCalls() {
    let placed = 0;
    for (let i = 0; i < 10; i++) {
      const { rows: [c] } = await this.db.query("UPDATE qphone_call_intents SET state='placing' WHERE id=(SELECT id FROM qphone_call_intents WHERE state='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *"); if (!c) break;
      try {
        if (!this.audio.ready) throw err('AUDIO_GATEWAY_NOT_CONFIGURED', 'No voice gateway.', 503);                 // never ring a phone nobody can talk through
        const { rows: [f] } = await this.db.query('SELECT e164 FROM qphone_numbers WHERE id=$1 AND state=$2', [c.from_number_id, 'active']); if (!f) throw err('NO_NUMBER', 'The number is not active.', 409);
        const base = this.carrier.webhookBase, res = await this.carrier.startCall({ from: f.e164, to: c.destination_e164, url: base + '/api/telephony/webhooks/twilio/voice?intent=' + c.id, statusCallback: base + '/api/telephony/webhooks/twilio/status' });
        await this.db.query('UPDATE qphone_call_intents SET provider_call_id=$2, placed_at=now() WHERE id=$1', [c.id, res.providerCallId]); placed++;
      } catch (e) { await this.db.query("UPDATE qphone_call_intents SET state='failed', error_code=$2, ended_at=now() WHERE id=$1", [c.id, String(e.code || 'PLACE_FAILED').slice(0, 60)]); }
    }
    return placed;
  }
  // A carrier event for a call we placed. Duplicates are ignored by the caller (event id); here, late and out-of-order events can never move a call backwards.
  async applyCallEvent({ providerCallId, status, sequence, duration }) {
    const incoming = fromTwilioStatus(status); if (!incoming || !providerCallId) return { ignored: true };
    const { rows: [c] } = await this.db.query('SELECT * FROM qphone_call_intents WHERE provider_call_id=$1 FOR UPDATE', [providerCallId]); if (!c) return { ignored: true };
    const state = nextState(c.state, incoming), seq = sequence == null ? c.last_sequence : Math.max(c.last_sequence, sequence);
    const { rows: [u] } = await this.db.query("UPDATE qphone_call_intents SET state=$2, last_sequence=$3, answered_at=CASE WHEN $2='connected' AND answered_at IS NULL THEN now() ELSE answered_at END, ended_at=CASE WHEN $2 IN ('completed','failed','cancelled') AND ended_at IS NULL THEN now() ELSE ended_at END WHERE id=$1 RETURNING *", [c.id, state, seq]);
    if (TERMINAL.has(u.state)) {
      const local = u.answered_at && u.ended_at ? Math.max(0, Math.round((new Date(u.ended_at) - new Date(u.answered_at)) / 1000)) : 0, billable = duration == null ? local : duration;
      await this.db.query("INSERT INTO qphone_usage(call_intent_id,actor_id,provider,provider_usage_id,direction,country,billable_seconds,local_seconds) VALUES($1,$2,$3,$4,'outbound',$5,$6,$7) ON CONFLICT (provider_usage_id) DO NOTHING", [u.id, u.actor_id, this.carrier.name, providerCallId, u.destination_country, billable, local]);
    }
    return { intentId: u.id, state: u.state };
  }
  async markWebhookVerified() { await this.db.query('INSERT INTO qphone_provider_status(provider,webhook_verified_at) VALUES($1,now()) ON CONFLICT (provider) DO UPDATE SET webhook_verified_at=now()', [this.carrier.name]); }

  // ------------------------------------------------------------------ billing ledger
  // The carrier's own price and duration are authoritative. A record is reconciled only when the carrier's duration matches what Qorlla observed; otherwise it is disputed for a person to review.
  async reconcileUsage() {
    const delay = num(this.env.PHONE_RECONCILE_DELAY_S, 120), tol = num(this.env.PHONE_RECONCILE_TOLERANCE_S, 5), markup = num(this.env.PHONE_MARKUP_PERCENT, 0), tax = num(this.env.PHONE_TAX_PERCENT, 0);
    const { rows } = await this.db.query("SELECT * FROM qphone_usage WHERE state='estimated' AND created_at < now() - ($1 || ' seconds')::interval ORDER BY created_at LIMIT 25", [String(delay)]); let n = 0;
    for (const u of rows) {
      try {
        const c = await this.carrier.fetchCall(u.provider_usage_id); if (c.price == null || c.durationSeconds == null) continue;                           // the carrier has not priced it yet
        const cost = Math.round(c.price * 1e6), charge = Math.ceil(cost * (1 + markup / 100)), tx = Math.round(charge * tax / 100), ok = u.local_seconds == null || Math.abs(Number(u.local_seconds) - c.durationSeconds) <= tol;
        await this.db.query("UPDATE qphone_usage SET billable_seconds=$2, provider_cost_micros=$3, provider_currency=$4, customer_charge_micros=$5, tax_micros=$6, state=$7, reconciled_at=CASE WHEN $7='reconciled' THEN now() ELSE reconciled_at END WHERE id=$1", [u.id, c.durationSeconds, cost, String(c.priceUnit || 'USD').slice(0, 3).toUpperCase(), charge, tx, ok ? 'reconciled' : 'disputed']); n++;
      } catch (e) { /* carrier unavailable: try again next round */ }
    }
    return n;
  }
  usageView(u) { return { id: u.id, callId: u.call_intent_id, seconds: Number(u.billable_seconds), localSeconds: u.local_seconds == null ? null : Number(u.local_seconds), country: u.country, providerCost: Number(u.provider_cost_micros) / 1e6, currency: u.provider_currency, customerCharge: Number(u.customer_charge_micros) / 1e6, tax: Number(u.tax_micros) / 1e6, state: u.state, invoiceRef: u.invoice_ref, createdAt: u.created_at }; }
  async usage(actor) {
    assertActor(actor); const own = !actor.admin, p = own ? [actor.id] : [];
    const { rows } = await this.db.query('SELECT * FROM qphone_usage ' + (own ? 'WHERE actor_id=$1 ' : '') + 'ORDER BY created_at DESC LIMIT 200', p);
    const { rows: adj } = await this.db.query('SELECT a.*, u.actor_id FROM qphone_adjustments a JOIN qphone_usage u ON u.id=a.usage_id ' + (own ? 'WHERE u.actor_id=$1 ' : '') + 'ORDER BY a.created_at DESC LIMIT 100', p);
    const t = { providerCost: 0, customerCharge: 0, tax: 0, refunds: 0, adjustments: 0 }; for (const u of rows) { t.providerCost += Number(u.provider_cost_micros) / 1e6; t.customerCharge += Number(u.customer_charge_micros) / 1e6; t.tax += Number(u.tax_micros) / 1e6; }
    for (const a of adj) { if (a.kind === 'refund') t.refunds += Number(a.amount_micros) / 1e6; else t.adjustments += Number(a.amount_micros) / 1e6; }
    const { rows: [lim] } = await this.db.query('SELECT monthly_limit_micros, currency FROM qphone_limits WHERE owner_id=$1', [actor.id]);
    return { records: rows.map((u) => this.usageView(u)), adjustments: adj.map((a) => ({ id: a.id, usageId: a.usage_id, kind: a.kind, amount: Number(a.amount_micros) / 1e6, reason: a.reason, at: a.created_at })), totals: t, monthlyLimit: lim ? Number(lim.monthly_limit_micros) / 1e6 : 0, currency: lim ? lim.currency : 'USD',
      note: 'Provider cost is what the carrier charged Qorlla. Customer charge is what the account owes. They are kept apart. No invoice system is connected, so invoice references are empty.' };
  }
  async adjust(actor, usageId, { kind, amountMicros, reason }) {
    assertAdmin(actor); if (!['refund', 'adjustment'].includes(kind)) throw err('INVALID_KIND', 'Choose refund or adjustment.'); const amt = Number(amountMicros);
    if (!Number.isInteger(amt) || amt === 0 || (kind === 'refund' && amt < 0) || Math.abs(amt) > 1e9) throw err('INVALID_AMOUNT', 'The amount is not valid.'); if (String(reason || '').trim().length < 5) throw err('REASON_REQUIRED', 'Give a reason (at least 5 characters).');
    const { rows: [u] } = await this.db.query('SELECT id FROM qphone_usage WHERE id=$1', [usageId]).catch(() => ({ rows: [] })); if (!u) throw err('NOT_FOUND', 'Not found.', 404);
    const { rows: [a] } = await this.db.query('INSERT INTO qphone_adjustments(usage_id,kind,amount_micros,reason,actor_id) VALUES($1,$2,$3,$4,$5) RETURNING id', [u.id, kind, amt, String(reason).trim().slice(0, 300), actor.id]);
    await this.audit(actor.id, 'usage.' + kind, u.id, { micros: amt }); return { id: a.id };
  }
  async setLimit(actor, ownerId, micros) {
    assertAdmin(actor); const m = Number(micros); if (!Number.isInteger(m) || m < 0 || m > 1e12) throw err('INVALID_AMOUNT', 'The limit is not valid.'); const owner = String(ownerId || '').slice(0, 64); if (!owner) throw err('INVALID_OWNER', 'Choose an account.');
    await this.db.query('INSERT INTO qphone_limits(owner_id,monthly_limit_micros,updated_by) VALUES($1,$2,$3) ON CONFLICT (owner_id) DO UPDATE SET monthly_limit_micros=EXCLUDED.monthly_limit_micros, updated_by=EXCLUDED.updated_by, updated_at=now()', [owner, m, actor.id]);
    await this.audit(actor.id, 'limit.set', owner, { micros: m }); return { ownerId: owner, monthlyLimit: m / 1e6 };
  }

  // ------------------------------------------------------------------ diagnostics (state only: never secrets, PINs, or call content)
  async diagnostics(actor) {
    assertActor(actor); const caps = await this.capabilities(actor.id), st = await this.providerStatus();
    return { provider: { name: this.carrier.name, configured: this.carrier.configured, healthOk: !!(st && st.health_ok), healthCheckedAt: st && st.health_checked_at, healthDetail: st && st.health_detail, webhookConfigured: !!this.carrier.webhookConfigured, webhookVerifiedAt: st && st.webhook_verified_at },
      capabilities: caps, calls: await this.listCalls(actor), audit: actor.admin ? (await this.db.query('SELECT at, action, subject FROM qphone_audit ORDER BY id DESC LIMIT 20')).rows : undefined };
  }
  // ------------------------------------------------------------------ saved preferences vs what the carrier enforces
  // DESIRED state is what the user saved. ACTIVE means the carrier adapter applied it and we READ IT BACK. Anything else is "saved, inactive" with the reason, never "on".
  async setDesired(actor, input) {
    assertActor(actor); const d = cleanDesired(input), changed = [];
    for (const [feature, cfg] of Object.entries(d)) {
      const hash = hashOf(cfg), { rows: [old] } = await this.db.query('SELECT desired_hash, state FROM qphone_feature_state WHERE owner_id=$1 AND feature=$2', [actor.id, feature]);
      if (old && old.desired_hash === hash && old.state !== 'failed') continue;               // unchanged (saving again retries a failed one)
      const state = cfg.enabled || (old && ['active', 'drift', 'requested'].includes(old.state)) ? 'requested' : 'off';
      await this.db.query('INSERT INTO qphone_feature_state(owner_id,feature,desired,desired_hash,state) VALUES($1,$2,$3,$4,$5) ON CONFLICT (owner_id,feature) DO UPDATE SET desired=EXCLUDED.desired, desired_hash=EXCLUDED.desired_hash, state=EXCLUDED.state, error_code=NULL, updated_at=now()', [actor.id, feature, JSON.stringify(cfg), hash, state]); changed.push(feature);
    }
    if (changed.length) await this.audit(actor.id, 'features.desired', null, { changed }); return this.featureStatus(actor);
  }
  async featureStatus(actor) {
    assertActor(actor); const caps = await this.capabilities(actor.id), sup = featureSupport(this.carrier), flagOn = this.flags().has('settings');
    const { rows } = await this.db.query('SELECT * FROM qphone_feature_state WHERE owner_id=$1', [actor.id]), by = new Map(rows.map((r) => [r.feature, r])), features = {};
    for (const id of FEATURE_IDS) {
      const rec = by.get(id) || null, ev = evaluateFeature({ desired: rec ? rec.desired : null, record: rec, providerConfigured: this.carrier.configured, providerActive: caps.provider.status === 'active', flagOn, hasNumber: caps.number.status === 'active', supported: sup.has(id) });
      features[id] = { label: FEATURES[id].label, enabled: !!(rec && rec.desired && rec.desired.enabled), state: ev.state, reason: ev.reason, checkedAt: rec ? rec.checked_at : null };
    }
    return { features, enforcing: Object.values(features).filter((f) => f.state === 'active').length };
  }
  async runFeatures() {
    if (!this.carrier.configured || typeof this.carrier.applyFeature !== 'function' || typeof this.carrier.readFeature !== 'function' || !this.flags().has('settings')) return 0;
    const sup = featureSupport(this.carrier), { rows } = await this.db.query("SELECT * FROM qphone_feature_state WHERE state IN ('requested','active','drift') ORDER BY updated_at LIMIT 50"); let n = 0;
    for (const r of rows) {
      if (!sup.has(r.feature)) continue; const caps = await this.capabilities(r.owner_id); if (caps.provider.status !== 'active') continue;
      const { rows: [num] } = await this.db.query("SELECT provider_number_id FROM qphone_numbers WHERE kind='personal' AND state='active' AND assigned_to=$1 ORDER BY created_at LIMIT 1", [r.owner_id]); if (!num) continue;
      const ref = { providerNumberId: num.provider_number_id, feature: r.feature };
      try {
        if (r.state === 'active') {                                                            // reconcile: does the carrier still hold what we asked for?
          const same = hashOf(await this.carrier.readFeature(ref)) === r.desired_hash; await this.db.query('UPDATE qphone_feature_state SET checked_at=now(), state=$3 WHERE owner_id=$1 AND feature=$2', [r.owner_id, r.feature, same ? 'active' : 'drift']);
          if (!same) await this.audit(r.owner_id, 'feature.drift', r.feature, {}); n++; continue;
        }
        await this.carrier.applyFeature({ ...ref, config: r.desired });
        const ok = hashOf(await this.carrier.readFeature(ref)) === r.desired_hash, final = ok ? (r.desired.enabled ? 'active' : 'off') : 'failed';
        await this.db.query("UPDATE qphone_feature_state SET state=$3, error_code=$4, confirmed_at=CASE WHEN $3 IN ('active','off') THEN now() ELSE confirmed_at END, checked_at=now(), updated_at=now() WHERE owner_id=$1 AND feature=$2", [r.owner_id, r.feature, final, ok ? null : 'NOT_CONFIRMED']);
        await this.audit(r.owner_id, 'feature.' + final, r.feature, {}); n++;
      } catch (e) { await this.db.query("UPDATE qphone_feature_state SET state='failed', error_code=$3, checked_at=now() WHERE owner_id=$1 AND feature=$2", [r.owner_id, r.feature, String(e.code || 'APPLY_FAILED').slice(0, 60)]); await this.audit(r.owner_id, 'feature.failed', r.feature, { code: e.code || 'APPLY_FAILED' }); }
    }
    return n;
  }
  async tick() { const out = {}; for (const [k, f] of [['provisioned', () => this.runProvisioning()], ['placed', () => this.runCalls()], ['reconciled', () => this.reconcileUsage()], ['features', () => this.runFeatures()]]) { try { out[k] = await f(); } catch (e) { console.error('[telephony]', k, e.message); } } return out; }
}
