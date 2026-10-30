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
    /** Meet's facts about a meeting, pushed before each decision (idempotent). Returns false when the shield could not take them. */
    async register(m) { try { const r = await call('/v1/shield/meet/register', { meetingId: m.id, orgId: m.org_id || null, hostAccountId: m.host_account_id || null, guestEnabled: m.guest_enabled !== false, endsAt: new Date(Date.now() + 24 * 3600e3).toISOString() }); return r.status === 200; } catch { return false; } },
    /** -> { allow, reason, kind, capabilities }. ANY failure is a denial. */
    async authorize({ meetingId, participantId, accountId, role, admission }) {
      try { const r = await call('/v1/shield/meet/authorize', { meetingId, participantId, ...(accountId ? { accountId } : {}), role, admission }); state.lastOk = now(); return r.status === 200 && r.data.allow === true ? r.data : { allow: false, reason: r.data.reason || 'SHIELD_REFUSED' }; }
      catch { return { allow: false, reason: 'SHIELD_UNAVAILABLE' }; }
    },
    /** -> { revoke: [...] } or null when the shield could not be asked (the caller applies the grace period). */
    async recheck(participants) { try { const r = await call('/v1/shield/meet/recheck', { participants }); if (r.status !== 200 || !Array.isArray(r.data.revoke)) return null; state.lastOk = now(); return r.data; } catch { return null; } },
    /** Tell the Shield about an operational failure Meet could not handle itself (it becomes a durable alert). Best effort: never throws. */
    async report(kind, ref) { try { return (await call('/v1/shield/report', { kind, source: 'meet', ...(ref ? { ref: String(ref).replace(/[^A-Za-z0-9_.:@-]/g, '').slice(0, 80) } : {}) })).status === 200; } catch { return false; } },
    async end(meetingId) { try { return (await call('/v1/shield/meet/end', { meetingId })).status === 200; } catch { return false; } }
  };
}

/** Periodic re-check of the open signaling sessions. Suspended / unknown / ended => the session is terminated. If the shield stays unreachable past the grace period, sessions are terminated too (fail closed). */
export function startSessionGuard({ io, db, client, config, log = console }) {
  const t = setInterval(async () => {
    const live = [...io.sockets.sockets.values()].filter((s) => s.data && s.data.user);
    if (!live.length) { client.state.lastOk = Date.now(); return; }
    const list = live.map((s) => ({ meetingId: s.data.user.meetingId, participantId: s.data.user.participantId, ...(s.data.accountId ? { accountId: s.data.accountId } : {}) })).slice(0, 500);
    const out = await client.recheck(list), stop = (s, reason) => { try { s.emit('session_revoked', { reason }); s.disconnect(true); } catch { client.report('signaling_termination_failed', s.data.user.participantId); } };
    if (!out) { if (Date.now() - client.state.lastOk > config.graceMs) { log.error('[shield] unreachable beyond the grace period: closing sessions'); for (const s of live) stop(s, 'SHIELD_UNAVAILABLE'); } return; }
    for (const rv of out.revoke) {
      const s = live.find((x) => x.data.user.participantId === rv.participantId && x.data.user.meetingId === rv.meetingId); if (s) stop(s, rv.reason);
      await db.query("UPDATE participants SET admission='denied' WHERE id=$1 AND meeting_id=$2", [rv.participantId, rv.meetingId]).catch(() => { client.report('signaling_termination_failed', rv.participantId); });      // the token cannot be used to come back
    }
  }, config.recheckMs); t.unref(); return () => clearInterval(t);
}
