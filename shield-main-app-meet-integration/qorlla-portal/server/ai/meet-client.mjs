// Reads the chat of an EXISTING Meet meeting through Meet's read-only integration endpoint (own secret; it cannot schedule, recover or
// change anything). Meet scheduling and host recovery stay entirely in Meet / MAIN.
import { segmentsFromMeetChat } from './parse.mjs';

export function createMeetClient({ baseUrl, readSecret, fetchImpl = fetch, timeoutMs = 10_000 }) {
  const available = !!(baseUrl && readSecret && readSecret.length >= 32);
  async function fetchChat(meetingUuid) {
    if (!available) { const e = new Error('Meet integration is not configured'); e.code = 'no_meet_integration'; e.retryable = false; throw e; }
    let r;
    try { r = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/integrations/meetings/${encodeURIComponent(meetingUuid)}/chat`, { headers: { 'x-qorlla-readonly-secret': readSecret }, signal: AbortSignal.timeout(timeoutMs) }); }
    catch { const e = new Error('Meet is unreachable'); e.code = 'meet_unreachable'; e.retryable = true; throw e; }
    if (r.status === 404) { const e = new Error('Meeting not found in Meet'); e.code = 'meeting_not_found'; e.retryable = false; throw e; }
    if (!r.ok) { const e = new Error('Meet refused the request (' + r.status + ')'); e.code = 'meet_error'; e.retryable = r.status >= 500; throw e; }
    const j = await r.json();
    try { return { title: j.title, ...segmentsFromMeetChat(j.messages) }; }
    catch (e) { e.retryable = false; throw e; }
  }
  return { available, fetchChat };
}
