/**
 * Step-up authentication for privileged actions (runs in the INTERNAL administration service, role qorlla_sub_admin).
 *
 *  - Passkeys / WebAuthn through @simplewebauthn/server (user verification REQUIRED), TOTP as the alternative or recovery factor.
 *  - A successful proof creates a GRANT bound to (session, user, action) that expires (default 5 minutes) and is SINGLE USE.
 *    Nothing a client sends is accepted as proof; only a verified assertion or code creates a grant.
 *  - The first factor of a user cannot be enrolled from a session alone: it needs a one-time token issued out of band, otherwise a
 *    stolen session could enroll its own passkey and defeat the whole mechanism. Further factors need a fresh step-up.
 *  - Challenges are bound to one session + user + action, single use, short-lived. Sign counters are checked (cloned authenticators).
 *  - TOTP secrets are encrypted at rest (AES-256-GCM, bound to the user), codes are rate limited and each time step works once.
 *  - Every attempt, success or failure, is written to an append-only audit table.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { withTx } from './db.js';
import { createPool, ensureSearchPath } from './schema.js';
import { SubscriptionError, NotAuthorizedError } from './errors.js';
import { newSecret, base32Encode, matchTotp, otpauthUri, seal, open } from './totp.js';

/** Actions that require a fresh step-up. Anything else is not a valid step-up target. */
export const STEPUP_ACTIONS = Object.freeze(['override.set', 'override.remove', 'billing.link', 'customer.status', 'member.set_role', 'factor.enroll', 'factor.revoke']);

const USER_RE = /^[A-Za-z0-9_.:@-]{1,100}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{16,200}$/;
const sha = (v) => createHash('sha256').update(v).digest('hex');
const b64 = (u8) => Buffer.from(u8).toString('base64url');

const bad = (message, code, status = 400) => new SubscriptionError(message, code, {}, status);
const denied = () => new NotAuthorizedError('Step-up verification failed');
/** Returned from inside a transaction so that the failure is COMMITTED (audit row, spent challenge); the caller throws it afterwards. */
const DENIED = Symbol('denied');

export class StepUpService {
  constructor(opts = {}) {
    if (!opts.rpID || !opts.origins?.length) throw new Error('StepUpService requires rpID and origins (the exact origins your pages are served from)');
    this.ownsPool = !opts.pool;
    this.pool = opts.pool || createPool(opts.connectionString || process.env.DATABASE_URL, { max: opts.poolMax || 4 });
    this.rpID = opts.rpID; this.rpName = opts.rpName || 'Qorlla'; this.origins = opts.origins; this.issuer = opts.issuer || 'Qorlla';
    this.totpKey = opts.totpKey || null;                                       // 32 bytes; TOTP is unavailable without it
    this.windowMs = opts.windowMs ?? 5 * 60_000;
    this.challengeTtlMs = opts.challengeTtlMs ?? 2 * 60_000;
    this.maxFailures = opts.maxFailures ?? 5;
    this.lockMs = opts.lockMs ?? 15 * 60_000;
  }

  // ---- helpers ---------------------------------------------------------------------------------------------------------------
  _ids(userId, sessionHash) {
    if (typeof userId !== 'string' || !USER_RE.test(userId)) throw bad('Invalid user', 'invalid_user');
    if (typeof sessionHash !== 'string' || !SESSION_RE.test(sessionHash)) throw bad('Invalid session', 'invalid_session', 401);
  }

  _action(action) {
    if (!STEPUP_ACTIONS.includes(action)) throw bad('Unknown privileged action', 'invalid_action');
  }

  async _audit(q, event, { userId = null, sessionHash = null, action = null, method = null, ok, detail = {} }) {
    await q.query(`INSERT INTO stepup_audit (user_id, session_hash, action, event, method, ok, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [userId, sessionHash ? sha(sessionHash) : null, action, event, method, ok, JSON.stringify(detail)]);   // the session is stored hashed again
  }

  async _hasFactor(q, userId) {
    const r = await q.query(`SELECT (EXISTS (SELECT 1 FROM webauthn_credentials WHERE user_id = $1 AND revoked_at IS NULL)
                              OR EXISTS (SELECT 1 FROM totp_factors WHERE user_id = $1 AND confirmed)) AS has`, [userId]);
    return r.rows[0].has;
  }

  async hasFactor(userId) { await ensureSearchPath(this.pool); return this._hasFactor(this.pool, userId); }

  async _grant(q, { sessionHash, userId, action, method }) {
    const r = await q.query(
      `INSERT INTO stepup_grants (session_hash, user_id, action, method, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5::double precision)) RETURNING id, expires_at`,
      [sessionHash, userId, action, method, this.windowMs / 1000]);
    return r.rows[0];
  }

  async _newChallenge(q, kind, { sessionHash, userId, action }, challenge) {
    await q.query(`UPDATE stepup_challenges SET used_at = now() WHERE session_hash=$1 AND user_id=$2 AND action=$3 AND kind=$4 AND used_at IS NULL`, [sessionHash, userId, action, kind]);   // one open challenge at a time
    await q.query(`INSERT INTO stepup_challenges (kind, session_hash, user_id, action, challenge, expires_at) VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs => $6::double precision))`,
      [kind, sessionHash, userId, action, challenge, this.challengeTtlMs / 1000]);
  }

  /** Takes the open challenge for exactly this session+user+action (single use: it is spent whether or not the proof verifies). */
  async _takeChallenge(q, kind, { sessionHash, userId, action }) {
    const r = await q.query(
      `UPDATE stepup_challenges SET used_at = now() WHERE id = (
         SELECT id FROM stepup_challenges WHERE session_hash=$1 AND user_id=$2 AND action=$3 AND kind=$4 AND used_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING challenge`, [sessionHash, userId, action, kind]);
    return r.rows[0]?.challenge || null;
  }

  /** First factor: a one-time out-of-band token. Later factors: a fresh step-up with an existing one (consumed here). */
  async _requireEnrollmentRight(q, { userId, sessionHash, enrollmentToken }, { consumeToken }) {
    if (!(await this._hasFactor(q, userId))) {
      if (typeof enrollmentToken !== 'string' || enrollmentToken.length < 20) throw denied();
      const sql = consumeToken
        ? `UPDATE stepup_enrollment_tokens SET used_at = now() WHERE token_hash=$1 AND user_id=$2 AND used_at IS NULL AND expires_at > now() RETURNING 1`
        : `SELECT 1 FROM stepup_enrollment_tokens WHERE token_hash=$1 AND user_id=$2 AND used_at IS NULL AND expires_at > now()`;
      if (!(await q.query(sql, [sha(enrollmentToken), userId])).rowCount) throw denied();
      return 'token';
    }
    return null;
  }

  /** Runs an operation; if it is refused, records the refusal on a SEPARATE connection (the refused transaction rolled back). */
  async _auditDenial(event, ctx, fn) {
    try { return await fn(); } catch (e) {
      if (e?.code === 'not_authorized') await this._audit(this.pool, event, { ...ctx, ok: false, detail: { why: 'denied' } }).catch(() => {});
      throw e;
    }
  }

  // ---- operations issues the one-time token for a user's first factor ---------------------------------------------------------
  async createEnrollmentToken({ userId, createdBy, ttlMs = 15 * 60_000 }) {
    await ensureSearchPath(this.pool);
    if (typeof userId !== 'string' || !USER_RE.test(userId) || !createdBy) throw bad('Invalid request', 'invalid_request');
    const token = randomBytes(24).toString('base64url');
    await this.pool.query(`INSERT INTO stepup_enrollment_tokens (token_hash, user_id, created_by, expires_at) VALUES ($1,$2,$3, now() + make_interval(secs => $4::double precision))`,
      [sha(token), userId, createdBy, ttlMs / 1000]);
    return token;
  }

  // ---- passkeys: registration -------------------------------------------------------------------------------------------------
  async beginRegistration({ userId, userName, sessionHash, enrollmentToken }) {
    await ensureSearchPath(this.pool); this._ids(userId, sessionHash);
    return this._auditDenial('register_begin', { userId, sessionHash, action: 'factor.enroll', method: 'webauthn' }, () => withTx(this.pool, async (c) => {
      const existing = (await c.query(`SELECT credential_id, transports FROM webauthn_credentials WHERE user_id=$1 AND revoked_at IS NULL`, [userId])).rows;
      const viaToken = await this._requireEnrollmentRight(c, { userId, sessionHash, enrollmentToken }, { consumeToken: false });
      if (!viaToken && !(await this._consume(c, { sessionHash, userId, action: 'factor.enroll' }))) throw denied();
      const options = await generateRegistrationOptions({
        rpName: this.rpName, rpID: this.rpID, userName: String(userName || userId).slice(0, 100), userID: Buffer.from(sha(`uid:${userId}`), 'hex'),
        attestationType: 'none', supportedAlgorithmIDs: [-7, -257],
        excludeCredentials: existing.map((r) => ({ id: r.credential_id, transports: r.transports })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      });
      await this._newChallenge(c, 'webauthn_register', { sessionHash, userId, action: 'factor.enroll' }, options.challenge);
      await this._audit(c, 'register_begin', { userId, sessionHash, action: 'factor.enroll', method: 'webauthn', ok: true, detail: { via: viaToken || 'stepup' } });
      return options;
    }));
  }

  async finishRegistration({ userId, sessionHash, response, label = '', enrollmentToken }) {
    await ensureSearchPath(this.pool); this._ids(userId, sessionHash);
    const out = await withTx(this.pool, async (c) => {
      const challenge = await this._takeChallenge(c, 'webauthn_register', { sessionHash, userId, action: 'factor.enroll' });
      const no = async (why) => { await this._audit(c, 'register_finish', { userId, sessionHash, action: 'factor.enroll', method: 'webauthn', ok: false, detail: { why } }); return DENIED; };
      if (!challenge) return no('no_challenge');
      let v;
      try { v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: this.origins, expectedRPID: this.rpID, requireUserVerification: true }); }
      catch (e) { return no(String(e.message).slice(0, 120)); }
      if (!v.verified || !v.registrationInfo) return no('not_verified');
      await this._requireEnrollmentRight(c, { userId, sessionHash, enrollmentToken }, { consumeToken: true });   // first factor: spend the one-time token now
      const info = v.registrationInfo;
      const cred = info.credential || { id: info.credentialID, publicKey: info.credentialPublicKey, counter: info.counter };
      try {
        await c.query(`INSERT INTO webauthn_credentials (credential_id, user_id, public_key, sign_count, transports, device_type, backed_up, label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [typeof cred.id === 'string' ? cred.id : b64(cred.id), userId, Buffer.from(cred.publicKey), cred.counter ?? 0, response?.response?.transports || cred.transports || [],
            info.credentialDeviceType || null, !!info.credentialBackedUp, String(label).slice(0, 80)]);
      } catch (e) { if (e.code === '23505') throw bad('That authenticator is already registered', 'credential_exists', 409); throw e; }
      await this._audit(c, 'register_finish', { userId, sessionHash, action: 'factor.enroll', method: 'webauthn', ok: true });
      return { ok: true };
    });
    if (out === DENIED) throw denied();
    return out;
  }

  // ---- passkeys: step-up assertion --------------------------------------------------------------------------------------------
  async beginAssertion({ userId, sessionHash, action }) {
    await ensureSearchPath(this.pool); this._ids(userId, sessionHash); this._action(action);
    return withTx(this.pool, async (c) => {
      const creds = (await c.query(`SELECT credential_id, transports FROM webauthn_credentials WHERE user_id=$1 AND revoked_at IS NULL`, [userId])).rows;
      if (!creds.length) throw bad('No passkey is registered', 'no_passkey', 409);
      const options = await generateAuthenticationOptions({ rpID: this.rpID, userVerification: 'required', allowCredentials: creds.map((r) => ({ id: r.credential_id, transports: r.transports })) });
      await this._newChallenge(c, 'webauthn_assert', { sessionHash, userId, action }, options.challenge);
      await this._audit(c, 'assert_begin', { userId, sessionHash, action, method: 'webauthn', ok: true });
      return options;
    });
  }

  async finishAssertion({ userId, sessionHash, action, response }) {
    await ensureSearchPath(this.pool); this._ids(userId, sessionHash); this._action(action);
    const out = await withTx(this.pool, async (c) => {
      const fail = async (why) => { await this._audit(c, 'assert_finish', { userId, sessionHash, action, method: 'webauthn', ok: false, detail: { why } }); return DENIED; };
      const challenge = await this._takeChallenge(c, 'webauthn_assert', { sessionHash, userId, action });
      if (!challenge) return fail('no_challenge');
      const row = (await c.query(`SELECT credential_id, public_key, sign_count, transports FROM webauthn_credentials WHERE credential_id=$1 AND user_id=$2 AND revoked_at IS NULL FOR UPDATE`,
        [String(response?.id || ''), userId])).rows[0];
      if (!row) return fail('unknown_credential');
      let v;
      try {
        v = await verifyAuthenticationResponse({ response, expectedChallenge: challenge, expectedOrigin: this.origins, expectedRPID: this.rpID, requireUserVerification: true,
          credential: { id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: Number(row.sign_count), transports: row.transports } });
      } catch (e) { return fail(String(e.message).slice(0, 120)); }
      if (!v.verified) return fail('not_verified');
      await c.query(`UPDATE webauthn_credentials SET sign_count = $2, last_used_at = now() WHERE credential_id = $1`, [row.credential_id, v.authenticationInfo.newCounter]);
      const g = await this._grant(c, { sessionHash, userId, action, method: 'webauthn' });
      await this._audit(c, 'assert_finish', { userId, sessionHash, action, method: 'webauthn', ok: true });
      return { ok: true, expiresAt: g.expires_at };
    });
    if (out === DENIED) throw denied();
    return out;
  }

  // ---- TOTP -------------------------------------------------------------------------------------------------------------------
  _needTotp() { if (!this.totpKey) throw bad('TOTP is not enabled on this server', 'totp_disabled', 501); }

  async beginTotp({ userId, sessionHash, enrollmentToken }) {
    await ensureSearchPath(this.pool); this._needTotp(); this._ids(userId, sessionHash);
    return this._auditDenial('totp_begin', { userId, sessionHash, action: 'factor.enroll', method: 'totp' }, () => withTx(this.pool, async (c) => {
      const viaToken = await this._requireEnrollmentRight(c, { userId, sessionHash, enrollmentToken }, { consumeToken: false });
      if (!viaToken && !(await this._consume(c, { sessionHash, userId, action: 'factor.enroll' }))) throw denied();
      const existing = (await c.query(`SELECT confirmed FROM totp_factors WHERE user_id=$1 FOR UPDATE`, [userId])).rows[0];
      if (existing?.confirmed) throw bad('A TOTP factor already exists; revoke it first', 'totp_exists', 409);
      const secret = newSecret();
      const enc = seal(this.totpKey, secret, `totp:${userId}`);
      await c.query(`INSERT INTO totp_factors (user_id, secret_enc) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, confirmed = false, last_step = 0, failures = 0, locked_until = NULL`, [userId, enc]);
      await this._audit(c, 'totp_begin', { userId, sessionHash, action: 'factor.enroll', method: 'totp', ok: true, detail: { via: viaToken || 'stepup' } });
      return { secret: base32Encode(secret), uri: otpauthUri({ secret, account: userId, issuer: this.issuer }) };    // shown ONCE
    }));
  }

  /** Verifies a code against the stored secret with lockout and replay protection. Returns the accepted step. */
  async _checkTotp(c, userId, code, now = Date.now()) {
    const f = (await c.query(`SELECT secret_enc, confirmed, last_step, failures, (locked_until IS NOT NULL AND locked_until > now()) AS locked FROM totp_factors WHERE user_id=$1 FOR UPDATE`, [userId])).rows[0];
    if (!f) return { ok: false, why: 'no_factor' };
    if (f.locked) return { ok: false, why: 'locked' };
    const step = matchTotp(open(this.totpKey, f.secret_enc, `totp:${userId}`), code, now);
    if (step === null || step <= Number(f.last_step)) {                                  // wrong code, or a time step that was already used
      const failures = f.failures + 1;
      await c.query(`UPDATE totp_factors SET failures=$2::int, locked_until = CASE WHEN $2::int >= $3::int THEN now() + make_interval(secs => $4::double precision) ELSE locked_until END WHERE user_id=$1`,
        [userId, failures, this.maxFailures, this.lockMs / 1000]);
      return { ok: false, why: step === null ? 'bad_code' : 'replayed', confirmed: f.confirmed };
    }
    await c.query(`UPDATE totp_factors SET last_step=$2, failures=0, locked_until=NULL WHERE user_id=$1`, [userId, step]);
    return { ok: true, step, confirmed: f.confirmed };
  }

  async confirmTotp({ userId, sessionHash, code, now }) {
    await ensureSearchPath(this.pool); this._needTotp(); this._ids(userId, sessionHash);
    return withTx(this.pool, async (c) => {
      const r = await this._checkTotp(c, userId, code, now);
      // a failed attempt must persist its failure count, so do not throw before committing: report through the return value
      if (!r.ok || r.confirmed) { await this._audit(c, 'totp_confirm', { userId, sessionHash, method: 'totp', ok: false, detail: { why: r.why || 'already_confirmed' } }); return { ok: false }; }
      await c.query(`UPDATE totp_factors SET confirmed = true, confirmed_at = now() WHERE user_id=$1`, [userId]);
      await this._audit(c, 'totp_confirm', { userId, sessionHash, method: 'totp', ok: true });
      return { ok: true };
    });
  }

  async verifyTotp({ userId, sessionHash, action, code, now }) {
    await ensureSearchPath(this.pool); this._needTotp(); this._ids(userId, sessionHash); this._action(action);
    return withTx(this.pool, async (c) => {
      const r = await this._checkTotp(c, userId, code, now);
      if (!r.ok || !r.confirmed) {
        await this._audit(c, 'totp_verify', { userId, sessionHash, action, method: 'totp', ok: false, detail: { why: r.why || 'unconfirmed' } });
        return { ok: false, locked: r.why === 'locked' };                                  // commit the failure counter; the caller turns this into a denial
      }
      const g = await this._grant(c, { sessionHash, userId, action, method: 'totp' });
      await this._audit(c, 'totp_verify', { userId, sessionHash, action, method: 'totp', ok: true });
      return { ok: true, expiresAt: g.expires_at };
    });
  }

  // ---- grants -----------------------------------------------------------------------------------------------------------------
  async _consume(q, { sessionHash, userId, action }) {
    const r = await q.query(
      `UPDATE stepup_grants SET consumed_at = now() WHERE id = (
         SELECT id FROM stepup_grants WHERE session_hash=$1 AND user_id=$2 AND action=$3 AND consumed_at IS NULL AND expires_at > now()
          ORDER BY verified_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING verified_at, method`, [sessionHash, userId, action]);
    return r.rows[0] ? { verifiedAt: r.rows[0].verified_at, method: r.rows[0].method } : null;
  }

  /** Spends a fresh grant for exactly this session, user and action. Null when there is none (never throws for "no proof"). */
  async consume({ sessionHash, userId, action }) {
    await ensureSearchPath(this.pool); this._ids(userId, sessionHash); this._action(action);
    const g = await this._consume(this.pool, { sessionHash, userId, action });
    await this._audit(this.pool, 'grant_consume', { userId, sessionHash, action, method: g?.method ?? null, ok: !!g });
    return g;
  }

  /** Logout / session revocation: every open grant and challenge of that session dies immediately. */
  async revokeSession(sessionHash) {
    await ensureSearchPath(this.pool);
    if (typeof sessionHash !== 'string' || !SESSION_RE.test(sessionHash)) throw bad('Invalid session', 'invalid_session', 401);
    await this.pool.query(`UPDATE stepup_grants SET consumed_at = now() WHERE session_hash=$1 AND consumed_at IS NULL`, [sessionHash]);
    await this.pool.query(`UPDATE stepup_challenges SET used_at = now() WHERE session_hash=$1 AND used_at IS NULL`, [sessionHash]);
  }

  async revokeCredential({ userId, sessionHash, credentialId }) {
    await ensureSearchPath(this.pool); this._ids(userId, sessionHash);
    return withTx(this.pool, async (c) => {
      if (!(await this._consume(c, { sessionHash, userId, action: 'factor.revoke' }))) throw denied();
      const r = await c.query(`UPDATE webauthn_credentials SET revoked_at = now() WHERE credential_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [String(credentialId), userId]);
      await this._audit(c, 'credential_revoke', { userId, sessionHash, action: 'factor.revoke', method: 'webauthn', ok: r.rowCount > 0 });
      return { ok: r.rowCount > 0 };
    });
  }

  async close() { if (this.ownsPool) await this.pool.end(); }
}
