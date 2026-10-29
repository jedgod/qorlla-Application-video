// Telephone numbers for accounts (v1.12), adapted from the "voice number pack". A number is an optional ATTRIBUTE of a voice identity; the engine still routes by extension only, and nothing here places or receives a
// telephone call (no inbound DID routing, no PSTN calling: those are separate, separately certified capabilities).
// Fail-closed by design: the module is off unless VOICE_NUMBERS_ENABLED=true; no country is enabled until VOICE_NUMBERS_COUNTRIES names it; no provider is connected (the default provider refuses every operation; a
// mock exists for tests and is refused when NODE_ENV=production); a number is only ever shown to its owner and only once the provider's SIGNED event says it is active.
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

export class NumberError extends Error { constructor(code, status = 409) { super(code); this.code = code; this.status = status; } }
const LIVE = "('pending','active','suspended','release_pending')";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validCountry = (v) => typeof v === 'string' && /^[A-Z]{2}$/.test(v);

/** The only provider that exists today: it refuses everything. A real carrier adapter replaces this (authenticated, idempotent, TLS-verified; see docs). */
export const disabledProvider = { async provision() { throw new Error('PROVIDER_NOT_CONFIGURED'); }, async release() { throw new Error('PROVIDER_NOT_CONFIGURED'); } };
/** For tests only. It records what it was asked and never talks to anything. */
export function mockProvider({ fail = () => false } = {}) { const calls = []; return { calls, async provision(i) { calls.push(['provision', i]); if (fail(i, 'provision')) throw new Error('MOCK_FAILURE'); }, async release(i) { calls.push(['release', i]); if (fail(i, 'release')) throw new Error('MOCK_FAILURE'); } }; }

export function numbersConfig(env = process.env) {
  const enabled = String(env.VOICE_NUMBERS_ENABLED || '').toLowerCase() === 'true';
  const secret = env.VOICE_NUMBERS_WEBHOOK_SECRET || '', countries = new Set(String(env.VOICE_NUMBERS_COUNTRIES || '').split(',').map((x) => x.trim().toUpperCase()).filter(validCountry));
  const mode = String(env.VOICE_NUMBERS_PROVIDER || 'disabled').toLowerCase();
  if (mode === 'mock' && env.NODE_ENV === 'production') throw new Error('VOICE_NUMBERS_PROVIDER=mock is refused in production');
  if (!['disabled', 'mock'].includes(mode)) throw new Error('VOICE_NUMBERS_PROVIDER must be disabled or mock until a carrier adapter is installed');
  return { enabled, secret, webhookReady: secret.length >= 32, countries, mode, worker: String(env.VOICE_NUMBERS_WORKER || '').toLowerCase() === 'true', replayWindowSeconds: Number(env.VOICE_NUMBERS_REPLAY_SECONDS || 300), maxAttempts: Number(env.VOICE_NUMBERS_MAX_ATTEMPTS || 10) };
}

export function createNumbers({ tx, db, config, provider = disabledProvider, now = () => Date.now() }) {
  const audit = (c, actor, account, action, resource, details = {}) => c.query('INSERT INTO voice_num_audit(actor, subject_account_id, action, resource_id, details) VALUES($1,$2,$3,$4,$5)', [actor, account, action, resource, JSON.stringify(details)]);
  const requireOn = () => { if (!config.enabled) throw new NumberError('numbers_disabled', 503); };

  // ---- administrators (server to server): the evidence and the inventory are never supplied by a user
  /** Country evidence comes from a trusted verification the main app performed. An IP-derived suggestion can be stored but never qualifies. */
  async function recordEvidence({ accountId, country, kind, verifiedBy, expiresAt }) {
    requireOn(); if (!validCountry(country) || !['ip_suggestion', 'verified_residency', 'verified_business'].includes(kind) || typeof accountId !== 'string') throw new NumberError('invalid_input', 400);
    if (kind !== 'ip_suggestion' && (typeof verifiedBy !== 'string' || !verifiedBy || verifiedBy.length > 128)) throw new NumberError('invalid_input', 400);
    if (expiresAt != null && !Number.isFinite(Date.parse(expiresAt))) throw new NumberError('invalid_input', 400);
    return tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM voice_identities WHERE account_id=$1', [accountId])).rowCount) throw new NumberError('not_found', 404);
      const r = await c.query('INSERT INTO voice_num_country_evidence(account_id, country_code, kind, verified_by, expires_at) VALUES($1,$2,$3,$4,$5) RETURNING id', [accountId, country, kind, verifiedBy || null, expiresAt || null]);
      await audit(c, verifiedBy || 'system', accountId, 'number.evidence.recorded', r.rows[0].id, { country, kind }); return { id: r.rows[0].id };
    });
  }
  /** Only numbers the provider legally controls may be imported. The number must be a valid E.164 number of the stated country. */
  async function importInventory({ provider: name, providerNumberId, e164, country, capabilities = {} }) {
    requireOn(); if (typeof name !== 'string' || !name || name.length > 64 || typeof providerNumberId !== 'string' || !providerNumberId || providerNumberId.length > 128 || !validCountry(country) || typeof capabilities !== 'object' || capabilities === null) throw new NumberError('invalid_input', 400);
    const p = typeof e164 === 'string' ? parsePhoneNumberFromString(e164) : null;
    if (!p || !p.isValid() || p.number !== e164 || p.country !== country) throw new NumberError('invalid_number', 400);
    try { const r = await tx((c) => c.query('INSERT INTO voice_num_inventory(provider, provider_number_id, e164, country_code, capabilities) VALUES($1,$2,$3,$4,$5) RETURNING id', [name, providerNumberId, e164, country, JSON.stringify(capabilities)])); return { id: r.rows[0].id }; }
    catch (e) { if (e.code === '23505') throw new NumberError('number_exists', 409); throw e; }
  }

  // ---- the account holder
  async function me(account) {
    requireOn();
    const r = await db.query(`SELECT i.extension, a.id AS assignment_id, a.status, n.e164, n.country_code FROM voice_identities i LEFT JOIN LATERAL (
      SELECT * FROM voice_num_assignments WHERE account_id = i.account_id AND status IN ${LIVE} ORDER BY created_at DESC LIMIT 1) a ON true LEFT JOIN voice_num_inventory n ON n.id = a.inventory_id WHERE i.account_id = $1`, [account]);
    const row = r.rows[0]; if (!row) throw new NumberError('not_found', 404);
    // The number itself is shown only once the provider has confirmed it is active (or while it is suspended/being released); a pending request shows only the country.
    return { extension: row.extension, number: row.assignment_id ? { status: row.status, country: row.country_code, e164: ['active', 'suspended', 'release_pending'].includes(row.status) ? row.e164 : null } : null };
  }
  async function assign(account, country, key) {
    requireOn(); if (!validCountry(country)) throw new NumberError('invalid_input', 400); if (typeof key !== 'string' || !UUID.test(key)) throw new NumberError('idempotency_key_required', 400);
    if (!config.countries.has(country)) throw new NumberError('country_not_enabled', 422);
    const hash = createHash('sha256').update('assign:' + country).digest('hex');
    return tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['voice-num:' + account]);
      if (!(await c.query('SELECT 1 FROM voice_identities WHERE account_id=$1 AND enabled=true', [account])).rowCount) throw new NumberError('voice_disabled', 403);
      const seen = (await c.query('SELECT id, status, request_hash FROM voice_num_assignments WHERE account_id=$1 AND request_key=$2', [account, key])).rows[0];
      if (seen) { if (seen.request_hash !== hash) throw new NumberError('idempotency_key_reused', 422); return { id: seen.id, status: seen.status, reused: true }; }
      if ((await c.query(`SELECT 1 FROM voice_num_assignments WHERE account_id=$1 AND status IN ${LIVE}`, [account])).rowCount) throw new NumberError('already_assigned');
      if (!(await c.query(`SELECT 1 FROM voice_num_country_evidence WHERE account_id=$1 AND country_code=$2 AND kind IN ('verified_residency','verified_business') AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`, [account, country])).rowCount) throw new NumberError('country_verification_required', 403);
      const free = (await c.query("SELECT id FROM voice_num_inventory WHERE country_code=$1 AND status='available' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1", [country])).rows[0];
      if (!free) throw new NumberError('no_number_inventory', 409);
      await c.query("UPDATE voice_num_inventory SET status='reserved' WHERE id=$1", [free.id]);
      const id = randomUUID();
      await c.query("INSERT INTO voice_num_assignments(id, account_id, inventory_id, status, request_key, request_hash) VALUES($1,$2,$3,'pending',$4,$5)", [id, account, free.id, key, hash]);
      await c.query("INSERT INTO voice_num_outbox(assignment_id, action) VALUES($1,'provision')", [id]);
      await audit(c, account, account, 'number.assignment.requested', id, { country }); return { id, status: 'pending', reused: false };
    });
  }
  async function release(account) {
    requireOn();
    return tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['voice-num:' + account]);
      const a = (await c.query("SELECT id, status FROM voice_num_assignments WHERE account_id=$1 AND status IN ('active','suspended','release_pending') FOR UPDATE", [account])).rows[0];
      if (!a) throw new NumberError('no_releasable_number', 404);
      if (a.status !== 'release_pending') {
        await c.query("UPDATE voice_num_assignments SET status='release_pending', updated_at=now() WHERE id=$1", [a.id]); await c.query("INSERT INTO voice_num_outbox(assignment_id, action) VALUES($1,'release') ON CONFLICT DO NOTHING", [a.id]);
        await audit(c, account, account, 'number.release.requested', a.id);
      }
      return { id: a.id, status: 'release_pending' };
    });
  }

  // ---- the provider's signed events (raw body: the signature covers the exact bytes)
  /** Signature: HMAC-SHA256 over `${timestamp}.${rawBody}` (hex), timestamp in seconds, accepted within the replay window. The scheme is a demonstration contract: replace it with the carrier's real one. */
  const sign = (secret, ts, raw) => createHmac('sha256', secret).update(`${ts}.`).update(raw).digest('hex');
  async function ingest(raw, headers) {
    requireOn(); if (!config.webhookReady) throw new NumberError('webhook_not_configured', 503); if (!Buffer.isBuffer(raw)) throw new NumberError('invalid_body', 400);
    const ts = String(headers['x-qorlla-timestamp'] || ''), sig = String(headers['x-qorlla-signature'] || '');
    if (!/^\d{10}$/.test(ts) || Math.abs(now() / 1000 - Number(ts)) > config.replayWindowSeconds) throw new NumberError('stale_or_missing_timestamp', 401);
    if (!/^[0-9a-f]{64}$/.test(sig) || !timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(sign(config.secret, ts, raw), 'hex'))) throw new NumberError('invalid_signature', 401);
    let event; try { event = JSON.parse(raw.toString('utf8')); } catch { throw new NumberError('invalid_body', 400); }
    const types = { 'number.activated': ['pending', 'active', 'assigned'], 'number.released': ['release_pending', 'released', 'quarantined'], 'number.suspended': ['active', 'suspended', 'assigned'], 'number.provision_failed': ['pending', 'failed', 'quarantined'] };
    if (!event || typeof event.id !== 'string' || event.id.length < 8 || event.id.length > 128 || !types[event.type] || typeof event.assignmentId !== 'string' || !UUID.test(event.assignmentId) || typeof event.providerNumberId !== 'string') throw new NumberError('invalid_body', 400);
    return tx(async (c) => {
      const stored = await c.query("INSERT INTO voice_num_provider_events(provider, event_id, payload_hash) VALUES('configured',$1,$2) ON CONFLICT DO NOTHING RETURNING event_id", [event.id, createHash('sha256').update(raw).digest('hex')]);
      if (!stored.rowCount) return { duplicate: true };
      const a = (await c.query('SELECT a.id, a.account_id, a.status, a.inventory_id, n.provider_number_id FROM voice_num_assignments a JOIN voice_num_inventory n ON n.id=a.inventory_id WHERE a.id=$1 FOR UPDATE OF a', [event.assignmentId])).rows[0];
      if (!a || a.provider_number_id !== event.providerNumberId) throw new NumberError('event_target_mismatch', 422);
      const [from, to, inv] = types[event.type];
      if (a.status !== from) { if (a.status === to) return { duplicate: true }; throw new NumberError('invalid_event_transition', 409); }       // an old or out-of-order event never moves a number backwards
      await c.query('UPDATE voice_num_assignments SET status=$2, updated_at=now() WHERE id=$1', [a.id, to]); await c.query('UPDATE voice_num_inventory SET status=$2 WHERE id=$1', [a.inventory_id, inv]);
      await audit(c, 'provider', a.account_id, event.type, a.id); return { duplicate: false, status: to };
    });
  }

  // ---- the worker: submits provision/release requests to the provider (submission is NOT activation: only a signed event activates)
  async function runWorkerOnce() {
    const jobs = await tx(async (c) => {
      const r = await c.query(`SELECT id FROM voice_num_outbox WHERE (status='queued' AND next_attempt_at <= now()) OR (status='processing' AND lease_until < now()) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 10`);
      if (r.rowCount) await c.query("UPDATE voice_num_outbox SET status='processing', attempts=attempts+1, lease_until=now()+interval '2 minutes' WHERE id = ANY($1::bigint[])", [r.rows.map((x) => x.id)]);
      return r.rows;
    });
    for (const j of jobs) {
      const x = (await db.query(`SELECT o.id, o.action, o.attempts, a.id AS assignment_id, a.account_id, a.status, a.inventory_id, n.provider_number_id FROM voice_num_outbox o JOIN voice_num_assignments a ON a.id=o.assignment_id JOIN voice_num_inventory n ON n.id=a.inventory_id WHERE o.id=$1`, [j.id])).rows[0]; if (!x) continue;
      try {
        if (x.action === 'provision') { if (x.status !== 'pending') throw new Error('INVALID_PROVISION_STATE'); await provider.provision({ operationId: `qorlla-provision-${x.assignment_id}`, providerNumberId: x.provider_number_id, accountId: x.account_id }); }
        else { if (x.status !== 'release_pending') throw new Error('INVALID_RELEASE_STATE'); await provider.release({ operationId: `qorlla-release-${x.assignment_id}`, providerNumberId: x.provider_number_id }); }
        await tx(async (c) => { await c.query("UPDATE voice_num_outbox SET status='done', lease_until=NULL WHERE id=$1", [x.id]); await audit(c, 'worker', x.account_id, `number.${x.action}.submitted`, x.assignment_id); });
      } catch (e) {
        const message = (e instanceof Error ? e.message : 'UNKNOWN').slice(0, 250), dead = x.attempts >= config.maxAttempts;
        await tx(async (c) => {
          await c.query(`UPDATE voice_num_outbox SET status=$3, next_attempt_at=now()+make_interval(secs => LEAST(3600, POWER(2, LEAST(attempts, 10))::int)), lease_until=NULL, last_error=$2 WHERE id=$1`, [x.id, message, dead ? 'dead' : 'queued']);
          if (dead && x.action === 'provision') {         // never leave a person waiting on "pending" for ever: the request fails and the number goes to quarantine for an administrator to inspect
            await c.query("UPDATE voice_num_assignments SET status='failed', updated_at=now() WHERE id=$1 AND status='pending'", [x.assignment_id]); await c.query("UPDATE voice_num_inventory SET status='quarantined' WHERE id=$1", [x.inventory_id]);
            await audit(c, 'worker', x.account_id, 'number.provision.gave_up', x.assignment_id, { error: message });
          }
        });
      }
    }
    return jobs.length;
  }
  async function stats() {
    const q = (await db.query(`SELECT (SELECT count(*) FROM voice_num_outbox WHERE status IN ('queued','processing'))::int AS queued, (SELECT count(*) FROM voice_num_outbox WHERE status='dead')::int AS dead,
      (SELECT count(*) FROM voice_num_assignments WHERE status='pending' AND created_at < now() - interval '1 hour')::int AS stuck_pending, (SELECT count(*) FROM voice_num_inventory WHERE status='available')::int AS available, (SELECT count(*) FROM voice_num_inventory WHERE status='quarantined')::int AS quarantined`)).rows[0];
    return { enabled: config.enabled, provider: config.mode, countries: [...config.countries], ...q };
  }
  return { me, assign, release, recordEvidence, importInventory, ingest, runWorkerOnce, stats, sign, config };
}
