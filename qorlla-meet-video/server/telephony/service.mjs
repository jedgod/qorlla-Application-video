// Qorlla Telephony v2 service: authorization, workflows, workers and the usage ledger. Every action is checked here, whatever the page sent.
import { err, normalizeE164, assertAdmin, assertActor, screenDestination, allowedCountries, nextState, fromTwilioStatus, TERMINAL, deriveCapabilities } from './core.mjs';

const KEY = /^[A-Za-z0-9_.:-]{8,80}$/;
const last4 = (n) => String(n || '').slice(-4);
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

export class TelephonyService {
  constructor({ db, carrier, bridge, audio, env = process.env }) { Object.assign(this, { db, carrier, bridge, audio, env }); }

  async audit(actorId, action, subject, detail) { await this.db.query('INSERT INTO qphone_audit(actor_id,action,subject,detail) VALUES($1,$2,$3,$4)', [actorId || null, action, subject || null, JSON.stringify(detail || {})]).catch(() => {}); }

  // ------------------------------------------------------------------ evidence and capabilities
  async providerStatus() { const { rows: [r] } = await this.db.query('SELECT * FROM qphone_provider_status WHERE provider=$1', [this.carrier.name]); return r || null; }
  async gates() { const { rows } = await this.db.query('SELECT gate, certified_at FROM qphone_gates'); const g = {}; for (const r of rows) g[r.gate] = new Date(r.certified_at).toISOString(); return g; }
  async capabilities(actorId) {
    const st = await this.providerStatus(), gates = await this.gates();
    const one = async (sql, p = []) => Number((await this.db.query(sql, p)).rows[0].n);
    const caps = deriveCapabilities({ providerConfigured: this.carrier.configured, healthOk: !!(st && st.health_ok), healthCheckedAt: st && st.health_checked_at ? new Date(st.health_checked_at).toISOString() : null,
      webhookVerified: !!(st && st.webhook_verified_at), webhookVerifiedAt: st && st.webhook_verified_at ? new Date(st.webhook_verified_at).toISOString() : null, gates,
      dialInCount: await one("SELECT count(*)::int AS n FROM qphone_numbers WHERE kind='dialin' AND state='active'"),
      personalNumbers: actorId ? await one("SELECT count(*)::int AS n FROM qphone_numbers WHERE kind='personal' AND state='active' AND assigned_to=$1", [actorId]) : 0,
      bridgeReady: !!this.bridge.ready, reconciledUsage: await one("SELECT count(*)::int AS n FROM qphone_usage WHERE state='reconciled'") });
    return { ...caps, carrierName: this.carrier.name, webhookConfigured: !!this.carrier.webhookConfigured };
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
  async setCallerIdVerified(actor, numberId, verified) { assertAdmin(actor); await this.db.query('UPDATE qphone_numbers SET caller_id_verified=$2 WHERE id=$1', [numberId, !!verified]); await this.audit(actor.id, 'number.caller_id', numberId, { verified: !!verified }); }
  async setNumberState(actor, numberId, state) {   // suspension, release (carrier first) and reassignment are admin actions
    assertAdmin(actor); if (!['active', 'suspended', 'released'].includes(state)) throw err('INVALID_STATE', 'Choose active, suspended or released.');
    const { rows: [n] } = await this.db.query('SELECT * FROM qphone_numbers WHERE id=$1', [numberId]); if (!n) throw err('NOT_FOUND', 'Not found.', 404); if (n.state === 'released') throw err('ALREADY_RELEASED', 'That number was released.', 409);
    if (state === 'released') { await this.carrier.releaseNumber(n.provider_number_id); await this.db.query("UPDATE qphone_numbers SET state='released', released_at=now() WHERE id=$1", [n.id]); }
    else await this.db.query('UPDATE qphone_numbers SET state=$2 WHERE id=$1', [n.id, state]);
    await this.audit(actor.id, 'number.' + state, n.id, { last4: last4(n.e164) }); return { id: n.id, state };
  }
  async reassignNumber(actor, numberId, to) { assertAdmin(actor); const r = await this.db.query("UPDATE qphone_numbers SET assigned_to=$2 WHERE id=$1 AND kind='personal' AND state IN ('active','suspended') RETURNING id", [numberId, String(to || '').slice(0, 64) || null]); if (!r.rowCount) throw err('NOT_FOUND', 'Not found.', 404); await this.audit(actor.id, 'number.reassigned', numberId, {}); return { id: numberId, assignedTo: to || null }; }

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
        const got = await this.carrier.provisionNumber({ e164: avail[0].e164, friendlyName: 'Qorlla ' + r.kind });
        const { rows: [n] } = await this.db.query("INSERT INTO qphone_numbers(e164,provider,provider_number_id,country,kind,assigned_to,state,confirmed_at) VALUES($1,$2,$3,$4,$5,$6,'active',now()) ON CONFLICT (e164) DO NOTHING RETURNING id", [got.e164, this.carrier.name, got.providerNumberId, r.country, r.kind, r.assign_to]);
        await this.db.query("UPDATE qphone_provisioning_requests SET state='provisioned', number_id=$2, updated_at=now() WHERE id=$1", [r.id, n ? n.id : null]);
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
  async tick() { const out = {}; for (const [k, f] of [['provisioned', () => this.runProvisioning()], ['placed', () => this.runCalls()], ['reconciled', () => this.reconcileUsage()]]) { try { out[k] = await f(); } catch (e) { console.error('[telephony]', k, e.message); } } return out; }
}
