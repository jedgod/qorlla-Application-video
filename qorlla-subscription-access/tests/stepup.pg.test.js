// Step-up authentication against a real PostgreSQL with a software passkey: enrolment gate, assertion, grants, replay, TOTP, audit.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createTestDb, sleep, skip } from './helpers/db.js';
import { SoftAuthenticator, otherKey } from './helpers/softauth.js';
import { StepUpService, STEPUP_ACTIONS } from '../src/stepup.js';
import { totp, base32Decode } from '../src/totp.js';

const RP = 'localhost', ORIGIN = 'https://localhost:3443';
const sid = () => randomBytes(32).toString('hex');
let n = 0;
const uid = () => `u_${++n}_${randomBytes(3).toString('hex')}`;

describe('step-up authentication (PostgreSQL)', { skip }, () => {
  let db, svc, key;
  before(async () => {
    db = await createTestDb(); key = randomBytes(32);
    svc = new StepUpService({ pool: db.poolFor('admin'), rpID: RP, origins: [ORIGIN], totpKey: key });
  });
  after(async () => { await db.drop(); });

  const auth = () => new SoftAuthenticator({ rpID: RP, origin: ORIGIN });
  const q = (sql, a) => db.owner.query(sql, a);
  const count = async (sql, a) => Number((await q(sql, a)).rows[0].n);

  async function enroll(user, a = auth(), session = sid()) {
    const token = await svc.createEnrollmentToken({ userId: user, createdBy: 'ops' });
    const opts = await svc.beginRegistration({ userId: user, userName: user, sessionHash: session, enrollmentToken: token });
    await svc.finishRegistration({ userId: user, sessionHash: session, response: a.create(opts), label: 'laptop', enrollmentToken: token });
    return a;
  }
  async function stepUp(user, session, action, a, tamper = {}) {
    const opts = await svc.beginAssertion({ userId: user, sessionHash: session, action });
    return svc.finishAssertion({ userId: user, sessionHash: session, action, response: a.get(opts, tamper) });
  }

  test('FIRST FACTOR needs a one-time out-of-band token: a session alone cannot enrol one', async () => {
    const user = uid(), s = sid();
    for (const bad of [undefined, '', 'short', 'x'.repeat(40)]) await assert.rejects(svc.beginRegistration({ userId: user, userName: user, sessionHash: s, enrollmentToken: bad }), { code: 'not_authorized' });
    const other = await svc.createEnrollmentToken({ userId: uid(), createdBy: 'ops' });
    await assert.rejects(svc.beginRegistration({ userId: user, userName: user, sessionHash: s, enrollmentToken: other }), { code: 'not_authorized' }, 'a token issued for someone else');
    assert.equal(await svc.hasFactor(user), false);
    await enroll(user);
    assert.equal(await svc.hasFactor(user), true);
  });

  test('the enrolment token is single use and expires', async () => {
    const user = uid(), s = sid(), a = auth();
    const token = await svc.createEnrollmentToken({ userId: user, createdBy: 'ops' });
    const opts = await svc.beginRegistration({ userId: user, userName: user, sessionHash: s, enrollmentToken: token });
    await svc.finishRegistration({ userId: user, sessionHash: s, response: a.create(opts), enrollmentToken: token });
    const second = auth();
    await db.owner.query(`DELETE FROM webauthn_credentials WHERE user_id=$1`, [user]);              // pretend the user has no factor again
    await assert.rejects(svc.beginRegistration({ userId: user, userName: user, sessionHash: s, enrollmentToken: token }), { code: 'not_authorized' }, 'spent token');
    const short = await svc.createEnrollmentToken({ userId: user, createdBy: 'ops', ttlMs: 300 });
    await sleep(500);
    await assert.rejects(svc.beginRegistration({ userId: user, userName: user, sessionHash: s, enrollmentToken: short }), { code: 'not_authorized' }, 'expired token');
    assert.ok(second);
  });

  test('a SECOND factor needs a fresh step-up with an existing one (consumed on use)', async () => {
    const user = uid(), s = sid(), first = await enroll(user);
    const second = auth();
    await assert.rejects(svc.beginRegistration({ userId: user, userName: user, sessionHash: s }), { code: 'not_authorized' }, 'no proof at all');
    await stepUp(user, s, 'factor.enroll', first);
    const opts = await svc.beginRegistration({ userId: user, userName: user, sessionHash: s });
    await svc.finishRegistration({ userId: user, sessionHash: s, response: second.create(opts), label: 'phone' });
    assert.equal(await count(`SELECT count(*) AS n FROM webauthn_credentials WHERE user_id=$1 AND revoked_at IS NULL`, [user]), 2);
    await assert.rejects(svc.beginRegistration({ userId: user, userName: user, sessionHash: s }), { code: 'not_authorized' }, 'the proof was spent by the first begin');
  });

  test('a passkey step-up creates a grant for THIS session and THIS action only; it is single use', async () => {
    const user = uid(), a = await enroll(user), s = sid();
    const r = await stepUp(user, s, 'override.set', a);
    assert.equal(r.ok, true);
    assert.equal(await svc.consume({ sessionHash: sid(), userId: user, action: 'override.set' }), null, 'another session cannot use it');
    assert.equal(await svc.consume({ sessionHash: s, userId: uid(), action: 'override.set' }), null, 'another user cannot use it');
    assert.equal(await svc.consume({ sessionHash: s, userId: user, action: 'billing.link' }), null, 'another action cannot use it');
    const g = await svc.consume({ sessionHash: s, userId: user, action: 'override.set' });
    assert.equal(g.method, 'webauthn');
    assert.equal(await svc.consume({ sessionHash: s, userId: user, action: 'override.set' }), null, 'spent');
  });

  test('the grant window is five minutes by default and is enforced by the database clock', async () => {
    const user = uid(), a = await enroll(user), s = sid();
    await stepUp(user, s, 'billing.link', a);
    const w = (await q(`SELECT extract(epoch FROM expires_at - verified_at) AS secs FROM stepup_grants WHERE session_hash=$1`, [s])).rows[0].secs;
    assert.equal(Math.round(w), 300);
    const fast = new StepUpService({ pool: db.poolFor('admin'), rpID: RP, origins: [ORIGIN], windowMs: 700 });
    const s2 = sid(); const opts = await fast.beginAssertion({ userId: user, sessionHash: s2, action: 'billing.link' });
    await fast.finishAssertion({ userId: user, sessionHash: s2, action: 'billing.link', response: a.get(opts) });
    await sleep(1000);
    assert.equal(await fast.consume({ sessionHash: s2, userId: user, action: 'billing.link' }), null, 'stale proof is refused');
  });

  test('ten simultaneous consumers of one grant: exactly one wins', async () => {
    const user = uid(), a = await enroll(user), s = sid();
    await stepUp(user, s, 'customer.status', a);
    const rs = await Promise.all(Array.from({ length: 10 }, () => svc.consume({ sessionHash: s, userId: user, action: 'customer.status' })));
    assert.equal(rs.filter(Boolean).length, 1);
  });

  test('logging out revokes every open grant and challenge of the session at once', async () => {
    const user = uid(), a = await enroll(user), s = sid();
    await stepUp(user, s, 'override.remove', a);
    const opts = await svc.beginAssertion({ userId: user, sessionHash: s, action: 'billing.link' });
    await svc.revokeSession(s);
    assert.equal(await svc.consume({ sessionHash: s, userId: user, action: 'override.remove' }), null);
    await assert.rejects(svc.finishAssertion({ userId: user, sessionHash: s, action: 'billing.link', response: a.get(opts) }), { code: 'not_authorized' }, 'the open challenge died too');
  });

  test('a challenge is single use, session-bound, action-bound and short-lived (replay, cross-session, cross-action, expiry)', async () => {
    const user = uid(), a = await enroll(user), s = sid();
    const opts = await svc.beginAssertion({ userId: user, sessionHash: s, action: 'override.set' });
    const response = a.get(opts);
    assert.equal((await svc.finishAssertion({ userId: user, sessionHash: s, action: 'override.set', response })).ok, true);
    await assert.rejects(svc.finishAssertion({ userId: user, sessionHash: s, action: 'override.set', response }), { code: 'not_authorized' }, 'the very same response replayed');

    const opts2 = await svc.beginAssertion({ userId: user, sessionHash: s, action: 'override.set' });
    await assert.rejects(svc.finishAssertion({ userId: user, sessionHash: sid(), action: 'override.set', response: a.get(opts2) }), { code: 'not_authorized' }, 'another session');
    await assert.rejects(svc.finishAssertion({ userId: user, sessionHash: s, action: 'billing.link', response: a.get(opts2) }), { code: 'not_authorized' }, 'another action');

    const slow = new StepUpService({ pool: db.poolFor('admin'), rpID: RP, origins: [ORIGIN], challengeTtlMs: 400 });
    const s3 = sid(); const o3 = await slow.beginAssertion({ userId: user, sessionHash: s3, action: 'override.set' });
    await sleep(700);
    await assert.rejects(slow.finishAssertion({ userId: user, sessionHash: s3, action: 'override.set', response: a.get(o3) }), { code: 'not_authorized' }, 'expired challenge');
  });

  test('a synced passkey that ALWAYS reports counter 0 (no clone detection possible) is still protected from replay by the single-use challenge', async () => {
    const user = uid(), a = await enroll(user), s = sid();
    const opts = await svc.beginAssertion({ userId: user, sessionHash: s, action: 'override.set' });
    const response = a.get(opts, { counter: 0 });                                     // the authenticator never increments
    assert.equal((await svc.finishAssertion({ userId: user, sessionHash: s, action: 'override.set', response })).ok, true, 'a counter of 0 is legitimate for such passkeys');
    assert.equal(await count(`SELECT sign_count AS n FROM webauthn_credentials WHERE user_id=$1`, [user]), 0);
    await assert.rejects(svc.finishAssertion({ userId: user, sessionHash: s, action: 'override.set', response }), { code: 'not_authorized' }, 'the captured response replayed: only the spent challenge stops it');
    const again = await svc.beginAssertion({ userId: user, sessionHash: s, action: 'override.set' });
    assert.equal((await svc.finishAssertion({ userId: user, sessionHash: s, action: 'override.set', response: a.get(again, { counter: 0 }) })).ok, true, 'a fresh ceremony still works');
  });

  test('every way of forging or mangling the proof is refused, creates no grant, and is audited as a failure', async () => {
    const user = uid(), a = await enroll(user), s = sid();
    const attempts = {
      'wrong origin': { origin: 'https://evil.example' },
      'wrong relying party': { rpID: 'evil.example' },
      'user verification missing': { uv: false },
      'signed by another key': { signWith: otherKey() },
      'wrong ceremony type': { type: 'webauthn.create' },
      'challenge swapped': { challenge: Buffer.from('not-the-challenge-not-the-challenge').toString('base64url') },
      'unknown credential': { id: Buffer.alloc(32, 7).toString('base64url') },
      'counter went backwards (cloned authenticator)': { counter: 1 },
      'counter did not advance': { counter: 3 },
    };
    // advance the genuine counter to a known value (the server stores 3), so a lower or equal one is a real regression
    for (let i = 0; i < 3; i++) { await stepUp(user, s, 'override.set', a); await svc.consume({ sessionHash: s, userId: user, action: 'override.set' }); }
    assert.equal(await count(`SELECT sign_count AS n FROM webauthn_credentials WHERE user_id=$1`, [user]), 3);
    const before = await count(`SELECT count(*) AS n FROM stepup_grants WHERE user_id=$1`, [user]);
    for (const [name, t] of Object.entries(attempts)) {
      await assert.rejects(stepUp(user, s, 'override.set', a, t), { code: 'not_authorized' }, name);
    }
    for (const junk of [null, undefined, 'x', {}, { id: 5 }, { id: a.id, response: {} }, { id: a.id, response: { clientDataJSON: 'x' } }]) {
      const opts = await svc.beginAssertion({ userId: user, sessionHash: s, action: 'override.set' });
      await assert.rejects(svc.finishAssertion({ userId: user, sessionHash: s, action: 'override.set', response: junk }), { code: 'not_authorized' }, JSON.stringify(junk));
      assert.ok(opts);
    }
    assert.equal(await count(`SELECT count(*) AS n FROM stepup_grants WHERE user_id=$1`, [user]), before, 'not one grant was created');
    const failures = await count(`SELECT count(*) AS n FROM stepup_audit WHERE user_id=$1 AND event='assert_finish' AND ok=false`, [user]);
    assert.ok(failures >= Object.keys(attempts).length + 7, 'failures are audited: ' + failures);
    assert.equal((await stepUp(user, s, 'override.set', a)).ok, true, 'and the genuine passkey still works afterwards');
  });

  test('a passkey registered for one user cannot be used for another; a revoked passkey stops working', async () => {
    const [alice, bob] = [uid(), uid()], aa = await enroll(alice), ab = await enroll(bob), s = sid();
    const opts = await svc.beginAssertion({ userId: bob, sessionHash: s, action: 'override.set' });
    await assert.rejects(svc.finishAssertion({ userId: bob, sessionHash: s, action: 'override.set', response: aa.get(opts) }), { code: 'not_authorized' }, "alice's key for bob");
    await stepUp(alice, s, 'factor.revoke', aa);
    assert.deepEqual(await svc.revokeCredential({ userId: alice, sessionHash: s, credentialId: aa.id }), { ok: true });
    await assert.rejects(svc.beginAssertion({ userId: alice, sessionHash: s, action: 'override.set' }), { code: 'no_passkey' }, 'no active passkey left');
    await assert.rejects(svc.revokeCredential({ userId: alice, sessionHash: s, credentialId: aa.id }), { code: 'not_authorized' }, 'revocation itself needs a fresh step-up');
    assert.ok(ab);
  });

  test('inputs are validated: unknown actions, malformed users and sessions, and users with no factor', async () => {
    const user = uid(), s = sid();
    for (const bad of ['', 'drop table', 'override.everything', undefined, null]) await assert.rejects(svc.beginAssertion({ userId: user, sessionHash: s, action: bad }), { code: 'invalid_action' }, String(bad));
    await assert.rejects(svc.beginAssertion({ userId: "u'; DROP TABLE x;--", sessionHash: s, action: 'override.set' }), { code: 'invalid_user' });
    await assert.rejects(svc.beginAssertion({ userId: user, sessionHash: 'short', action: 'override.set' }), { code: 'invalid_session' });
    await assert.rejects(svc.beginAssertion({ userId: user, sessionHash: s, action: 'override.set' }), { code: 'no_passkey', statusCode: 409 });
    assert.ok(STEPUP_ACTIONS.includes('customer.status'));
    assert.throws(() => new StepUpService({ pool: db.poolFor('admin') }), /rpID/);
  });

  // ---- TOTP -----------------------------------------------------------------------------------------------------------------
  async function enrollTotp(user, s = sid()) {
    const token = await svc.createEnrollmentToken({ userId: user, createdBy: 'ops' });
    const { secret, uri } = await svc.beginTotp({ userId: user, sessionHash: s, enrollmentToken: token });
    const raw = base32Decode(secret);
    return { raw, uri, secret, confirm: (now) => svc.confirmTotp({ userId: user, sessionHash: s, code: totp(raw, now), now }) };
  }

  test('TOTP: enrol with a token, confirm, then it works as a step-up factor and creates a grant', async () => {
    const user = uid(), s = sid(), t0 = 1_800_000_000_000;
    const e = await enrollTotp(user, s);
    assert.match(e.uri, /^otpauth:\/\/totp\//);
    assert.equal(await svc.hasFactor(user), false, 'an unconfirmed factor does not count');
    assert.deepEqual(await svc.verifyTotp({ userId: user, sessionHash: s, action: 'override.set', code: totp(e.raw, t0), now: t0 }), { ok: false, locked: false }, 'unconfirmed: unusable');
    assert.deepEqual(await e.confirm(t0 + 30_000), { ok: true });
    assert.equal(await svc.hasFactor(user), true);
    const ok = await svc.verifyTotp({ userId: user, sessionHash: s, action: 'override.set', code: totp(e.raw, t0 + 60_000), now: t0 + 60_000 });
    assert.equal(ok.ok, true);
    assert.equal((await svc.consume({ sessionHash: s, userId: user, action: 'override.set' })).method, 'totp');
  });

  test('TOTP: a code works once (replay), drift is bounded, wrong codes are rejected', async () => {
    const user = uid(), s = sid(), t0 = 1_800_100_000_000;
    const e = await enrollTotp(user, s); await e.confirm(t0);
    const code = totp(e.raw, t0 + 60_000);
    const v = (c, now) => svc.verifyTotp({ userId: user, sessionHash: s, action: 'override.set', code: c, now });
    assert.equal((await v(code, t0 + 60_000)).ok, true);
    assert.equal((await v(code, t0 + 60_000)).ok, false, 'the same code again (replay)');
    assert.equal((await v(totp(e.raw, t0 + 30_000), t0 + 61_000)).ok, false, 'an OLDER step than the last accepted one');
    assert.equal((await v(totp(e.raw, t0 + 120_000), t0 + 90_000)).ok, true, 'one step ahead is within drift');
    assert.equal((await v(totp(e.raw, t0 + 400_000), t0 + 150_000)).ok, false, 'far outside drift');
    for (const junk of ['', '12345', 'abcdef', '1234567']) assert.equal((await v(junk, t0 + 160_000)).ok, false, junk);
  });

  test('TOTP: rate limited. Five wrong codes lock the factor even against the RIGHT code, until the lock expires', async () => {
    const quick = new StepUpService({ pool: db.poolFor('admin'), rpID: RP, origins: [ORIGIN], totpKey: key, lockMs: 800 });
    const user = uid(), s = sid(), t0 = 1_800_200_000_000;
    const token = await quick.createEnrollmentToken({ userId: user, createdBy: 'ops' });
    const raw = base32Decode((await quick.beginTotp({ userId: user, sessionHash: s, enrollmentToken: token })).secret);
    await quick.confirmTotp({ userId: user, sessionHash: s, code: totp(raw, t0), now: t0 });
    const v = (code, now) => quick.verifyTotp({ userId: user, sessionHash: s, action: 'override.set', code, now });
    for (let i = 0; i < 5; i++) assert.equal((await v('000000', t0 + 60_000 + i)).ok, false);
    const locked = await v(totp(raw, t0 + 90_000), t0 + 90_000);
    assert.deepEqual(locked, { ok: false, locked: true }, 'the correct code is refused while locked');
    await sleep(1000);
    assert.equal((await v(totp(raw, t0 + 120_000), t0 + 120_000)).ok, true, 'and works after the lock expires');
    assert.equal(await count(`SELECT failures AS n FROM totp_factors WHERE user_id=$1`, [user]), 0, 'success resets the counter');
  });

  test('TOTP secrets are encrypted at rest, bound to their owner, and TOTP is off without a key', async () => {
    const user = uid(), e = await enrollTotp(user);
    const stored = (await q(`SELECT secret_enc FROM totp_factors WHERE user_id=$1`, [user])).rows[0].secret_enc;
    assert.ok(!stored.includes(e.raw), 'the plaintext secret is not in the row');
    const other = uid(); await enrollTotp(other);
    await q(`UPDATE totp_factors SET secret_enc=$1 WHERE user_id=$2`, [stored, other]);          // move a blob to another user's row
    const s = sid();
    await assert.rejects(svc.confirmTotp({ userId: other, sessionHash: s, code: '123456' }), /Unsupported state|unable to authenticate/i, 'authentication fails: bound to its owner');
    const noKey = new StepUpService({ pool: db.poolFor('admin'), rpID: RP, origins: [ORIGIN] });
    await assert.rejects(noKey.beginTotp({ userId: uid(), sessionHash: sid() }), { code: 'totp_disabled' });
  });

  test('TOTP enrolment gates are the same as passkeys: token first, then step-up; and a confirmed factor is not silently replaced', async () => {
    const user = uid(), s = sid();
    await assert.rejects(svc.beginTotp({ userId: user, sessionHash: s }), { code: 'not_authorized' });
    const e = await enrollTotp(user, s); await e.confirm(1_800_300_000_000);
    await assert.rejects(svc.beginTotp({ userId: user, sessionHash: s }), { code: 'not_authorized' }, 'now a step-up is required');
  });

  // ---- storage and audit ----------------------------------------------------------------------------------------------------
  test('only the administration role can touch step-up data; the request path and webhook roles cannot even read it', async () => {
    for (const kind of ['runtime', 'billing']) {
      const p = db.poolFor(kind);
      for (const t of ['webauthn_credentials', 'totp_factors', 'stepup_challenges', 'stepup_grants', 'stepup_enrollment_tokens', 'stepup_audit', 'service_nonces']) {
        await assert.rejects(p.query(`SELECT 1 FROM ${t}`), { code: '42501' }, `${kind} -> ${t}`);
      }
    }
    const admin = db.poolFor('admin');
    await assert.rejects(admin.query(`UPDATE webauthn_credentials SET public_key = '\\x00'`), { code: '42501' }, 'a stored public key can never be replaced');
    await assert.rejects(admin.query(`UPDATE stepup_grants SET expires_at = now() + interval '1 year'`), { code: '42501' }, 'a grant can never be extended');
    await assert.rejects(admin.query(`UPDATE stepup_grants SET action = 'override.set'`), { code: '42501' }, 'nor re-targeted');
    await assert.rejects(admin.query(`DELETE FROM stepup_audit`), { code: '42501' });
  });

  test('the audit trail is append-only, records both outcomes, and never stores a raw session identifier', async () => {
    const user = uid(), a = await enroll(user), s = sid();
    await stepUp(user, s, 'override.set', a);
    await assert.rejects(stepUp(user, s, 'override.set', a, { origin: 'https://evil.example' }));
    const rows = (await q(`SELECT event, ok, session_hash FROM stepup_audit WHERE user_id=$1 ORDER BY occurred_at, id`, [user])).rows;
    assert.ok(rows.some((r) => r.event === 'assert_finish' && r.ok) && rows.some((r) => r.event === 'assert_finish' && !r.ok));
    assert.ok(rows.every((r) => r.session_hash === null || r.session_hash !== s), 'the session id is stored only as a second hash');
    await assert.rejects(q(`UPDATE stepup_audit SET ok = true WHERE user_id=$1`, [user]), /append-only/);
    await assert.rejects(q(`DELETE FROM stepup_audit WHERE user_id=$1`, [user]), /append-only/);
  });
});
