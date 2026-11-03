// Telephone call lifecycle for Qorlla Meet: the states, the only moves between them, and the rule that decides whether audio is real.
//
//   REQUESTED -> VERIFIED -> AWAITING_HOST -> APPROVED -> MEDIA_CONNECTING -> MEDIA_CONNECTED -> TERMINATED
//   REFUSED (the PIN/meeting/host/Shield said no), TIMED_OUT (nobody answered in time), CANCELLED (the caller hung up first),
//   ORPHANED (media showed up for a call Meet had already refused, ended or timed out: it must be torn down and an operator told).
//
// A correct PIN, an acknowledged webhook, a host's approval or a Shield "allow" move a call toward APPROVED. Only MEDIA_CONNECTED means a person can be heard, and only audioVerified() gets a call there.
import crypto from 'node:crypto';

export const STATES = ['REQUESTED', 'VERIFIED', 'AWAITING_HOST', 'APPROVED', 'MEDIA_CONNECTING', 'MEDIA_CONNECTED', 'TERMINATED', 'REFUSED', 'TIMED_OUT', 'CANCELLED', 'ORPHANED'];
export const TRANSITIONS = {
  REQUESTED: ['VERIFIED', 'REFUSED', 'CANCELLED', 'TIMED_OUT'],
  VERIFIED: ['AWAITING_HOST', 'APPROVED', 'REFUSED', 'CANCELLED', 'TIMED_OUT'],
  AWAITING_HOST: ['APPROVED', 'REFUSED', 'TIMED_OUT', 'CANCELLED'],
  APPROVED: ['MEDIA_CONNECTING', 'REFUSED', 'TIMED_OUT', 'CANCELLED', 'TERMINATED', 'ORPHANED'],
  MEDIA_CONNECTING: ['MEDIA_CONNECTED', 'REFUSED', 'TIMED_OUT', 'CANCELLED', 'TERMINATED', 'ORPHANED'],
  MEDIA_CONNECTED: ['TERMINATED'],
  REFUSED: ['ORPHANED', 'TERMINATED'], TIMED_OUT: ['ORPHANED', 'TERMINATED'], CANCELLED: ['ORPHANED', 'TERMINATED'],
  ORPHANED: ['TERMINATED'],
  TERMINATED: []
};
export const OPEN = ['REQUESTED', 'VERIFIED', 'AWAITING_HOST', 'APPROVED', 'MEDIA_CONNECTING', 'MEDIA_CONNECTED'];
export const ENDED = ['REFUSED', 'TIMED_OUT', 'CANCELLED', 'TERMINATED', 'ORPHANED'];
export const canMove = (from, to) => (TRANSITIONS[from] || []).includes(to);
export const movesInto = (to) => STATES.filter((s) => canMove(s, to));

/** The legacy `status` column, derived. 'connected' exists ONLY for MEDIA_CONNECTED (the database enforces it too). */
export function legacyStatus(state, hint) {
  if (state === 'MEDIA_CONNECTED') return 'connected';
  if (state === 'REFUSED') return 'denied';
  if (state === 'TERMINATED') return hint === 'removed' ? 'removed' : 'ended';
  if (['TIMED_OUT', 'CANCELLED', 'ORPHANED'].includes(state)) return 'ended';
  return 'waiting';                                           // REQUESTED, VERIFIED, AWAITING_HOST, APPROVED, MEDIA_CONNECTING: nobody is connected yet
}

// ---------------------------------------------------------------------------------------- audio evidence
export const CODECS = ['opus', 'PCMU', 'PCMA'];
export const DEFAULT_POLICY = { minPackets: 25, minObservedMs: 500, maxAgeMs: 5000, futureSkewMs: 1000 };
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
/** Strips an evidence report down to the fields Meet understands, with the right types. Anything else is ignored. */
export function cleanEvidence(e) {
  if (!e || typeof e !== 'object') return null;
  return { state: String(e.state || '').slice(0, 20), inboundPackets: e.inboundPackets, outboundPackets: e.outboundPackets, observedMs: e.observedMs, codec: String(e.codec || '').slice(0, 12), encrypted: e.encrypted === true, measuredAt: e.measuredAt, source: e.source === 'synthetic' ? 'synthetic' : 'rtp' };
}
/**
 * Meet's OWN judgement of a media report (it never takes the gateway's word for "connected"): live, fresh, encrypted, packets flowing in BOTH directions for long enough, in an allowed codec.
 * Synthetic evidence (the test double) is accepted only when the caller says it is the test double; a real gateway's synthetic report is refused.
 */
export function audioVerified(evidence, { now = Date.now(), allowSynthetic = false, policy = DEFAULT_POLICY } = {}) {
  const e = cleanEvidence(evidence); if (!e) return false;
  if (e.source === 'synthetic' && !allowSynthetic) return false;
  if (e.state !== 'audio_flowing') return false;
  if (!finite(e.inboundPackets) || !finite(e.outboundPackets) || !finite(e.observedMs) || !finite(e.measuredAt)) return false;
  return e.inboundPackets >= policy.minPackets && e.outboundPackets >= policy.minPackets && e.observedMs >= policy.minObservedMs && e.encrypted === true && CODECS.includes(e.codec)
    && now - e.measuredAt <= policy.maxAgeMs && e.measuredAt <= now + policy.futureSkewMs;
}

// ---------------------------------------------------------------------------------------- one-time media token
export const newMediaToken = () => crypto.randomBytes(24).toString('base64url');
export const hashToken = (t) => crypto.createHash('sha256').update(String(t || '')).digest('hex');
export const tokenMatches = (token, storedHash) => { if (!token || !storedHash) return false; const a = Buffer.from(hashToken(token)), b = Buffer.from(String(storedHash)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
