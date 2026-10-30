// Qorlla Security Shield v2.2, integrated into the voice engine (adapted from the standalone v2/v2.1 reference packs).
// Fail closed: when this module cannot decide (database error, missing configuration, unknown principal) the answer is "no", never "yes".
// Four enforcement points: workload identity, guest video admission + meeting-scoped media credentials, PSTN authorization (no dialing happens here), account/organization state.
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { isEmergencyNumber, validAccountId } from './core.mjs';

const scryptAsync = promisify(scrypt);
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const rand = () => randomBytes(32).toString('base64url');
const uuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const idText = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:@-]{1,128}$/.test(v);
export class ShieldError extends Error { constructor(code, status = 403) { super(code); this.code = code; this.status = status; } }

export const ACTIONS = ['voice.number.assign', 'org.access', 'organization.manage', 'admin.mutate'];
/** Pure policy for account/organization actions. Nothing here trusts a client-supplied flag. */
export function evaluate(c) {
  const deny = (reason, stepUp = false) => ({ allow: false, reason, stepUp });
  if (!c.known) return deny('UNKNOWN_PRINCIPAL');
  if (c.suspended || c.orgSuspended) return deny('SUSPENDED');
  if (!c.verified) return deny('IDENTITY_UNVERIFIED');
  if (c.risk >= 50) return deny(c.risk >= 80 ? 'HIGH_RISK' : 'REVIEW_REQUIRED');
  if (c.action === 'org.access' && (!c.orgId || c.orgId !== c.resourceOrgId)) return deny('CROSS_TENANT');
  if ((c.action === 'organization.manage' || c.action === 'admin.mutate') && !c.scopes.includes(c.action === 'admin.mutate' ? 'shield:admin:write' : 'org:manage')) return deny('SCOPE_MISSING');
  return { allow: true, reason: 'ALLOW', stepUp: false };
}

/** Destination classes a carrier fraud desk blocks by default. Anything the parser cannot classify is also refused. */
const ALLOWED_TYPES = new Set(['FIXED_LINE', 'MOBILE', 'FIXED_LINE_OR_MOBILE']);
export function classifyDestination(raw) {
  if (typeof raw === 'string' && isEmergencyNumber(raw.replace(/^\+/, ''))) return { ok: false, reason: 'EMERGENCY_NUMBER_NOT_SUPPORTED' };
  if (typeof raw !== 'string' || !/^\+[1-9][0-9]{6,14}$/.test(raw)) return { ok: false, reason: 'DESTINATION_INVALID' };
  const p = parsePhoneNumberFromString(raw);
  if (!p || !p.isValid() || !p.country) return { ok: false, reason: 'DESTINATION_INVALID' };
  const type = p.getType();
  if (!type || !ALLOWED_TYPES.has(type)) return { ok: false, reason: 'DESTINATION_CLASS_BLOCKED', type: type || 'UNKNOWN' };
  return { ok: true, country: p.country, e164: p.number, type };
}

/** Workload identity: `sub=scope|scope;sub2=scope` (SHIELD_WORKLOAD_ALLOWED). */
export function parseWorkloads(v) {
  const out = new Map();
  for (const part of String(v || '').split(';')) { const [sub, scopes] = part.split('='); if (sub && scopes) out.set(sub.trim(), new Set(scopes.split('|').map((s) => s.trim()).filter(Boolean))); }
  return out;
}

export function createShield({ store, db, env = process.env, jwks } = {}) {
  const { tx } = store;
  const enabled = env.SHIELD_ENABLED === 'true', workloads = parseWorkloads(env.SHIELD_WORKLOAD_ALLOWED);
  const keys = jwks || (env.SHIELD_WORKLOAD_JWKS_URL ? createRemoteJWKSet(new URL(env.SHIELD_WORKLOAD_JWKS_URL), { cooldownDuration: 10000, timeoutDuration: 5000 }) : null);
  const num = (v, d) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d; };
  const cfg = { reserveCents: num(env.SHIELD_PSTN_RESERVE_CENTS, 100), guestTtl: num(env.SHIELD_GUEST_WAIT_SECONDS, 900), mediaTtl: num(env.SHIELD_MEDIA_TOKEN_SECONDS, 120), authTtl: num(env.SHIELD_AUTH_TTL_SECONDS, 30),
    clientPerMin: num(env.SHIELD_GUEST_CLIENT_PER_MIN, 5), meetingPerMin: num(env.SHIELD_GUEST_MEETING_PER_MIN, 20), meetingFailLock: num(env.SHIELD_GUEST_MEETING_FAIL_LOCK, 30) };

  async function audit(c, actor, action, decision, reason, requestId = null) { await c.query('INSERT INTO shield_events(actor, action, decision, reason, request_id) VALUES($1,$2,$3,$4,$5)', [actor, action, decision, reason, requestId]); }
  /** Atomic counter: true while the bucket is under its ceiling. */
  async function bump(c, bucket, windowSec, max) {
    const r = await c.query('INSERT INTO shield_counters(bucket, window_start, n) VALUES($1, to_timestamp(floor(extract(epoch from now())/$2::int)*$2::int), 1) ON CONFLICT (bucket, window_start) DO UPDATE SET n = shield_counters.n + 1 WHERE shield_counters.n < $3 RETURNING n', [bucket, windowSec, max]);
    return r.rowCount === 1;
  }

  /** Express middleware factory: a short-lived workload credential (JWT) naming the calling service and the scope it needs. Replay-protected (jti), expiry-capped. */
  const requireWorkload = (scope) => async (req, res, next) => {
    try {
      if (!enabled) return res.status(503).json({ error: 'shield_disabled' });
      const token = (req.get('authorization') || '').match(/^Bearer (\S+)$/)?.[1];
      if (!keys || !env.SHIELD_WORKLOAD_ISSUER || !workloads.size || !token) return res.status(401).json({ error: 'unauthorized' });
      const { payload } = await jwtVerify(token, keys, { issuer: env.SHIELD_WORKLOAD_ISSUER, audience: 'qorlla-shield', algorithms: ['RS256', 'ES256'], clockTolerance: 5 });
      if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string' || payload.jti.length < 16 || !payload.exp || !payload.iat || payload.exp - payload.iat > 300) return res.status(401).json({ error: 'unauthorized' });
      const scopes = workloads.get(payload.sub);
      if (!scopes || !scopes.has(scope)) { await db.query('INSERT INTO shield_events(actor, action, decision, reason) VALUES($1,$2,$3,$4)', [String(payload.sub).slice(0, 128), 'workload.' + scope, 'DENY', 'WORKLOAD_NOT_AUTHORIZED']).catch(() => {}); return res.status(403).json({ error: 'forbidden' }); }
      const fresh = await db.query('INSERT INTO shield_workload_jti(jti_hash, expires_at) VALUES($1, to_timestamp($2)) ON CONFLICT DO NOTHING RETURNING 1', [sha(payload.jti), payload.exp + 60]);
      if (!fresh.rowCount) return res.status(401).json({ error: 'unauthorized' });
      req.workload = payload.sub; next();
    } catch { res.status(401).json({ error: 'unauthorized' }); }
  };
  /** The admin routes' alternative to the shared secret. Returns true when the request carries a valid workload credential with scope voice.admin. */
  async function workloadOkForAdmin(req) {
    let ok = false; await requireWorkload('voice.admin')(req, { status: () => ({ json: () => {} }) }, () => { ok = true; }); return ok;
  }

  // ---- principals / organizations (written only by the trusted main app through workload credentials)
  const upsertPrincipal = ({ accountId, orgId, verified, billingHold }) => tx(async (c) => {
    if (billingHold !== undefined && typeof billingHold !== 'boolean') throw new ShieldError('invalid_input', 400);
    if (!validAccountId(accountId) || (orgId != null && !idText(orgId)) || (verified !== undefined && typeof verified !== 'boolean')) throw new ShieldError('invalid_input', 400);
    // a field that is ABSENT is left as it is (a billing-only update must not un-verify anyone)
    // orgId ABSENT = keep the organization the authoritative backend assigned; the main app reports verification and suspension, it does not decide tenancy
    await c.query('INSERT INTO shield_principals(account_id, org_id, verified, billing_hold) VALUES($1,$2,COALESCE($3,false),COALESCE($5,false)) ON CONFLICT (account_id) DO UPDATE SET org_id = CASE WHEN $4::boolean THEN $2 ELSE shield_principals.org_id END, verified = COALESCE($3, shield_principals.verified), billing_hold = COALESCE($5, shield_principals.billing_hold), updated_at=now()', [accountId, orgId ?? null, verified === undefined ? null : verified, orgId !== undefined, billingHold === undefined ? null : billingHold]);
    await audit(c, accountId, 'principal.upsert', 'ALLOW', 'ADMIN'); return { accountId, orgId, verified };
  });
  const upsertOrg = ({ orgId, pstnEnabled = false, allowedCountries = [], maxActiveCalls = 2, maxCallsHour = 30, spendLimitCents = 0 }) => tx(async (c) => {
    if (!idText(orgId) || !Array.isArray(allowedCountries) || !allowedCountries.every((x) => /^[A-Z]{2}$/.test(x)) || ![maxActiveCalls, maxCallsHour, spendLimitCents].every((x) => Number.isInteger(x) && x >= 0)) throw new ShieldError('invalid_input', 400);
    await c.query('INSERT INTO shield_orgs(org_id, pstn_enabled, allowed_countries, max_active_calls, max_calls_hour, spend_limit_cents) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (org_id) DO UPDATE SET pstn_enabled=$2, allowed_countries=$3, max_active_calls=$4, max_calls_hour=$5, spend_limit_cents=$6', [orgId, !!pstnEnabled, allowedCountries, maxActiveCalls, maxCallsHour, spendLimitCents]);
    await audit(c, orgId, 'org.upsert', 'ALLOW', 'ADMIN'); return { orgId };
  });
  const passHash = async (passcode, salt) => scryptAsync(String(passcode), salt, 32);
  const upsertMeeting = ({ meetingId, orgId, hostAccountId, passcode, guestEnabled = false, requiresApproval = true, maxGuests = 50, endsAt }) => tx(async (c) => {
    if (!idText(meetingId) || !idText(orgId) || !validAccountId(hostAccountId) || typeof passcode !== 'string' || passcode.length < 6 || passcode.length > 64 || !Number.isInteger(maxGuests) || Number.isNaN(Date.parse(endsAt))) throw new ShieldError('invalid_input', 400);
    const salt = randomBytes(16), hash = await passHash(passcode, salt);
    await c.query('INSERT INTO shield_meetings(meeting_id, org_id, host_account_id, passcode_salt, passcode_hash, guest_enabled, requires_approval, max_guests, ends_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (meeting_id) DO UPDATE SET org_id=$2, host_account_id=$3, passcode_salt=$4, passcode_hash=$5, guest_enabled=$6, requires_approval=$7, max_guests=$8, ends_at=$9', [meetingId, orgId, hostAccountId, salt, hash, !!guestEnabled, !!requiresApproval, maxGuests, endsAt]);
    await audit(c, hostAccountId, 'meeting.upsert', 'ALLOW', 'ADMIN'); return { meetingId };
  });

  /** Emergency suspension: the person loses protected access everywhere at once (API tokens, outstanding authorizations, active PSTN calls, voice identity, open sockets). */
  async function setSuspended(accountId, suspended, { onVoiceDisabled, source = 'legacy' } = {}) {
    if (!validAccountId(accountId) || typeof source !== 'string' || source.length > 128) throw new ShieldError('invalid_input', 400);
    const out = await tx(async (c) => {
      const r = suspended
        ? await c.query('UPDATE shield_principals SET suspend_holds = ARRAY(SELECT DISTINCT x FROM unnest(suspend_holds || $2::text) x), suspended=true, tokens_valid_after=now(), updated_at=now() WHERE account_id=$1 RETURNING account_id', [accountId, source])
        : await c.query('UPDATE shield_principals SET suspend_holds = array_remove(suspend_holds, $2::text), suspended = cardinality(array_remove(suspend_holds, $2::text)) > 0, updated_at=now() WHERE account_id=$1 RETURNING account_id, suspended', [accountId, source]);
      if (!r.rowCount) throw new ShieldError('unknown_principal', 404);
      let terminate = [];
      if (suspended) {
        await c.query("UPDATE shield_authorizations SET state='revoked' WHERE account_id=$1 AND state='authorized'", [accountId]);
        terminate = (await c.query("SELECT id FROM shield_authorizations WHERE account_id=$1 AND state='active'", [accountId])).rows.map((x) => x.id);
      }
      await audit(c, accountId, suspended ? 'principal.suspend' : 'principal.restore', 'ALLOW', source); return { accountId, suspended: suspended ? true : !!r.rows[0].suspended, terminate };
    });
    if (suspended) { await store.setEnabled(accountId, false).catch(() => {}); onVoiceDisabled?.(accountId); }
    else if (!out.suspended) await store.setEnabled(accountId, true).catch(() => {});                       // every hold lifted: the voice identity comes back
    return out;
  }
  async function setOrgSuspended(orgId, suspended) {
    return tx(async (c) => {
      const r = await c.query('UPDATE shield_orgs SET suspended=$2 WHERE org_id=$1 RETURNING org_id', [orgId, !!suspended]); if (!r.rowCount) throw new ShieldError('unknown_org', 404);
      let terminate = [];
      if (suspended) { await c.query("UPDATE shield_authorizations SET state='revoked' WHERE org_id=$1 AND state='authorized'", [orgId]); terminate = (await c.query("SELECT id FROM shield_authorizations WHERE org_id=$1 AND state='active'", [orgId])).rows.map((x) => x.id); }
      await audit(c, orgId, suspended ? 'org.suspend' : 'org.restore', 'ALLOW', 'ADMIN'); return { orgId, suspended: !!suspended, terminate };
    });
  }

  // ---- user-facing checks (a verified end-user token, never a workload)
  /** Throws unless the verified token still belongs to an active, unsuspended principal. `claims` come from the engine's real verifier (iat required). */
  async function assertPrincipalActive(accountId, iat, { requireVerified = false } = {}) {
    const p = (await store.tx((c) => c.query('SELECT p.suspended, p.verified, p.tokens_valid_after, o.suspended AS org_suspended FROM shield_principals p LEFT JOIN shield_orgs o ON o.org_id = p.org_id WHERE p.account_id=$1', [accountId]))).rows[0];
    if (!p) throw new ShieldError('unknown_principal', 401);
    if (p.suspended || p.org_suspended) throw new ShieldError('suspended', 403);
    if (requireVerified && !p.verified) throw new ShieldError('identity_unverified', 403);
    if (!Number.isFinite(iat) || iat * 1000 < new Date(p.tokens_valid_after).getTime()) throw new ShieldError('token_revoked', 401);
  }
  async function authorizeUser({ accountId, iat, action, resourceOrgId = null, scopes = [] }) {
    if (!ACTIONS.includes(action)) throw new ShieldError('invalid_input', 400);
    return tx(async (c) => {
      const p = (await c.query('SELECT p.org_id, p.verified, p.suspended, p.tokens_valid_after, o.suspended AS org_suspended FROM shield_principals p LEFT JOIN shield_orgs o ON o.org_id = p.org_id WHERE p.account_id=$1', [accountId])).rows[0];
      if (p && (!Number.isFinite(iat) || iat * 1000 < new Date(p.tokens_valid_after).getTime())) { await audit(c, accountId, action, 'DENY', 'TOKEN_REVOKED'); return { allow: false, reason: 'TOKEN_REVOKED' }; }
      const d = evaluate({ action, known: !!p, suspended: !!p?.suspended, orgSuspended: !!p?.org_suspended, verified: !!p?.verified, risk: 0, orgId: p?.org_id ?? null, resourceOrgId, scopes });
      await audit(c, accountId, action, d.allow ? 'ALLOW' : 'DENY', d.reason); return { allow: d.allow, reason: d.reason };
    });
  }

  // ---- PSTN gateway authorization (this never dials; the gateway must call authorize, then consume, then settle)
  async function pstnAuthorize({ requestId, accountId, destination, callerId }) {
    if (!uuid(requestId) || !validAccountId(accountId) || typeof destination !== 'string' || typeof callerId !== 'string') throw new ShieldError('invalid_input', 400);
    const hash = sha([accountId, destination, callerId].join('|'));
    return tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['pstn:' + accountId]);
      const prior = (await c.query('SELECT request_hash FROM shield_authorizations WHERE request_id=$1', [requestId])).rows[0];
      if (prior) { await audit(c, accountId, 'voice.pstn.outbound', 'DENY', prior.request_hash === hash ? 'REPLAYED_REQUEST' : 'REQUEST_ID_REUSED', requestId); return { allow: false, reason: prior.request_hash === hash ? 'REPLAYED_REQUEST' : 'REQUEST_ID_REUSED' }; }
      const deny = async (reason) => { await audit(c, accountId, 'voice.pstn.outbound', 'DENY', reason, requestId); return { allow: false, reason }; };
      const p = (await c.query('SELECT org_id, verified, suspended, billing_hold FROM shield_principals WHERE account_id=$1', [accountId])).rows[0];
      if (!p) return deny('UNKNOWN_PRINCIPAL'); if (p.suspended) return deny('SUSPENDED'); if (!p.verified) return deny('IDENTITY_UNVERIFIED'); if (p.billing_hold) return deny('BILLING_HOLD');
      const org = p.org_id ? (await c.query('SELECT * FROM shield_orgs WHERE org_id=$1', [p.org_id])).rows[0] : null;
      if (!org) return deny('NO_ORGANIZATION'); if (org.suspended) return deny('SUSPENDED'); if (!org.pstn_enabled) return deny('PSTN_DISABLED');
      const dest = classifyDestination(destination); if (!dest.ok) return deny(dest.reason);
      if (!org.allowed_countries.includes(dest.country)) return deny('DESTINATION_COUNTRY_NOT_ALLOWED');
      // the caller ID must be a number the carrier-backed authority says exists, is active, is a PERSONAL number (never a shared dial-in), is held by this account, has been verified for it, and is not in an uncertain or conflicting state
      const cid = (await c.query('SELECT account_id, kind, state, caller_id_verified, hold, conflict, stale FROM voice_number_projection WHERE e164=$1 AND state <> \'released\'', [callerId])).rows[0];
      if (!cid || cid.kind !== 'personal' || cid.state !== 'active' || cid.account_id !== accountId || !cid.caller_id_verified || cid.hold || cid.conflict || cid.stale) return deny('CALLER_ID_NOT_OWNED');
      const live = (await c.query("SELECT count(*)::int AS n FROM shield_authorizations WHERE account_id=$1 AND action='voice.pstn.outbound' AND (state='active' OR (state='authorized' AND expires_at>now()))", [accountId])).rows[0].n;
      if (live >= org.max_active_calls) return deny('CONCURRENCY_LIMIT');
      const hour = (await c.query("SELECT count(*)::int AS n FROM shield_authorizations WHERE account_id=$1 AND action='voice.pstn.outbound' AND created_at > now() - interval '1 hour'", [accountId])).rows[0].n;
      if (hour >= org.max_calls_hour) return deny('VELOCITY_LIMIT');
      const spend = await c.query('UPDATE shield_orgs SET spent_cents = spent_cents + $2 WHERE org_id=$1 AND spent_cents + $2 <= spend_limit_cents RETURNING org_id', [org.org_id, cfg.reserveCents]);
      if (!spend.rowCount) return deny('SPEND_LIMIT');
      const id = randomUUID();
      await c.query("INSERT INTO shield_authorizations(id, request_id, request_hash, account_id, org_id, action, resource, reserved_cents, expires_at) VALUES($1,$2,$3,$4,$5,'voice.pstn.outbound',$6,$7, now() + ($8 || ' seconds')::interval)", [id, requestId, hash, accountId, org.org_id, dest.e164 + '|' + callerId, cfg.reserveCents, String(cfg.authTtl)]);
      await audit(c, accountId, 'voice.pstn.outbound', 'ALLOW', 'ALLOW', requestId);
      return { allow: true, reason: 'ALLOW', authorizationId: id, expiresInSeconds: cfg.authTtl, destination: dest.e164, country: dest.country };
    });
  }
  /** Called by the gateway immediately before dialing. Single use; re-checks that the account and organization are still in good standing. */
  async function pstnConsume({ authorizationId, accountId, destination, callerId }) {
    if (!uuid(authorizationId) || !validAccountId(accountId) || typeof destination !== 'string' || typeof callerId !== 'string') throw new ShieldError('invalid_input', 400);
    return tx(async (c) => {
      const st = (await c.query('SELECT p.suspended, o.suspended AS org_suspended FROM shield_principals p LEFT JOIN shield_orgs o ON o.org_id=p.org_id WHERE p.account_id=$1', [accountId])).rows[0];
      if (!st || st.suspended || st.org_suspended) { await audit(c, accountId, 'voice.pstn.consume', 'DENY', 'SUSPENDED'); return { valid: false }; }
      const r = await c.query("UPDATE shield_authorizations SET state='active', consumed_at=now() WHERE id=$1 AND account_id=$2 AND resource=$3 AND state='authorized' AND consumed_at IS NULL AND expires_at>now() RETURNING id", [authorizationId, accountId, destination + '|' + callerId]);
      await audit(c, accountId, 'voice.pstn.consume', r.rowCount ? 'ALLOW' : 'DENY', r.rowCount ? 'ALLOW' : 'INVALID_OR_REUSED'); return { valid: r.rowCount === 1 };
    });
  }
  /** Post-call settlement: releases the unused part of the reservation. Idempotent: a second settle changes nothing. */
  async function pstnSettle({ authorizationId, actualCents }) {
    if (!uuid(authorizationId) || !Number.isInteger(actualCents) || actualCents < 0) throw new ShieldError('invalid_input', 400);
    return tx(async (c) => {
      const a = (await c.query("UPDATE shield_authorizations SET state='ended', ended_at=now(), actual_cents=$2 WHERE id=$1 AND state IN ('active','authorized','revoked') AND ended_at IS NULL RETURNING org_id, reserved_cents", [authorizationId, actualCents])).rows[0];
      if (!a) return { settled: false };
      await c.query('UPDATE shield_orgs SET spent_cents = GREATEST(0, spent_cents - $2 + $3) WHERE org_id=$1', [a.org_id, a.reserved_cents, actualCents]); return { settled: true };
    });
  }
  /** Calls the gateway must hang up right now (suspended account or organization). */
  async function pstnTerminations() {
    return (await store.tx((c) => c.query("SELECT a.id FROM shield_authorizations a JOIN shield_principals p ON p.account_id=a.account_id LEFT JOIN shield_orgs o ON o.org_id=a.org_id WHERE a.state='active' AND (p.suspended OR coalesce(o.suspended,false))"))).rows.map((r) => r.id);
  }

  // ---- guest video admission: ID + passcode only, host approval, meeting-scoped one-time media credential
  const dummySalt = randomBytes(16);
  async function guestRequest({ meetingId, passcode, displayName, clientKey }) {
    if (!idText(meetingId) || typeof passcode !== 'string' || passcode.length > 64 || typeof clientKey !== 'string' || clientKey.length < 8 || clientKey.length > 128) throw new ShieldError('invalid_input', 400);
    const name = String(displayName ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) throw new ShieldError('invalid_input', 400);
    return tx(async (c) => {
      const limited = async (reason) => { await audit(c, 'guest', 'guest.request', 'DENY', reason); return { status: 'DENIED', reason }; };
      if (!(await bump(c, 'gc:' + clientKey, 60, cfg.clientPerMin))) return limited('RATE_LIMIT');
      if (!(await bump(c, 'gm:' + meetingId, 60, cfg.meetingPerMin))) return limited('RATE_LIMIT');
      const locked = (await c.query("SELECT n FROM shield_counters WHERE bucket=$1 AND window_start = to_timestamp(floor(extract(epoch from now())/600)*600)", ['gf:' + meetingId])).rows[0]?.n >= cfg.meetingFailLock;
      const m = (await c.query('SELECT * FROM shield_meetings WHERE meeting_id=$1 FOR SHARE', [meetingId])).rows[0];
      const actual = await passHash(passcode, m && m.passcode_salt ? m.passcode_salt : dummySalt);
      const same = m && m.authority === 'shield' && m.passcode_hash && actual.length === m.passcode_hash.length && timingSafeEqual(actual, m.passcode_hash);
      if (locked) return limited('MEETING_LOCKED');
      if (!same || !m.guest_enabled || new Date(m.ends_at) <= new Date()) {
        await c.query("INSERT INTO shield_counters(bucket, window_start, n) VALUES($1, to_timestamp(floor(extract(epoch from now())/600)*600), 1) ON CONFLICT (bucket, window_start) DO UPDATE SET n = shield_counters.n + 1", ['gf:' + meetingId]);
        return limited('INVALID_MEETING_OR_PASSCODE');
      }
      const occupied = (await c.query("SELECT count(*)::int AS n FROM shield_guest_admissions WHERE meeting_id=$1 AND state IN ('WAITING','ADMITTED') AND expires_at>now()", [meetingId])).rows[0].n;
      if (occupied >= m.max_guests) return limited('MEETING_FULL');
      const id = randomUUID(), claim = rand(), state = m.requires_approval ? 'WAITING' : 'ADMITTED';
      await c.query("INSERT INTO shield_guest_admissions(id, meeting_id, display_name, state, claim_hash, expires_at) VALUES($1,$2,$3,$4,$5, least($6::timestamptz, now() + ($7 || ' seconds')::interval))", [id, meetingId, name, state, sha(claim), m.ends_at, String(Math.max(cfg.guestTtl, 1))]);
      await audit(c, 'guest:' + id, 'guest.request', 'ALLOW', state); return { status: state, admissionId: id, claimSecret: claim };
    });
  }
  /** The meeting's host (a signed-in account of the same organization) decides. A guest, another organization's member or anyone else gets 403. */
  async function guestDecide({ hostAccountId, admissionId, decision }) {
    if (!uuid(admissionId) || !['approve', 'deny', 'revoke'].includes(decision)) throw new ShieldError('invalid_input', 400);
    const out = await tx(async (c) => {
      const a = (await c.query('SELECT g.id, g.state, g.meeting_id, m.host_account_id, m.org_id FROM shield_guest_admissions g JOIN shield_meetings m ON m.meeting_id=g.meeting_id WHERE g.id=$1 FOR UPDATE OF g', [admissionId])).rows[0];
      const host = (await c.query('SELECT org_id, verified, suspended FROM shield_principals WHERE account_id=$1', [hostAccountId])).rows[0];
      if (!a || !host || host.suspended || !host.verified || a.host_account_id !== hostAccountId || host.org_id !== a.org_id) { await audit(c, hostAccountId, 'guest.decide', 'DENY', 'NOT_MEETING_HOST'); return { forbidden: true }; }
      const to = decision === 'approve' ? 'ADMITTED' : decision === 'deny' ? 'DENIED' : 'REVOKED';
      const ok = decision === 'approve' ? a.state === 'WAITING' : decision === 'deny' ? a.state === 'WAITING' : ['WAITING', 'ADMITTED'].includes(a.state);
      if (!ok) return { conflict: true };
      await c.query('UPDATE shield_guest_admissions SET state=$2, decided_by=$3, decided_at=now() WHERE id=$1', [admissionId, to, hostAccountId]);
      if (to !== 'ADMITTED') await c.query('UPDATE shield_media_tokens SET revoked_at=now() WHERE admission_id=$1 AND revoked_at IS NULL', [admissionId]);
      await audit(c, hostAccountId, 'guest.decide', 'ALLOW', to); return { admissionId, state: to };
    });
    if (out.forbidden) throw new ShieldError('forbidden', 403); if (out.conflict) throw new ShieldError('invalid_transition', 409); return out;
  }
  /** The guest's browser (through the edge) trades its claim secret for ONE media credential once the host approved. */
  async function guestClaim({ admissionId, claimSecret }) {
    if (!uuid(admissionId) || typeof claimSecret !== 'string' || claimSecret.length < 16 || claimSecret.length > 128) throw new ShieldError('invalid_input', 400);
    return tx(async (c) => {
      const a = (await c.query('SELECT g.*, m.ends_at FROM shield_guest_admissions g JOIN shield_meetings m ON m.meeting_id=g.meeting_id WHERE g.id=$1 FOR UPDATE OF g', [admissionId])).rows[0];
      const good = a && (() => { const x = Buffer.from(sha(claimSecret)), y = Buffer.from(a.claim_hash); return x.length === y.length && timingSafeEqual(x, y); })();
      if (!good) return { status: 'DENIED' };
      if (new Date(a.expires_at) <= new Date() || new Date(a.ends_at) <= new Date()) return { status: 'DENIED' };
      if (a.state === 'WAITING') return { status: 'WAITING' };
      if (a.state !== 'ADMITTED') return { status: 'DENIED' };
      if (a.claimed_at) { await audit(c, 'guest:' + a.id, 'guest.claim', 'DENY', 'ALREADY_CLAIMED'); return { status: 'DENIED' }; }
      const token = rand();
      await c.query('UPDATE shield_guest_admissions SET claimed_at=now() WHERE id=$1', [a.id]);
      await c.query("INSERT INTO shield_media_tokens(token_hash, admission_id, meeting_id, expires_at) VALUES($1,$2,$3, now() + ($4 || ' seconds')::interval)", [sha(token), a.id, a.meeting_id, String(cfg.mediaTtl)]);
      await audit(c, 'guest:' + a.id, 'guest.claim', 'ALLOW', 'MEDIA_CREDENTIAL_ISSUED');
      return { status: 'ADMITTED', mediaToken: token, expiresInSeconds: cfg.mediaTtl, meetingId: a.meeting_id, capabilities: ['meeting.media.join'] };
    });
  }
  /** The media gateway presents the credential exactly once, for exactly its meeting. Revocation (kick, ban, meeting end) is re-checked here. */
  async function mediaConsume({ token, meetingId }) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 128 || !idText(meetingId)) throw new ShieldError('invalid_input', 400);
    return tx(async (c) => {
      const r = await c.query("UPDATE shield_media_tokens t SET consumed_at=now() FROM shield_guest_admissions g, shield_meetings m WHERE t.token_hash=$1 AND t.meeting_id=$2 AND g.id=t.admission_id AND g.state='ADMITTED' AND m.meeting_id=t.meeting_id AND m.ends_at>now() AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>now() RETURNING t.admission_id, g.display_name", [sha(token), meetingId]);
      await audit(c, r.rowCount ? 'guest:' + r.rows[0].admission_id : 'guest', 'media.consume', r.rowCount ? 'ALLOW' : 'DENY', r.rowCount ? 'ALLOW' : 'INVALID_OR_REUSED');
      return r.rowCount ? { valid: true, subject: 'guest:' + r.rows[0].admission_id, displayName: r.rows[0].display_name, capabilities: ['meeting.media.join'] } : { valid: false };
    });
  }
  // ---- Qorlla Meet signaling: Meet owns meetings, passcodes, the waiting room and host approval; the shield decides whether an admitted participant may OPEN a signaling session, and keeps deciding.
  const GUEST_CAPS = ['meeting.join', 'meeting.media', 'meeting.chat'], MEMBER_CAPS = ['meeting.join', 'meeting.media', 'meeting.chat', 'meeting.share'], HOST_CAPS = [...MEMBER_CAPS, 'meeting.host'];
  async function registerMeeting({ meetingId, orgId = null, hostAccountId = null, guestEnabled = true, endsAt }) {
    if (!idText(meetingId) || (orgId != null && !idText(orgId)) || (hostAccountId != null && !validAccountId(hostAccountId)) || typeof guestEnabled !== 'boolean' || Number.isNaN(Date.parse(endsAt))) throw new ShieldError('invalid_input', 400);
    return tx(async (c) => {
      const cur = (await c.query('SELECT authority, ends_at FROM shield_meetings WHERE meeting_id=$1 FOR UPDATE', [meetingId])).rows[0];
      if (cur && cur.authority !== 'meet') throw new ShieldError('meeting_owned_by_shield', 409);
      if (cur && new Date(cur.ends_at) <= new Date() && new Date(endsAt) > new Date()) throw new ShieldError('meeting_ended', 409);       // an ended meeting stays ended
      await c.query("INSERT INTO shield_meetings(meeting_id, org_id, host_account_id, guest_enabled, requires_approval, ends_at, authority) VALUES($1,$2,$3,$4,true,$5,'meet') ON CONFLICT (meeting_id) DO UPDATE SET org_id=$2, host_account_id=$3, guest_enabled=$4, ends_at=$5", [meetingId, orgId, hostAccountId, guestEnabled, endsAt]);
      await audit(c, hostAccountId, 'meet.register', 'ALLOW', 'META'); return { meetingId };
    });
  }
  /** -> { allow, reason, kind: 'host'|'member'|'guest', capabilities }. kind/capabilities come from the shield's own records, never from the request. */
  async function meetAuthorize({ meetingId, participantId, accountId = null, role, admission }) {
    if (!idText(meetingId) || !uuid(participantId) || (accountId != null && !validAccountId(accountId)) || !['host', 'guest'].includes(role) || typeof admission !== 'string') throw new ShieldError('invalid_input', 400);
    return tx(async (c) => {
      const who = accountId || 'guest:' + participantId, no = async (reason) => { await audit(c, who, 'meet.signal', 'DENY', reason, null); return { allow: false, reason }; };
      const m = (await c.query('SELECT * FROM shield_meetings WHERE meeting_id=$1', [meetingId])).rows[0];
      if (!m || m.authority !== 'meet' || new Date(m.ends_at) <= new Date()) return no('MEETING_UNKNOWN_OR_ENDED');
      if (admission !== 'admitted') return no('NOT_ADMITTED');
      let kind = 'guest';
      if (accountId) {
        const p = (await c.query('SELECT p.verified, p.suspended, p.org_id, o.suspended AS org_suspended FROM shield_principals p LEFT JOIN shield_orgs o ON o.org_id=p.org_id WHERE p.account_id=$1', [accountId])).rows[0];
        if (!p) return no('UNKNOWN_PRINCIPAL'); if (p.suspended || p.org_suspended) return no('SUSPENDED');
        const orgOk = !m.org_id || p.org_id === m.org_id;
        if (p.verified && orgOk) kind = role === 'host' ? 'host' : 'member';
        else if (!m.guest_enabled) return no(!p.verified ? 'IDENTITY_UNVERIFIED' : 'CROSS_TENANT');
        // an unverified account, or one from another organization, joins with GUEST rights only (and only where the meeting allows guests)
        if (role === 'host' && (kind !== 'host' || m.host_account_id !== accountId)) return no('NOT_THE_HOST');
      } else {
        if (role === 'host') return no('NOT_THE_HOST'); if (!m.guest_enabled) return no('GUEST_NOT_ALLOWED');
      }
      await audit(c, who, 'meet.signal', 'ALLOW', kind, null);
      return { allow: true, reason: 'ALLOW', kind, capabilities: kind === 'host' ? HOST_CAPS : kind === 'member' ? MEMBER_CAPS : GUEST_CAPS };
    });
  }
  /** Called INSIDE the call-creation transaction, after both accounts are locked: both parties must be known, verified and not suspended, and in the SAME tenant. Anything else is refused;
   *  the callee's side is always reported as "no such recipient" so a caller learns nothing about accounts in other tenants. Absent organization = the default namespace (all such accounts share it). */
  async function callGuard(c, callerId, calleeId) {
    const coded = (code) => Object.assign(new Error(code), { code });
    const rows = (await c.query('SELECT p.account_id, p.org_id, p.verified, p.suspended, o.suspended AS org_suspended FROM shield_principals p LEFT JOIN shield_orgs o ON o.org_id=p.org_id WHERE p.account_id = ANY($1::text[])', [[callerId, calleeId]])).rows;
    const a = rows.find((r) => r.account_id === callerId), b = rows.find((r) => r.account_id === calleeId);
    if (!a) throw coded('unknown_principal'); if (a.suspended || a.org_suspended) throw coded('suspended'); if (!a.verified) throw coded('identity_unverified');
    if (!b || b.suspended || b.org_suspended || !b.verified || (b.org_id ?? null) !== (a.org_id ?? null)) throw coded('invalid_recipient');
  }
  /** Meet sends the sessions it is holding open; the shield names the ones that must be closed NOW (suspension, ended meeting, a principal that vanished). */
  async function meetRecheck({ participants }) {
    if (!Array.isArray(participants) || participants.length > 500) throw new ShieldError('invalid_input', 400);
    const revoke = [];
    await tx(async (c) => {
      for (const s of participants) {
        if (!s || !idText(s.meetingId) || !uuid(s.participantId) || (s.accountId != null && !validAccountId(s.accountId))) throw new ShieldError('invalid_input', 400);
        const m = (await c.query('SELECT ends_at FROM shield_meetings WHERE meeting_id=$1', [s.meetingId])).rows[0];
        if (!m || new Date(m.ends_at) <= new Date()) { revoke.push({ meetingId: s.meetingId, participantId: s.participantId, reason: 'MEETING_ENDED' }); continue; }
        if (s.accountId) {
          const p = (await c.query('SELECT p.suspended, o.suspended AS org_suspended FROM shield_principals p LEFT JOIN shield_orgs o ON o.org_id=p.org_id WHERE p.account_id=$1', [s.accountId])).rows[0];
          if (!p || p.suspended || p.org_suspended) revoke.push({ meetingId: s.meetingId, participantId: s.participantId, reason: !p ? 'UNKNOWN_PRINCIPAL' : 'SUSPENDED' });
        }
      }
      if (revoke.length) await audit(c, null, 'meet.recheck', 'DENY', 'REVOKED:' + revoke.length, null);
    });
    return { revoke };
  }
  async function endMeeting(meetingId) {
    return tx(async (c) => {
      await c.query("UPDATE shield_meetings SET ends_at=now() WHERE meeting_id=$1", [meetingId]);
      await c.query("UPDATE shield_guest_admissions SET state='REVOKED' WHERE meeting_id=$1 AND state IN ('WAITING','ADMITTED')", [meetingId]);
      await c.query('UPDATE shield_media_tokens SET revoked_at=now() WHERE meeting_id=$1 AND revoked_at IS NULL', [meetingId]); await audit(c, null, 'meeting.end', 'ALLOW', 'ADMIN'); return { meetingId };
    });
  }
  /** Best-effort audit of a refused write: the caller is authenticated but is not the party allowed to do it. */
  function auditProvenance(actor, reason) { db.query('INSERT INTO shield_events(actor, action, decision, reason) VALUES($1,$2,$3,$4)', [String(actor || '').slice(0, 128), 'numbers.sync', 'DENY', reason]).catch(() => {}); }
  async function purgeExpired() { await store.tx(async (c) => { await c.query('DELETE FROM shield_workload_jti WHERE expires_at < now()'); await c.query("DELETE FROM shield_counters WHERE window_start < now() - interval '1 day'"); }); }

  return { enabled, requireWorkload, workloadOkForAdmin, upsertPrincipal, upsertOrg, upsertMeeting, setSuspended, setOrgSuspended, assertPrincipalActive, authorizeUser, pstnAuthorize, pstnConsume, pstnSettle, pstnTerminations, callGuard, auditProvenance, registerMeeting, meetAuthorize, meetRecheck, guestRequest, guestDecide, guestClaim, mediaConsume, endMeeting, purgeExpired };
}
