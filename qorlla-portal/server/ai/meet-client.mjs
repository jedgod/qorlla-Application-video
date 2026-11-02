// Reads the chat of an EXISTING Meet meeting through Meet's read-only integration endpoint (own secret; it cannot schedule, recover or
// change anything). Meet scheduling and host recovery stay entirely in Meet / MAIN.
import { segmentsFromMeetChat } from './parse.mjs';

export function createMeetClient({ baseUrl, readSecret, fetchImpl = fetch, timeoutMs = 10_000 }) {
  const available = !!(baseUrl && readSecret && readSecret.length >= 32);
  async function getJson(path, meetingUuid) {
    if (!available) { const e = new Error('Meet integration is not configured'); e.code = 'no_meet_integration'; e.retryable = false; throw e; }
    let r;
    try { r = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/integrations/meetings/${encodeURIComponent(meetingUuid)}/${path}`, { headers: { 'x-qorlla-readonly-secret': readSecret }, signal: AbortSignal.timeout(timeoutMs) }); }
    catch { const e = new Error('Meet is unreachable'); e.code = 'meet_unreachable'; e.retryable = true; throw e; }
    if (r.status === 404) { const e = new Error('Meeting not found in Meet'); e.code = 'meeting_not_found'; e.retryable = false; throw e; }
    if (!r.ok) { const e = new Error('Meet refused the request (' + r.status + ')'); e.code = 'meet_error'; e.retryable = r.status >= 500; throw e; }
    return r.json();
  }
  /** The chat as Meet has it, with each message's author id. Consent is applied by the caller BEFORE anything is stored. */
  async function fetchChatRaw(meetingUuid) { const j = await getJson('chat', meetingUuid); return { title: j.title, messages: Array.isArray(j.messages) ? j.messages : [] }; }
  async function fetchChat(meetingUuid) {
    const j = await fetchChatRaw(meetingUuid);
    try { return { title: j.title, ...segmentsFromMeetChat(j.messages) }; }
    catch (e) { e.retryable = false; throw e; }
  }
  /** Who agreed to what for Qorlla AI in this meeting (Meet's own append-only records). Unreachable or malformed means NO consent: callers must fail closed. */
  async function fetchConsent(meetingUuid) {
    const j = await getJson('ai-consent', meetingUuid);
    if (!j || typeof j.requested !== 'boolean' || !Array.isArray(j.participants) || j.revision === undefined) { const e = new Error('Meet returned an unreadable consent answer'); e.code = 'meet_error'; e.retryable = true; throw e; }
    // Every number must be present and a non-negative integer: a missing or garbled objectionSeq must never read as "no objection" (that would fail OPEN).
    const bad = () => { const e = new Error('Meet returned an unreadable consent answer'); e.code = 'meet_error'; e.retryable = true; return e; };
    const num = (v) => { if (!/^\d{1,18}$/.test(String(v))) throw bad(); return Number(v); };
    const dec = (d) => { if (!d || typeof d.decision !== 'string' || !d.decision) throw bad(); return { decision: d.decision, seq: num(d.seq), objectionSeq: num(d.objectionSeq) }; };
    // display names are deliberately NOT carried over: identity is the participantId, never typed text
    return { requested: j.requested, revision: num(j.revision), participants: j.participants.filter((p) => p && typeof p.participantId === 'string').map((p) => ({ participantId: p.participantId, role: p.role, decisions: Object.fromEntries(['transcription', 'summary'].map((k) => [k, dec(p.decisions?.[k])])) })) };
  }
  return { available, fetchChat, fetchChatRaw, fetchConsent };
}
