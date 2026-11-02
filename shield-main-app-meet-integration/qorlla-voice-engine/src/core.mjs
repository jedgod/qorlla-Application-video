// Qorlla Voice Engine: pure rules (no I/O). Call state machine, input validation, TURN credentials, ICE configuration, signal sanitising.
import { randomUUID, createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const STATES = { ringing: ['active', 'rejected', 'missed', 'ended', 'failed'], active: ['ended', 'failed'], rejected: [], missed: [], ended: [], failed: [] };
export const LIVE = ['ringing', 'active'];
export const TERMINAL = ['rejected', 'missed', 'ended', 'failed'];
export const allowedTransition = (from, to) => STATES[from]?.includes(to) === true;
/** Emergency numbers can never be internal extensions: dialling 911 must not ring a colleague. Qorlla Voice cannot place emergency calls (no PSTN), so these are refused everywhere an extension is accepted. */
export const EMERGENCY_NUMBERS = new Set(['911', '112', '999', '000', '110', '119', '100', '101', '102', '108', '122', '933']);
export const isEmergencyNumber = (v) => typeof v === 'string' && EMERGENCY_NUMBERS.has(v);
export const validExtension = (v) => typeof v === 'string' && /^[0-9]{3,8}$/.test(v) && !EMERGENCY_NUMBERS.has(v);
export const validCallId = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export const validIdempotencyKey = (v) => typeof v === 'string' && /^[a-zA-Z0-9_-]{12,100}$/.test(v);
export const validAccountId = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:@-]{1,128}$/.test(v);
export const newId = () => randomUUID();
export const publicCall = (c) => ({ id: c.id, caller_id: c.caller_id, callee_id: c.callee_id, status: c.status, created_at: c.created_at, answered_at: c.answered_at, ended_at: c.ended_at, end_reason: c.end_reason || null, version: Number(c.version ?? 0) });

/** Constant-time comparison of two secrets of any length. */
export function secretEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** coturn "REST API" credentials (use-auth-secret): username = expiry:account, credential = base64(HMAC-SHA1(secret, username)). */
export function turnCredentials(accountId, ttl = 600, now = Math.floor(Date.now() / 1000), secret = process.env.TURN_SHARED_SECRET) {
  if (!secret) throw new Error('turn_not_configured');
  const username = `${now + ttl}:${accountId}`;
  return { username, credential: createHmac('sha1', secret).update(username).digest('base64'), ttl };
}

const iceUrls = (list, schemes) => String(list || '').split(',').map((s) => s.trim()).filter((u) => schemes.some((s) => u.toLowerCase().startsWith(s)));
/**
 * The ICE servers a browser should use. Self-hosted only: no third-party STUN is added by default, and a TURN entry is included only when it is really configured
 * (an empty TURN entry makes RTCPeerConnection throw). Without any server, calls work on the same network (host candidates) and the diagnostics say so.
 */
export function iceServersFor(accountId, env = process.env, now) {
  const iceServers = [], stun = iceUrls(env.STUN_URL, ['stun:', 'stuns:']), turn = iceUrls(env.TURN_URLS, ['turn:', 'turns:']);
  if (stun.length) iceServers.push({ urls: stun });
  let turnOn = false;
  if (turn.length && env.TURN_SHARED_SECRET) { const c = turnCredentials(accountId, 600, now, env.TURN_SHARED_SECRET); iceServers.push({ urls: turn, username: c.username, credential: c.credential }); turnOn = true; }
  if (String(env.VOICE_REQUIRE_TURN || '').toLowerCase() === 'true' && !turnOn) throw Object.assign(new Error('turn_not_configured'), { code: 'turn_not_configured' });
  const relayOnly = String(env.VOICE_RELAY_ONLY || '').toLowerCase() === 'true';
  if (relayOnly && !turnOn) throw Object.assign(new Error('turn_not_configured'), { code: 'turn_not_configured' });
  return { iceServers, iceTransportPolicy: relayOnly ? 'relay' : 'all', stun: stun.length > 0, turn: turnOn };
}

const MAX_SDP = 65536, MAX_CANDIDATE = 4096;
/** Whether a signaling message is well formed. This is syntax only: who may send it, and when, is decided against the call record. */
export function safeSignal(msg) {
  if (!msg || typeof msg !== 'object' || !['offer', 'answer', 'ice'].includes(msg.type) || !validCallId(msg.callId)) return false;
  if (msg.type === 'ice') {
    if (msg.candidate === null) return true;
    const c = msg.candidate;
    return !!c && typeof c === 'object' && typeof c.candidate === 'string' && c.candidate.length < MAX_CANDIDATE && (c.sdpMid == null || (typeof c.sdpMid === 'string' && c.sdpMid.length <= 64))
      && (c.sdpMLineIndex == null || (Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 16)) && (c.usernameFragment == null || (typeof c.usernameFragment === 'string' && c.usernameFragment.length <= 256));
  }
  return typeof msg.sdp === 'string' && msg.sdp.length > 0 && msg.sdp.length <= MAX_SDP && msg.sdp.startsWith('v=0');
}
/** Only the standard candidate fields are forwarded to the other party, never extra fields a client attached. */
export const cleanCandidate = (c) => (c === null ? null : { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null, usernameFragment: c.usernameFragment ?? null });

/** Fixed-window limiter: take(key) is true while the key has capacity. Memory is bounded by pruning expired windows. */
export function makeLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return { take(key) {
    const t = now(), h = hits.get(key);
    if (!h || t - h.start >= windowMs) { if (hits.size > 5000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k); hits.set(key, { start: t, n: 1 }); return true; }
    if (h.n >= max) return false; h.n++; return true;
  } };
}

/** Billable/observed seconds come from server timestamps only, never from a client-supplied duration. */
export const callSeconds = (call, now = Date.now()) => (call.answered_at ? Math.max(0, Math.round(((call.ended_at ? new Date(call.ended_at).getTime() : now) - new Date(call.answered_at).getTime()) / 1000)) : 0);
export const ringSeconds = (env = process.env) => { const n = Number(env.VOICE_RING_SECONDS || 60); return Number.isInteger(n) && n >= 5 && n <= 600 ? n : 60; };
