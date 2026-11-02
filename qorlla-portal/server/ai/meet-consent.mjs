// Participant-level consent for Meet AI: pure decisions over what Meet reports (its append-only ai_consents, read through the read-only integration).
// Host attestation (portal.meeting_ai_consents) is a separate, additional requirement checked elsewhere: it can never stand in for a participant's own answer.
//
//   * a message is processed only if its AUTHOR agreed to BOTH purposes (transcription and summary) and the host's AI request is open;
//   * "pending" (a late joiner who has not answered), "declined" and "withdrawn" are all excluded, and excluded content is never stored;
//   * an imported transcript cannot be split by person, so it is allowed only while nobody in the meeting has declined or withdrawn.
//   * identity is the Meet SESSION (participantId). A display name is typed text: two people called "Dana" are two people, and neither speaks for the other.
//
// THE FENCE. Meet and the portal have separate databases, so no check can be made atomic with a portal commit. Instead every Meet answer carries a monotonic number
// (seq), and every result records the number of each agreement it was built on (its "basis"). A result may be shown only while NO included person has an objection
// numbered higher than their recorded agreement. Revocation and publication therefore have one well-defined order (Meet's), the check is repeated on EVERY read, and when
// freshness cannot be established (Meet unreachable, answer unreadable) nothing is shown. See also docs: "consent fence".
export const CORE_PURPOSES = ['transcription', 'summary'];
const decisionOf = (p, k) => p?.decisions?.[k]?.decision || 'pending';
const seqOf = (p, k) => Number(p?.decisions?.[k]?.seq || 0);
const objectionOf = (p, k) => Number(p?.decisions?.[k]?.objectionSeq || 0);
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
    if (!seen.has(p.participantId)) {
      seen.set(p.participantId, { participant_id: p.participantId, transcription: decisionOf(p, 'transcription'), summary: decisionOf(p, 'summary'), included: ok, reason: ok ? null : (consent.requested ? why(p) : 'request_closed'),
        transcription_seq: ok ? seqOf(p, 'transcription') : 0, summary_seq: ok ? seqOf(p, 'summary') : 0 });
      if (!ok && consent.requested) excluded[why(p)] += 1;
    }
    if (ok) included.push(m);
  }
  return { requested: !!consent?.requested, included, excluded, participants: [...seen.values()] };
}

/** Imported transcripts: allowed only while the request is open and nobody has declined or withdrawn. `revision` is Meet's order number at that moment (the basis for later checks). */
export function importAllowed(consent) {
  if (!consent?.requested) return { allowed: false, reason: 'participant_consent_required' };
  const objector = (consent.participants || []).some((p) => CORE_PURPOSES.some((k) => ['decline', 'withdraw'].includes(decisionOf(p, k))));
  return objector ? { allowed: false, reason: 'participant_declined' } : { allowed: true, revision: Number(consent.revision || 0) };
}

/**
 * Is a result still covered by the consent it was built on?  basis:
 *   chat   { source: 'meet_chat', participants: [{ id, t, s }] }   t / s = the seq of that person's agreement to each purpose when their messages were taken
 *   import { source: 'transcript_import', revision }               nobody had objected at that revision
 * Violated when any included person has an objection NUMBERED AFTER their recorded agreement (even if they have since agreed again: the content was processed before that), or is
 * no longer reported by Meet at all. A missing / unreadable basis is never "fresh".
 */
export function checkFresh({ basis, consent }) {
  if (!basis || !consent || !Array.isArray(consent.participants)) return { ok: false, reason: 'unverifiable' };
  const byId = new Map(consent.participants.map((p) => [p.participantId, p]));
  if (basis.source === 'transcript_import') {
    for (const p of consent.participants) for (const k of CORE_PURPOSES) if (objectionOf(p, k) > Number(basis.revision || 0)) return { ok: false, reason: 'participant_withdrew' };
    return { ok: true };
  }
  if (!Array.isArray(basis.participants) || !basis.participants.length) return { ok: false, reason: 'unverifiable' };
  for (const b of basis.participants) {
    const p = byId.get(b.id); if (!p) return { ok: false, reason: 'participant_withdrew' };
    for (const [k, agreed] of [['transcription', Number(b.t)], ['summary', Number(b.s)]]) if (!(agreed > 0) || objectionOf(p, k) > agreed) return { ok: false, reason: 'participant_withdrew' };
  }
  return { ok: true };
}

/** In-flight job: the host's request is still open AND every included person is still covered. `rows` are the job's snapshot rows (participant_id, transcription_seq, summary_seq). */
export function stillConsented({ consent, rows, importRevision }) {
  if (!consent?.requested) return { ok: false, reason: 'request_closed' };
  return checkFresh({ consent, basis: rows ? { source: 'meet_chat', participants: rows.map((r) => ({ id: r.participant_id, t: r.transcription_seq, s: r.summary_seq })) } : { source: 'transcript_import', revision: importRevision } });
}

/** What is stored with a published result, so every later read can be checked against it. */
export const basisFor = ({ source, rows, revision }) => (source === 'transcript_import' ? { v: 1, source, revision: Number(revision || 0) }
  : { v: 1, source: 'meet_chat', revision: Number(revision || 0), participants: rows.map((r) => ({ id: r.participant_id, t: Number(r.transcription_seq), s: Number(r.summary_seq) })) });
