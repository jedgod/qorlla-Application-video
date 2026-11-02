// Participant-level consent for Meet AI: pure decisions over what Meet reports (its append-only ai_consents, read through the read-only integration).
// Host attestation (portal.meeting_ai_consents) is a separate, additional requirement checked elsewhere: it can never stand in for a participant's own answer.
//
//   * a message is processed only if its AUTHOR agreed to BOTH purposes (transcription and summary) and the host's AI request is open;
//   * "pending" (a late joiner who has not answered), "declined" and "withdrawn" are all excluded, and excluded content is never stored;
//   * an imported transcript cannot be split by person, so it is allowed only while EVERY person Meet reports for the meeting has agreed to both purposes (an empty or partly pending room is refused);
//   * identity is the Meet SESSION (participantId). A display name is typed text: two people called "Dana" are two people, and neither speaks for the other.
//
// THE FENCE. Meet and the portal have separate databases, so no check can be made atomic with a portal commit. Instead every Meet answer carries a monotonic number (seq), and every result records the number of each
// agreement it was built on (its "basis"). A result may be shown only while NO included person has an objection numbered higher than their recorded agreement. The check is repeated on every read; when
// freshness cannot be established (Meet unreachable, answer unreadable or going backwards) nothing is shown. What it cannot do: retract a response already authorised before the objection was recorded.
export const CORE_PURPOSES = ['transcription', 'summary'];
const decisionOf = (p, k) => p?.decisions?.[k]?.decision || 'pending';
const seqOf = (p, k) => Number(p?.decisions?.[k]?.seq || 0);
const objectionOf = (p, k) => Number(p?.decisions?.[k]?.objectionSeq || 0);
const isObjection = (p, k) => ['decline', 'withdraw'].includes(decisionOf(p, k));
export const agreedToAll = (p) => !!p && CORE_PURPOSES.every((k) => decisionOf(p, k) === 'agree' && seqOf(p, k) > 0);
const why = (p) => (CORE_PURPOSES.some((k) => decisionOf(p, k) === 'withdraw') ? 'withdrawn' : CORE_PURPOSES.some((k) => decisionOf(p, k) === 'decline') ? 'declined' : 'pending');
const rowOf = (p) => ({ participant_id: p.participantId, transcription_seq: seqOf(p, 'transcription'), summary_seq: seqOf(p, 'summary') });

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

/**
 * Imported transcripts: the text cannot be attributed to people, so EVERY person Meet reports for the meeting must have agreed to both purposes, and there must be at least one.
 * `rows` is the snapshot (each person's agreement numbers) that later checks compare against.
 */
export function importAllowed(consent) {
  if (!consent?.requested) return { allowed: false, reason: 'participant_consent_required' };
  const people = consent.participants || [];
  if (!people.length) return { allowed: false, reason: 'participant_consent_required' };
  if (people.some((p) => CORE_PURPOSES.some((k) => isObjection(p, k)))) return { allowed: false, reason: 'participant_declined' };
  if (!people.every(agreedToAll)) return { allowed: false, reason: 'participant_consent_required' };        // someone has not answered (pending): not consent
  return { allowed: true, revision: Number(consent.revision || 0), rows: people.map(rowOf) };
}

const objected = (p, agreedT, agreedS) => [['transcription', agreedT], ['summary', agreedS]].some(([k, agreed]) => objectionOf(p, k) > agreed || (isObjection(p, k) && seqOf(p, k) > agreed));

/**
 * Is a result still covered by the consent it was built on?  basis = { source, participants: [{ id, t, s }] }: the seq of each person's agreement to each purpose when their words were taken.
 * Violated when any person it rests on has an objection NUMBERED AFTER their recorded agreement (even if they have agreed again since: the content was processed before they changed their mind), or is no longer
 * reported by Meet. For an IMPORT (unattributable text) it is also violated by an objection from ANYONE now in the meeting, including someone who joined after the snapshot. Missing or unreadable bases are never fresh.
 */
export function checkFresh({ basis, consent }) {
  if (!basis || !consent || !Array.isArray(consent.participants) || !Array.isArray(basis.participants) || !basis.participants.length) return { ok: false, reason: 'unverifiable' };
  const byId = new Map(consent.participants.map((p) => [p.participantId, p])), known = new Set(basis.participants.map((b) => b.id));
  for (const b of basis.participants) {
    const t = Number(b.t), s = Number(b.s); if (!(t > 0) || !(s > 0)) return { ok: false, reason: 'unverifiable' };
    const p = byId.get(b.id); if (!p || objected(p, t, s)) return { ok: false, reason: 'participant_withdrew' };
  }
  if (basis.source === 'transcript_import') for (const p of consent.participants) if (!known.has(p.participantId) && objected(p, 0, 0)) return { ok: false, reason: 'participant_withdrew' };
  return { ok: true };
}

/** In-flight job: the host's request is still open AND every included person is still covered. `rows` are the job's snapshot rows (participant_id, transcription_seq, summary_seq). */
export function stillConsented({ consent, rows, source = 'meet_chat' }) {
  if (!consent?.requested) return { ok: false, reason: 'request_closed' };
  return checkFresh({ consent, basis: { source, participants: (rows || []).map((r) => ({ id: r.participant_id, t: r.transcription_seq, s: r.summary_seq })) } });
}

/** What is stored with a published result, so every later read can be checked against it. */
export const basisFor = ({ source, rows, revision }) => ({ v: 2, source: source === 'transcript_import' ? 'transcript_import' : 'meet_chat', revision: Number(revision || 0), participants: (rows || []).map((r) => ({ id: r.participant_id, t: Number(r.transcription_seq), s: Number(r.summary_seq) })) });
