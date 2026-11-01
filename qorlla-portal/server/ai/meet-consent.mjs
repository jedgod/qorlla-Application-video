// Participant-level consent for Meet AI. Pure decisions over what Meet reports (its append-only ai_consents, read through the read-only integration).
// Host attestation (portal.meeting_ai_consents) is a separate, additional requirement checked elsewhere: it can never stand in for a participant's own answer.
//   * a message is processed only if its AUTHOR agreed to BOTH purposes (transcription and summary) and the host's AI request is still open;
//   * "pending" (a late joiner who has not answered), "declined" and "withdrawn" are all excluded, and excluded content is never stored;
//   * an imported transcript cannot be split by person, so it is allowed only while nobody in the meeting has declined or withdrawn.
export const CORE_PURPOSES = ['transcription', 'summary'];
const decisionOf = (p, k) => p?.decisions?.[k]?.decision || 'pending';
export const agreedToAll = (p) => !!p && CORE_PURPOSES.every((k) => decisionOf(p, k) === 'agree');
const why = (p) => (CORE_PURPOSES.some((k) => decisionOf(p, k) === 'withdraw') ? 'withdrawn' : CORE_PURPOSES.some((k) => decisionOf(p, k) === 'decline') ? 'declined' : 'pending');

/** @returns {{requested:boolean, included:object[], excluded:{pending:number,declined:number,withdrawn:number,unknown:number}, participants:object[]}} */
export function applyParticipantConsent({ messages, consent }) {
  const byId = new Map((consent?.participants || []).map((p) => [p.participantId, p]));
  const excluded = { pending: 0, declined: 0, withdrawn: 0, unknown: 0 }, seen = new Map(), included = [];
  for (const m of messages || []) {
    const p = m.participantId ? byId.get(m.participantId) : null;
    if (!p) { excluded.unknown += 1; continue; }                                  // an author Meet cannot identify has no recorded consent
    const ok = agreedToAll(p) && !!consent.requested;
    if (!seen.has(p.participantId)) { seen.set(p.participantId, { participant_id: p.participantId, transcription: decisionOf(p, 'transcription'), summary: decisionOf(p, 'summary'), included: ok, reason: ok ? null : (consent.requested ? why(p) : 'request_closed') }); if (!ok && consent.requested) excluded[why(p)] += 1; }
    if (ok) included.push(m);
  }
  return { requested: !!consent?.requested, included, excluded, participants: [...seen.values()] };
}

/** Imported transcripts: allowed only while the request is open and nobody has declined or withdrawn. */
export function importAllowed(consent) {
  if (!consent?.requested) return { allowed: false, reason: 'participant_consent_required' };
  const objector = (consent.participants || []).some((p) => CORE_PURPOSES.some((k) => ['decline', 'withdraw'].includes(decisionOf(p, k))));
  return objector ? { allowed: false, reason: 'participant_declined' } : { allowed: true };
}

/** Re-check just before publishing: the request is still open and every participant whose content was used still agrees (a participant missing from Meet's answer counts as NOT agreeing). */
export function stillConsented({ consent, participantIds }) {
  if (!consent?.requested) return { ok: false, reason: 'request_closed' };
  const byId = new Map((consent.participants || []).map((p) => [p.participantId, p]));
  for (const id of participantIds) if (!agreedToAll(byId.get(id))) return { ok: false, reason: 'participant_withdrew' };
  return { ok: true };
}
