# Consent-fence security review

**Scope:** the Meet-to-portal consent protocol described in `CONSENT_FENCE.md`, at baseline commit `566e088`.
**Reviewer:** an independent AI reviewer (a separate agent, read-only, working from the code; it ran snippets against the pure consent logic but not the database tests). This is **not** a human or third-party audit and does not certify anything. All 15 release gates remain BLOCKED.
**Method of this document:** each finding was checked against the code by the author before it was fixed; "RAN" in the reviewer's notes means it executed a snippet against the real `meet-consent.mjs`.

## What the protocol can and cannot promise

The portal checks every read against **Meet's recorded state**. It cannot retroactively stop a response that was authorised immediately before a withdrawal was recorded, and it cannot recall content that was already delivered (screen, download, export, cache, or text already sent to an AI provider). It is **not** an instantaneous revocation of delivered content, and no text in the product or documentation may say so.

## Findings

| # | Severity | Finding | Status | Where fixed |
|---|---|---|---|---|
| C1 | Critical | `GET /api/v1/reports` (legacy v4.1) returned every report's summary to any workspace member with no fence, no visibility check and no status check | **Fixed.** Route now answers 410 (still requires login); new test | portal `a8aed46` |
| H1 | High | Imports ignored pending and unknown participants; an empty participant list was accepted | **Fixed.** An import needs an open request, nobody objecting, and **every** listed person agreed to both purposes; their numbers are stored as the basis (`v2`); no participants = refused | `a8aed46` |
| H2 | High | No high-water mark: a Meet restore, stale replica or replayed answer could hide a withdrawal | **Fixed in the portal** (`meet_consent_watermark`, migration 011): an answer below the highest revision seen is refused. **Open:** Meet carries no instance/epoch id yet, so a restore that happens to be *ahead* of the mark is not detectable | `a8aed46` |
| M1 | Medium | A missing or malformed `objectionSeq` failed open (read as 0) | **Fixed.** Every number must be a non-negative integer or the answer is unreadable (fail closed); tests | `a8aed46` |
| M2 | Medium | Sequence numbers are taken at insert time, not commit time: (a) one person's concurrent withdraw and agree could lose the withdrawal; (b) an import's decisions and revision came from separate statements | **Fixed on the Meet side.** All consent writes run in one transaction under a per-meeting advisory lock; the export is one repeatable-read snapshot. Real-PostgreSQL test shows ordered commits with the lock and out-of-order commits without it | Meet commit (this milestone) |
| M3 | Medium | A participant's right to withdraw is bound to the browser session (8 h token, new identity on rejoin) | **Not fixed. Documented** (notice text, `CONSENT_FENCE.md`). A fix needs a design decision (per-person receipt link or host-mediated exclusion) | — |
| M4 | Medium | Text of jobs that never published (failed, blocked, cancelled) was kept for the whole retention period; cancel purged in a second, non-transactional statement | **Fixed.** Such text is purged after 24 h regardless of retention; cancel is one transaction | `a8aed46` |
| L1 | Low | Meet HTTP call made while holding database locks | **Fixed.** The publish-time participant check now runs before the transaction | `a8aed46` |
| L2 | Low | Lease takeover had no attempt cap (a poison job re-sent consented text forever) | **Fixed.** A job interrupted `maxAttempts` times is failed | `a8aed46` |
| L3 | Low | Report list fanned out up to 100 parallel Meet fetches | **Fixed.** At most 10 at a time | this milestone |
| L4 | Low | Audit and authorisation boundaries: host attestation row could be edited or un-revoked by the application role; `qorlla.allow_purge` is a free GUC; TRUNCATE not covered by audit triggers; rollback scripts delete audit rows | **Partly fixed.** Attestation rows are now revoke-once and never edited or deleted (trigger, migration 011). **Open:** the other three (owner-role-only or operator-run paths) | `a8aed46` |
| L5 | Low | Citation tokens embedded a plain SHA-256 of transcript text (guessable for short withdrawn messages) | **Fixed.** Keyed HMAC | `a8aed46` |
| I1 | Info | Consent is not scoped to the time of a message (messages sent before an agreement are processed after it) | **Open, documented as a design property.** Needs a product decision | — |
| I2 | Info | Re-opening the AI request re-agreed for the host even after they withdrew | **Fixed.** The host's request counts as their agreement only for a purpose they have not answered | Meet commit |
| I3 | Info | The Meet read secret exposes every meeting's chat; filtering happens in the portal | **Open.** A per-meeting scope is a larger change | — |
| I4 | Info | Duplicate-job path returned other users' job views | **Fixed** for the idempotency path (same-workspace managers or the requester only). The retry route was not changed | `a8aed46` |

## Overclaims removed

* `CONSENT_FENCE.md` now states what the protocol does **not** do (no retraction of delivered content) and lists the hardening above; the "every read is fenced" claim is true only after C1 and is now backed by the 410 and a test.
* UI string "Share revoked. Access ended immediately." and the code comment "revocation is immediate" replaced.
* The Meet answer note no longer says processing happens "only while the host has an AI request open"; the Meet notice now says messages are sent to the AI service, that a later change withdraws the whole summary from view, that copies already seen cannot be taken back, and that answers can only be changed from the same browser session. The notice version was bumped to `qorlla-ai-consent-2026-11-b`.

## Tests added

* Portal `tests/consent-review.test.mjs` (6): strict Meet answers, retired list (410 and 401), watermark regression and monotonic mark, attestation guard trigger, failed-job text purge, lease takeover cap.
* Existing tests updated for the stricter rules (imports now need participants who agreed; the fake Meet's revision is monotonic like the real one). No assertion was relaxed to make a test pass; changes were to setup that did not satisfy the new, stricter precondition.
* Meet `tests/consent-lock.test.mjs` (3, real PostgreSQL): commit order equals number order under the lock; control shows the unlocked workload commits out of order; lock is per meeting and released on error.

## Known weak points that remain

* The fake Meet cannot reproduce a database restore or a sequence reset except by the unit test of the watermark; there is no end-to-end restore test.
* The browser specs `e2e/meeting-ai.spec.js` (2 tests) predate the consent requirement (they never open an AI request or have participants answer) and **fail** against the current rules; they are superseded by `scheduled-meeting.spec.js` and `meet-ai-consent.spec.js` and have not been rewritten.
* Nothing here has been reviewed by a human security engineer.
