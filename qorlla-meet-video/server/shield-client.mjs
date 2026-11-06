// Qorlla Meet -> Security Shield. Meet stays the authority for meetings, passcodes, the waiting room and host approval; the shield decides whether an ADMITTED participant may keep a signaling session.
// Authenticated with a short-lived workload credential (never a shared secret). With SHIELD_MEET_ENFORCE=true every failure here means "deny": Meet never grants a session the shield did not.
import { signWorkloadJwt } from './telephony/number-sync.mjs';
import { transportFromEnv } from './telephony/workload-transport.mjs';

export function shieldConfig(env = process.env) {
  const enforce = env.SHIELD_MEET_ENFORCE === 'true', url = String(env.SHIELD_URL || '').replace(/\/+$/, '');
  const key = String(env.SHIELD_MEET_KEY_PEM || '').replace(/\\n/g, '\n'), issuer = env.SHIELD_WORKLOAD_ISSUER || '';
  return { enforce, configured: !!(url && key && issuer), url, key, issuer, kid: env.SHIELD_WORKLOAD_KID || 'w1', transport: transportFromEnv(env), recheckMs: Math.max(1000, Number(env.SHIELD_RECHECK_SECONDS || 15) * 1000), graceMs: Math.max(1000, Number(env.SHIELD_RECHECK_GRACE_SECONDS || 120) * 1000) };
}

export function createShieldClient({ config, fetchImpl = (config.transport && config.transport.fetchImpl) || fetch, now = () => Date.now() }) {
  const call = async (path, body) => {
    const r = await fetchImpl(config.url + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signWorkloadJwt({ privateKeyPem: config.key, kid: config.kid, issuer: config.issuer, subject: 'svc:meet', cnfThumbprint: config.transport ? config.transport.thumbprint : undefined }) }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
    const data = await r.json().catch(() => ({})); return { status: r.status, data };
  };
  const state = { lastOk: now() };
  return {
    state,
    /** Meet's facts about a meeting, pushed before each decision (idempotent) -> { ok, status, error }: a 409 `meeting_ended` is the Shield REFUSING (the meeting is over), not the Shield being unavailable. */
    async registerResult(m) { try { const r = await call('/v1/shield/meet/register', { meetingId: m.id, orgId: m.org_id || null, hostAccountId: m.host_account_id || null, guestEnabled: m.guest_enabled !== false, endsAt: new Date(Date.now() + 24 * 3600e3).toISOString() }); return { ok: r.status === 200, status: r.status, error: (r.data && r.data.error) || null }; } catch { return { ok: false, status: 0, error: 'unreachable' }; } },
    /** Returns false when the shield could not take them. */
    async register(m) { return (await this.registerResult(m)).ok; },
    /** -> { allow, reason, kind, capabilities }. ANY failure is a denial. */
    async authorize({ meetingId, participantId, accountId, role, admission }) {
      try { const r = await call('/v1/shield/meet/authorize', { meetingId, participantId, ...(accountId ? { accountId } : {}), role, admission }); state.lastOk = now(); return r.status === 200 && r.data.allow === true ? r.data : { allow: false, reason: r.data.reason || 'SHIELD_REFUSED' }; }
      catch { return { allow: false, reason: 'SHIELD_UNAVAILABLE' }; }
    },
    /** -> { revoke: [...] } or null when the shield could not be asked (the caller applies the grace period). */
    async recheck(participants) { try { const r = await call('/v1/shield/meet/recheck', { participants }); if (r.status !== 200 || !Array.isArray(r.data.revoke)) return null; state.lastOk = now(); return r.data; } catch { return null; } },
    /** Tell the Shield about an operational failure Meet could not handle itself (it becomes a durable alert). Best effort: never throws. */
    async reportResult(kind, ref) { try { const r = await call('/v1/shield/report', { kind, source: 'meet', ...(ref ? { ref: String(ref).replace(/[^A-Za-z0-9_.:@-]/g, '').slice(0, 80) } : {}) }); return { ok: r.status === 200, status: r.status }; } catch { return { ok: false, status: 0 }; } },
    async report(kind, ref) { return (await this.reportResult(kind, ref)).ok; },
    async endResult(meetingId) { try { const r = await call('/v1/shield/meet/end', { meetingId }); return { ok: r.status === 200, status: r.status }; } catch { return { ok: false, status: 0 }; } },
    async end(meetingId) { return (await this.endResult(meetingId)).ok; }
  };
}

/**
 * Periodic re-check of the open signaling sessions. Suspended / unknown / ended => the session is terminated. If the shield stays unreachable past the grace period, sessions are terminated too (fail closed).
 * A5.5: every session the Shield revokes leaves ONE audit row (`session.revoked_by_shield`: the reason and whether it was a browser or a telephone verification peer), so the underlying cause is recorded whichever
 * mechanism closes the session. A telephone verification peer is not simply disconnected: its call is first ended through the phone module (`onPhonePeer`) with the Shield's reason, so the call never ends as
 * "signalling lost" when the real cause is the Shield. In an outage the phone module's own deadline (measured from the first failed recheck) governs phone peers; the guard leaves them to it.
 */
export function startSessionGuard({ io, db, client, config, log = console, audit = null, onPhonePeer = null }) {
  const revoking = new WeakSet(); let busy = false;                                                           // a session being revoked is not revoked again by the next tick, and ticks do not overlap
  const t = setInterval(async () => {
    if (busy) return; busy = true; try {
    const live = [...io.sockets.sockets.values()].filter((s) => s.data && s.data.user && !revoking.has(s));
    if (!live.length) { client.state.lastOk = Date.now(); return; }
    const list = live.map((s) => ({ meetingId: s.data.user.meetingId, participantId: s.data.user.participantId, ...(s.data.accountId ? { accountId: s.data.accountId } : {}) })).slice(0, 500);
    const out = await client.recheck(list), stop = async (s, reason) => {
      if (revoking.has(s)) return; revoking.add(s); const u = s.data.user; try { audit?.(u.meetingId, u.participantId, 'session.revoked_by_shield', { reason: String(reason).slice(0, 60), kind: s.data.peer ? 'phone-peer' : 'browser' }); } catch { /* auditing must not stop a revocation */ }
      if (s.data.peer && onPhonePeer) { try { await onPhonePeer(u.meetingId, u.participantId, reason); } catch { client.report('phone_termination_failed', u.participantId); } }       // end the CALL with the Shield's reason first
      try { s.emit('session_revoked', { reason }); s.disconnect(true); } catch { client.report('signaling_termination_failed', u.participantId); }
    };
    if (!out) { if (Date.now() - client.state.lastOk > config.graceMs) { log.error('[shield] unreachable beyond the grace period: closing sessions'); for (const s of live) if (!(s.data.peer && onPhonePeer)) await stop(s, 'SHIELD_UNAVAILABLE'); } return; }
    for (const rv of out.revoke) {
      const s = live.find((x) => x.data.user.participantId === rv.participantId && x.data.user.meetingId === rv.meetingId); if (s) await stop(s, rv.reason);
      await db.query("UPDATE participants SET admission='denied' WHERE id=$1 AND meeting_id=$2", [rv.participantId, rv.meetingId]).catch(() => { client.report('signaling_termination_failed', rv.participantId); });      // the token cannot be used to come back
    }
    } finally { busy = false; }
  }, config.recheckMs); t.unref(); return () => clearInterval(t);
}
