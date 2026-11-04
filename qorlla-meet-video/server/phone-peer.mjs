// The restricted VERIFICATION-PHASE telephone peer.
//
// Qorlla Meet has no media server: browsers form a mesh and the server only relays signalling. A telephone caller's audio can therefore only be verified after the telephone gateway's WebRTC peer has negotiated with the
// browsers over Meet's own signalling. This module lets that peer exist - and nothing more - between APPROVED and MEDIA_CONNECTED:
//
//   credential   an ES256 JWT signed by MEET (aud 'qorlla-meet-verification-peer', scope 'meet:telephone:verify-media', <= 60 s) bound to ONE call, ONE meeting, ONE gateway identity. It is issued only after the PIN, the host
//                and the Security Shield have all said yes, and only to the gateway that holds the call's one-time media token. It is consumed ATOMICALLY by the first socket that presents it (a single UPDATE that also checks
//                that the call is still APPROVED/MEDIA_CONNECTING, the meeting is still open and the credential was not revoked); a second use, an expired, revoked, cross-meeting or wrong-audience credential is refused.
//   socket       the same socket.io server (no second namespace). The peer is NOT a participant: it is not in the roster, not in the room, receives no broadcasts, has no participant session, and is not counted as
//                connected. The ONLY handler registered for it is `signal` (offer / answer / candidate to a browser in the same meeting, size and rate bounded). Chat, files, hands, polls, notes, reactions, media state,
//                recording and moderation events simply have no handler for it.
//   promotion    only phone.mjs mediaReport() promotes, and only if this module says the peer is live, belongs to the gateway session that is reporting, and has negotiated with a browser (the server saw an
//                answer cross), on top of Meet's own judgement of the evidence, the Shield, the meeting and the lifecycle. Evidence alone never promotes.
//   revocation   revoke() closes the socket (not merely the token), forgets the peer and records why. Every move of a call into an ending state revokes, so a timeout, a cancel, a host removal, a Shield revocation, a lost
//                gateway or invalid evidence all end the verification access; a late callback finds no peer and a call that can no longer move.
import crypto from 'node:crypto';

export const PEER_AUDIENCE = 'qorlla-meet-verification-peer';
export const PEER_SCOPE = 'meet:telephone:verify-media';
export const PEER_ISSUER = 'qorlla-meet';
export class PeerError extends Error { constructor(reason) { super(reason); this.reason = reason; } }
const b64u = (b) => Buffer.from(b).toString('base64url');
const SIGNALS = ['offer', 'answer', 'candidate', 'restart', 'rebuild'], MAX_SIGNAL_BYTES = 16384;

export function createPhonePeers({ db, io, room = (id) => 'meeting:' + id, env = process.env, now = Date.now, log = console }) {
  let priv = null, pub = null;
  try {
    const pem = String(env.PHONE_PEER_SIGNING_KEY_PEM || '').replace(/\\n/g, '\n');
    if (pem) { priv = crypto.createPrivateKey(pem); pub = crypto.createPublicKey(priv); if (priv.asymmetricKeyType !== 'ec' || priv.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('the verification-peer signing key must be an EC P-256 key'); }
  } catch (e) { priv = pub = null; log.error?.('[phone-peer] signing key rejected:', e.message); }
  const kid = String(env.PHONE_PEER_KID || 'p1');
  // The subsystem is usable only with a valid signing key AND the v4.25 table. If the table is missing (key configured before the migration ran) it DISABLES ITSELF, loudly: terminating a call must never fail
  // because this optional table is absent, and in gateway mode a disabled subsystem means nothing can be promoted (fail closed).
  let schemaOk = null; const isConfigured = () => !!priv && schemaOk !== false;
  async function checkSchema() { if (!priv) return false; try { await db.query('SELECT 1 FROM phone_peer_credentials LIMIT 0'); schemaOk = true; } catch (e) { schemaOk = false; log.error?.('[phone-peer] DISABLED: table phone_peer_credentials is missing (apply sql/v4_25_phone_verification_peer.sql): ' + e.message); } return schemaOk; }
  const ttl = Math.min(60, Math.max(10, Number(env.PHONE_PEER_TTL_S || 60))), maxPeers = Math.max(1, Number(env.PHONE_PEER_MAX || 50)), skew = 5;
  const SIGNAL_BUDGET = Number(env.PHONE_PEER_SIGNAL_BUDGET || 300), BUDGET_MS = 10_000;
  const live = new Map(), byAddr = new Map();                                         // callId -> entry;  `meeting|participant` -> callId
  let hooks = { shieldAllows: async () => ({ allow: false, reason: 'NO_SHIELD' }), onLost: async () => {}, activeList: () => [], browserSocketId: () => undefined };
  const bind = (h) => { hooks = { ...hooks, ...h }; };
  const addr = (mid, pid) => mid + '|' + pid;

  /** Issues the credential. The caller (phone.mjs) has ALREADY checked the media token, the Shield and the meeting; this checks the lifecycle again under the call's row lock. */
  async function issue(callId, subject) {
    if (!isConfigured()) throw new PeerError('not_configured');
    if (live.size >= maxPeers) throw new PeerError('at_capacity');
    const t = Math.floor(now() / 1000), jti = crypto.randomUUID() + crypto.randomBytes(8).toString('hex'), c = await db.connect();
    try {
      await c.query('BEGIN');
      const { rows: [cur] } = await c.query('SELECT id, state, meeting_id, participant_id FROM phone_calls WHERE id=$1 FOR UPDATE', [callId]);
      if (!cur || !['APPROVED', 'MEDIA_CONNECTING'].includes(cur.state) || !cur.participant_id) { await c.query('ROLLBACK'); throw new PeerError('call_not_approved'); }
      await c.query("UPDATE phone_peer_credentials SET revoked_at=now(), revoked_reason='superseded' WHERE call_id=$1 AND revoked_at IS NULL AND consumed_at IS NULL", [callId]);
      try { await c.query("INSERT INTO phone_peer_credentials(jti, call_id, meeting_id, participant_id, subject, expires_at) VALUES($1,$2,$3,$4,$5, now() + ($6::int * interval '1 second'))", [jti, callId, cur.meeting_id, cur.participant_id, subject, ttl]); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); if (e.code === '23505') throw new PeerError('already_issued'); throw e; }       // a live (consumed) credential exists: revoke it first
      await c.query('COMMIT');
      const claims = { iss: PEER_ISSUER, sub: subject, aud: PEER_AUDIENCE, scope: PEER_SCOPE, iat: t, exp: t + ttl, jti, call: callId, mid: cur.meeting_id, pid: cur.participant_id };
      const head = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid })), body = b64u(JSON.stringify(claims));
      return { token: head + '.' + body + '.' + b64u(crypto.sign('sha256', Buffer.from(head + '.' + body), { key: priv, dsaEncoding: 'ieee-p1363' })), jti, expiresAt: claims.exp, ttlSeconds: ttl };
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }

  /** Socket handshake. Returns the verified identity or throws; the credential is consumed here, once, atomically. */
  async function authenticate(token) {
    if (!isConfigured()) throw new PeerError('not_configured');
    const parts = String(token || '').split('.'); if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new PeerError('malformed');
    let head, claims; try { head = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw new PeerError('malformed'); }
    if (head?.alg !== 'ES256' || head?.typ !== 'JWT' || head?.kid !== kid) throw new PeerError('alg');
    let ok = false; try { ok = crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')); } catch { /* bad signature */ }
    if (!ok) throw new PeerError('signature');
    const t = Math.floor(now() / 1000);
    if (claims.iss !== PEER_ISSUER) throw new PeerError('issuer'); if (claims.aud !== PEER_AUDIENCE) throw new PeerError('audience'); if (claims.scope !== PEER_SCOPE) throw new PeerError('scope');
    if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.exp <= t || claims.iat > t + skew || claims.exp - claims.iat > 60) throw new PeerError('lifetime');
    for (const k of ['jti', 'sub', 'call', 'mid', 'pid']) if (typeof claims[k] !== 'string' || !claims[k] || claims[k].length > 200) throw new PeerError('claims');
    // ONE statement: unused, unrevoked, unexpired (by the DATABASE clock), the call still APPROVED / MEDIA_CONNECTING, the meeting still open. Whoever gets a row owns the credential; everyone else is refused.
    const r = await db.query(`UPDATE phone_peer_credentials k SET consumed_at = now() FROM phone_calls c, meetings m
        WHERE k.jti = $1 AND k.consumed_at IS NULL AND k.revoked_at IS NULL AND k.expires_at > now() AND c.id = k.call_id AND c.state IN ('APPROVED','MEDIA_CONNECTING') AND m.id = c.meeting_id AND m.ended_at IS NULL
        RETURNING k.call_id, k.meeting_id, k.participant_id, k.subject`, [claims.jti]);
    if (!r.rowCount) throw new PeerError('unusable');
    const row = r.rows[0];
    if (row.call_id !== claims.call || row.meeting_id !== claims.mid || row.participant_id !== claims.pid || row.subject !== claims.sub) { await revoke(row.call_id, 'binding_mismatch'); throw new PeerError('binding'); }
    const sh = await hooks.shieldAllows(row.meeting_id, row.participant_id); if (!sh.allow) { await revoke(row.call_id, 'shield_' + String(sh.reason || 'refused').toLowerCase().slice(0, 40)); throw new PeerError('shield'); }
    return { user: { meetingId: row.meeting_id, participantId: row.participant_id, role: 'phone-verify', name: 'Telephone' }, callId: row.call_id, jti: claims.jti, subject: row.subject };
  }

  /** Called by the connection handler for an authenticated verification peer INSTEAD of the participant machinery. Registers the only handler it gets. */
  async function attach(socket, info) {
    const { callId } = info, mid = info.user.meetingId, pid = info.user.participantId, prior = live.get(callId);
    if (prior) { live.delete(callId); try { prior.socket.disconnect(true); } catch { /* gone */ } }                       // a second socket for the same call replaces the first; credentials are single-use, so this is only reachable through revoke races
    const entry = { socket, callId, jti: info.jti, subject: info.subject, mid, pid, negotiated: false, promoted: false, ready: false, stamps: [], connectedAt: now() };
    live.set(callId, entry); byAddr.set(addr(mid, pid), callId);                                                        // the peer is deliberately NOT in the meeting's room: it receives no room broadcasts
    // Handlers are registered SYNCHRONOUSLY, before anything is awaited: a gateway that drops right after connecting must still be noticed (a lost gateway ends the call).
    socket.on('disconnect', () => { if (live.get(callId) === entry) { forget(entry); hooks.onLost(callId, 'gateway_signaling_lost').catch(() => {}); } });                  // a revoke() already forgot the entry, so a revoked peer never reports itself lost
    socket.on('signal', ({ to, data } = {}, ack) => {
      const reply = (o) => { if (typeof ack === 'function') ack(o); };
      if (live.get(callId) !== entry) return reply({ ok: false, error: 'Revoked' }); if (!entry.ready) return reply({ ok: false, error: 'Not ready' });
      const t = now(); entry.stamps = entry.stamps.filter((s) => t - s < BUDGET_MS); if (entry.stamps.length >= SIGNAL_BUDGET) return reply({ ok: false, error: 'Rate limited' }); entry.stamps.push(t);
      if (typeof to !== 'string' || !data || typeof data !== 'object' || !SIGNALS.includes(data.type)) return reply({ ok: false, error: 'Invalid signal' });
      let size = 0; try { size = Buffer.byteLength(JSON.stringify(data)); } catch { size = Infinity; } if (size > MAX_SIGNAL_BYTES) return reply({ ok: false, error: 'Signal too large' });
      const target = hooks.browserSocketId(mid, to); if (!target || to === pid) return reply({ ok: false, error: 'Participant offline' });                 // only admitted browsers of THIS meeting
      io.to(target).emit('signal', { from: pid, data }); if (data.type === 'answer') entry.negotiated = true; reply({ ok: true });
    });
    const { rows } = await db.query('SELECT 1 FROM phone_peer_credentials WHERE jti=$1 AND revoked_at IS NULL', [info.jti]);        // revoked between consume and attach: never go live
    if (live.get(callId) !== entry) return false;                                                                                       // revoked or dropped while we were checking: already cleaned up
    if (!rows.length || !socket.connected) { forget(entry); try { socket.disconnect(true); } catch { /* gone */ } if (rows.length) hooks.onLost(callId, 'gateway_signaling_lost').catch(() => {}); return false; }
    entry.ready = true; socket.emit('roster', hooks.activeList(mid).filter((x) => x !== pid));
    return true;
  }
  const forget = (e) => { if (live.get(e.callId) === e) live.delete(e.callId); if (byAddr.get(addr(e.mid, e.pid)) === e.callId) byAddr.delete(addr(e.mid, e.pid)); };

  /** Browser -> peer relay: the peer's socket id if (and only if) it is a LIVE verification peer of that meeting. */
  const socketIdFor = (mid, pid) => { const id = byAddr.get(addr(mid, pid)); return id ? live.get(id)?.socket.id : undefined; };
  const noteFromBrowser = (mid, pid, type) => { const e = live.get(byAddr.get(addr(mid, pid))); if (e && type === 'answer') e.negotiated = true; };
  /** The media report may promote only if this returns null. */
  function notReady(callId, jti, subject) {
    const e = live.get(callId); if (!e) return 'no_verification_peer'; if (!jti || e.jti !== jti) return 'peer_session_mismatch';           // the report must come from the gateway session that holds the consumed credential...
    if (!subject || e.subject !== subject) return 'peer_subject_mismatch';                                                                  // ...authenticated as the same workload identity the credential was issued to (call ownership)
    if (!e.socket.connected) return 'peer_disconnected'; if (!e.negotiated) return 'peer_not_negotiated'; return null;
  }
  async function promote(callId) { const e = live.get(callId); if (e) e.promoted = true; await db.query('UPDATE phone_peer_credentials SET promoted_at=now() WHERE call_id=$1 AND revoked_at IS NULL AND consumed_at IS NOT NULL', [callId]); }
  /** Ends verification access: the socket is closed, the credential is revoked, the reason is recorded. Idempotent; safe to call for a call that never had a peer. */
  async function revoke(callId, reason) {
    const e = live.get(callId); if (e) { forget(e); try { e.socket.emit('revoked', { reason: String(reason || 'revoked').slice(0, 60) }); e.socket.disconnect(true); } catch { /* gone */ } }
    const r = await db.query('UPDATE phone_peer_credentials SET revoked_at=now(), revoked_reason=$2 WHERE call_id=$1 AND revoked_at IS NULL', [callId, String(reason || 'revoked').slice(0, 60)]);
    return !!e || r.rowCount > 0;
  }
  /** Tells the ready verification peers of a meeting that a participant left (they hear nothing else about the room). */
  const notifyOffline = (mid, pid) => { for (const e of live.values()) if (e.mid === mid && e.ready && e.pid !== pid) { try { e.socket.emit('participant-offline', { participantId: pid }); } catch { /* going away */ } } };
  const stats = () => ({ live: live.size, configured: isConfigured(), ttlSeconds: ttl });
  return { get configured() { return isConfigured(); }, checkSchema, bind, issue, authenticate, attach, socketIdFor, noteFromBrowser, notReady, notifyOffline, promote, revoke, stats };
}
