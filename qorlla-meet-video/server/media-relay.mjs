// Relay-only media for Meet rooms (v4.32), on the Voice Engine's own TURN credential and allocation services (qorlla-voice-engine: /v1/voice/admin/turn/*).
//
//   * a participant gets relay credentials that name THEIR room epoch (principal meet:<meeting>:<participant>:<epoch>), short-lived, from the Voice Engine, never from the browser;
//   * moving rooms bumps the epoch: the old epoch's credentials are revoked and its live relay allocations are cancelled, so media of a room somebody left cannot keep flowing through the relay;
//   * ending the rooms, or a participant leaving, revokes theirs too;
//   * with relay-only policy, if the Voice Engine cannot be reached nobody is given a direct-connection fallback: the page gets an error and says so (fail closed);
//   * the relay can be asked what it carries for a principal. That is a RELAY OBSERVATION: it shows bytes crossed the relay for that credential. It does not show what the bytes contained, who decoded them, or
//     that a person in another room cannot also receive them from a malicious peer, so it is never labelled "verified". Labels: "Client reported", "Relay observed", "Media verification unavailable".
// Without VOICE_ENGINE_URL + VOICE_ENGINE_ADMIN_SECRET this module is off and Meet keeps its own shared-secret TURN credentials (non-revocable, as before).
export const principalOf = (mid, pid, epoch) => `meet:${String(mid).toLowerCase()}:${String(pid).toLowerCase()}:${Number(epoch)}`;

export function createMediaRelay({ env = process.env, fetchImpl = fetch, timeoutMs = 5000, logger = console } = {}) {
  const url = String(env.VOICE_ENGINE_URL || '').replace(/\/$/, ''), secret = String(env.VOICE_ENGINE_ADMIN_SECRET || '');
  const configured = !!url;
  if (configured && !/^https?:\/\//.test(url)) throw new Error('VOICE_ENGINE_URL must be an http(s) URL');
  if (configured && secret.length < 32) throw new Error('VOICE_ENGINE_URL needs VOICE_ENGINE_ADMIN_SECRET of at least 32 characters');
  const relayOnly = env.ICE_TRANSPORT_POLICY === 'relay';
  const issued = new Map();          // meetingId -> Map(principal -> { pid, epoch })   (what THIS instance handed out)
  const hold = (mid) => issued.get(mid) || issued.set(mid, new Map()).get(mid);
  async function call(path, body) {
    let r; try { r = await fetchImpl(url + '/v1/voice/admin/turn' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-voice-admin-secret': secret }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw Object.assign(new Error('The relay service is unreachable'), { code: 'relay_unreachable' }); }
    if (r.status === 503) throw Object.assign(new Error('The relay service has no TURN configured'), { code: 'turn_not_configured' });
    if (!r.ok) throw Object.assign(new Error('The relay service refused the request (' + r.status + ')'), { code: 'relay_refused' });
    return r.json();
  }
  /** ICE servers for this participant in their CURRENT room epoch. `stunServers` (public STUN from ICE_SERVERS_JSON) are kept. */
  async function iceFor(mid, pid, epoch, stunServers = []) {
    const r = await call('/meet-credentials', { meetingId: mid, participantId: pid, epoch, relayOnly });
    const p = principalOf(mid, pid, epoch); hold(mid).set(p, { pid, epoch });
    return { iceServers: [...stunServers, ...r.iceServers.filter((s) => s.username)], iceTransportPolicy: r.iceTransportPolicy === 'relay' ? 'relay' : 'all', expiresIn: r.expiresIn, perEpoch: true };
  }
  /** end one participant's relay media for a room epoch: credentials revoked, live allocations cancelled. Never throws: the outcome says what happened. */
  async function revoke(principals) {
    const ps = [...new Set(principals)]; if (!configured || !ps.length) return { revoked: 0, errors: [] };
    const out = { revoked: 0, errors: [] };
    for (let i = 0; i < ps.length; i += 100) {
      try { const r = await call('/revoke', { principals: ps.slice(i, i + 100) }); for (const [p, x] of Object.entries(r.results || {})) { out.revoked++; for (const e of x.errors || []) if (e !== 'cli_not_configured') out.errors.push(p + ':' + e); } }
      catch (e) { out.errors.push(e.code || 'error'); logger.error?.('[media-relay] revoke failed:', e.message); }
    }
    for (const p of ps) for (const m of issued.values()) m.delete(p);
    return out;
  }
  const revokeEpoch = async (mid, pid, epoch) => { const p = principalOf(mid, pid, epoch); return hold(mid).has(p) ? revoke([p]) : { revoked: 0, errors: [] }; };          // only what this instance handed out
  const revokeParticipant = (mid, pid) => revoke([...hold(mid)].filter(([, v]) => v.pid === pid).map(([p]) => p));
  const revokeMeeting = (mid) => revoke([...hold(mid).keys()]);
  const principalsOfMeeting = (mid) => [...hold(mid)].map(([principal, v]) => ({ principal, ...v }));
  /** the relay's own view of these principals. A relay that cannot be asked yields observed:false: "unobserved" is never turned into "zero traffic". */
  async function observe(principals) {
    const ps = [...new Set(principals)].slice(0, 200); if (!configured || !ps.length) return {};
    try { return (await call('/observe', { principals: ps })).results || {}; } catch (e) { logger.error?.('[media-relay] observe failed:', e.message); return Object.fromEntries(ps.map((p) => [p, { observed: false, reason: e.code || 'error' }])); }
  }
  return { configured, relayOnly, iceFor, revoke, revokeEpoch, revokeParticipant, revokeMeeting, principalsOfMeeting, observe };
}

/** what the host may say about one person's media. Never "verified": there is no infrastructure here that could back that word. */
export function mediaEvidence({ client, relay }) {
  const traffic = !!relay?.observed && relay.relayedBytes > 0, alloc = !!relay?.observed && relay.allocations > 0;
  const labels = []; if (client === 'client_reported') labels.push('Client reported'); if (traffic) labels.push('Relay observed');
  return { client: client === 'client_reported' ? 'reported' : client === 'failed' ? 'failed' : 'none', relay: traffic ? 'traffic' : alloc ? 'allocation' : relay?.observed === false ? 'unobserved' : 'none', labels: labels.length ? labels : ['Media verification unavailable'], verified: false };
}
