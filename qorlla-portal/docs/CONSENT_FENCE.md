# The Meet AI consent fence

**Status:** implemented and tested on the isolated stacks. **Not independently certified.** All 15 release gates remain BLOCKED.

## The problem

Participant consent for Qorlla AI lives in **Meet's database**. Reports are published in the **portal's database**. They share no transaction, so "check consent, then commit" always leaves a gap in which a person can withdraw. A second API call just before the commit makes the gap smaller; it cannot make it zero.

## The protocol

Instead of trying to make the two systems atomic, give them **one agreed order** and make every read obey it.

1. **Meet numbers every decision.** Each answer in `ai_consents` and each open/close of the host's request takes the next value of one sequence (`ai_consent_seq`, migration `v4_20`). Rows stay append-only.
2. **Meet reports, per person and purpose:** the latest decision, its number (`seq`), and the number of that person's most recent objection (`objectionSeq`, the highest `seq` among their `decline`/`withdraw` rows), plus a meeting-level `revision`. Identity is the Meet session (`participantId`). The typed display name is never used for a decision and is dropped by the portal client.
3. **A report records its basis** (`meeting_reports.consent_basis`): for every person whose words were used, the `seq` of the agreement that admitted them (or, for an import, Meet's `revision` at that moment).
4. **A report may be shown only while no included person has an `objectionSeq` greater than their recorded agreement.** Agreeing again later does not help: the content was processed before that person changed their mind, so a *new* report is needed. A person missing from Meet's answer counts as not covered. A missing or unreadable basis is never fresh.
5. **Every read asks Meet again, uncached.** That covers the report, its transcript, exports, the report list's excerpt, "my action items", bearer share links and every citation. If Meet cannot be asked, or its answer is unreadable, **nothing is shown** (HTTP 503 `consent_unverifiable`; bearer links answer 404 like any invalid link).
6. **A violation is persisted, irreversibly.** The report is withdrawn (summary, decisions, topics, citations and transcript text removed; action items deleted; share links revoked) in one transaction under the workspace lock. The audit trail gets a **new** row (`report_withdrawn`); no existing row is changed (the table is append-only by trigger).
7. **Publication is bracketed by checks, not made atomic.** Before the model is called, and again inside the publishing transaction, the worker checks the same rule. Straight after the commit it checks once more and withdraws at once if the answer changed in the gap. If that last check cannot be made, the report is committed but every read refuses it (rule 5) and the first read after Meet answers withdraws it.

## Why this is well-defined

Meet's sequence is the only clock. A read is authorised iff Meet's answer, at the moment it is given, shows no objection numbered after the recorded agreement. A withdrawal that Meet records before a read's answer is therefore always honoured by that read; a read answered earlier legitimately came first. No read that *starts after* a withdrawal was recorded can return content (tested with 50 racing readers).

The remaining windows are therefore not "unauthorised publication" but "a read that was answered just before the withdrawal was recorded", which is ordinary ordering, and "an outage", which refuses.

## Other revocation paths (unchanged, still enforced)

* **Host attestation in Workplace** (`meeting_ai_consents`): revoking it withdraws the meeting's reports, purges transcripts, revokes shares and cancels jobs in one transaction. A job checks it inside its own fenced transaction.
* **Host closing the AI request in Meet** stops jobs in flight; published reports rest on participants' own records, not on the request being open.
* **Retention:** transcript text past the retention period, or purged, cannot be cited even before the sweeper has run.

## Lock order (deadlock freedom)

Workspace row, then job row, then transcript / report rows, everywhere (host revocation, the AI worker's fenced writes, job cancellation, consent withdrawal). A deadlock between a host revocation and a running job, found by the revocation-race test, was fixed by this ordering.

## Honest limitations

* An answer read *just before* a withdrawal is recorded can still be returned to that one reader (ordering, as above).
* Withdrawal hides the **whole** report, not just one person's contribution: the summary cannot be un-mixed.
* A participant in Meet is a browser session, not a verified account; two sessions may carry the same typed name, and each answers for itself only.
* Reports created before migration 010 have no basis and are never shown (AI was never enabled in production, so none exist).
* Meet and the portal must both be up for a report to be readable.
* Not independently reviewed. Live providers, Aria, and the LG device remain BLOCKED as before.

## Where it is tested

`tests/consent-fence.test.mjs` (14 tests: concurrent revocation incl. 50 racing readers, revocation in the commit gap with and without an outage, failed COMMIT, worker retry, cancellation of a running job, imports, typed names), `tests/meet-ai-consent.test.mjs`, `e2e/scheduled-meeting-ai.spec.js` (real scheduler, Meet, portal UI, worker, databases, crash recovery), `e2e/meet-ai-consent.spec.js` (real Meet export read by the portal's own client).
