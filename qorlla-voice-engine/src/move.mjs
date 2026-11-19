// Phone -> Meeting transition authority. Every transition is decided HERE, on the server, never by the two pages talking to each other:
//   start  (the person moving the call): the call must be live and the caller a member of it; the Shield (when enforced) must allow the pair (verified, not suspended,
//          same organization); a short-lived, single-use token bound to {call, initiator, recipient, meeting} is minted. Only its hash is kept.
//   accept (the other person, with their own session): the token must be theirs, unexpired, unused and for this call; the Shield is asked AGAIN (the situation may have changed
//          in the seconds since start); the token is spent before the answer leaves, so a replay finds nothing.
// Tokens live in this process only (fail closed on restart); a multi-replica deployment needs them in PostgreSQL first (documented limit).
import { randomBytes, createHash } from 'node:crypto';

const MEETING_ID = /^[0-9][0-9 ]{8,14}[0-9]$/;                 // Qorlla meeting ids are digits, shown in groups (spaces)
const sha = (t) => createHash('sha256').update(String(t)).digest('hex');

export function createMove({ store, shield, enforce, ttlMs = 60000, now = () => Date.now(), maxPerMinute = 6 }) {
  const tokens = new Map(), hits = new Map();
  const deny = (reason, status = 403) => Object.assign(new Error('move_denied'), { code: 'move_denied', status, reason });
  const sweep = () => { const t = now(); for (const [k, v] of tokens) if (v.exp <= t) tokens.delete(k); for (const [k, v] of hits) if (t - v.s > 60000) hits.delete(k); };
  const record = async (actor, decision, reason, ctx) => { try { await shield?.recordEvent?.(actor, 'move.transition', decision, reason, ctx || {}); } catch { /* auditing must never break a call */ } };
  const busy = (account) => { const t = now(), h = hits.get(account); if (!h || t - h.s > 60000) { hits.set(account, { s: t, n: 1 }); return false; } return ++h.n > maxPerMinute; };
  async function guard(a, b) { if (!enforce) return; await store.tx((c) => shield.callGuard(c, a, b)); }
  async function liveMember(account, callId) {
    const c = await store.getCall(callId); if (!c || c.status !== 'active') throw deny('CALL_NOT_ACTIVE', 409);
    if (![c.caller_id, c.callee_id].includes(account)) throw deny('NOT_A_PARTICIPANT');
    return { call: c, peer: c.caller_id === account ? c.callee_id : c.caller_id };
  }
  async function start(account, callId, meetingId) {
    sweep(); if (typeof meetingId !== 'string' || !MEETING_ID.test(meetingId)) throw deny('INVALID_MEETING', 400);
    if (busy(account)) throw deny('RATE_LIMITED', 429);
    let m; try { m = await liveMember(account, callId); } catch (e) { await record(account, 'DENY', e.reason || 'ERROR', { callId }); throw e; }
    try { await guard(account, m.peer); } catch (e) { await record(account, 'DENY', 'SHIELD:' + (e.code || 'error'), { callId, to: m.peer }); throw deny('SHIELD_DENIED'); }
    for (const [k, v] of tokens) if (v.callId === callId) tokens.delete(k);                                   // one open transition per call
    const token = randomBytes(24).toString('base64url');
    tokens.set(sha(token), { callId, from: account, to: m.peer, meetingId, exp: now() + ttlMs });
    await record(account, 'ALLOW', 'START', { callId, to: m.peer, meetingId });
    return { token, expiresIn: Math.round(ttlMs / 1000), recipient: m.peer };
  }
  async function accept(account, callId, token) {
    sweep(); if (typeof token !== 'string' || token.length < 20 || token.length > 80) throw deny('INVALID_TOKEN', 400);
    if (busy(account)) throw deny('RATE_LIMITED', 429);
    const key = sha(token), rec = tokens.get(key);
    if (!rec) { await record(account, 'DENY', 'TOKEN_UNKNOWN_OR_SPENT', { callId }); throw deny('TOKEN_INVALID'); }
    tokens.delete(key);                                                                                       // single use: spent before anything else can fail or succeed
    if (rec.exp <= now()) { await record(account, 'DENY', 'TOKEN_EXPIRED', { callId }); throw deny('TOKEN_INVALID'); }
    if (rec.callId !== callId || rec.to !== account) { await record(account, 'DENY', 'TOKEN_NOT_FOR_YOU', { callId }); throw deny('TOKEN_INVALID'); }
    let m; try { m = await liveMember(account, callId); } catch (e) { await record(account, 'DENY', e.reason || 'ERROR', { callId }); throw e; }
    if (m.peer !== rec.from) { await record(account, 'DENY', 'PEER_CHANGED', { callId }); throw deny('TOKEN_INVALID'); }
    try { await guard(rec.from, account); } catch (e) { await record(account, 'DENY', 'SHIELD:' + (e.code || 'error'), { callId, from: rec.from }); throw deny('SHIELD_DENIED'); }
    await record(account, 'ALLOW', 'ACCEPT', { callId, from: rec.from, meetingId: rec.meetingId });
    return { meetingId: rec.meetingId, from: rec.from };
  }
  return { start, accept, _size: () => tokens.size };
}
