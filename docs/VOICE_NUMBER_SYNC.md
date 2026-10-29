# One number authority: Numbers & Plans -> outbox -> voice engine projection (A1 + A2)

**Status: implemented and tested on real PostgreSQL against the real Numbers & Plans service and the real engine over HTTP. `VOICE_NUMBERS_ENABLED` stays false; no public number provisioning or PSTN calling is enabled; the carrier is a stand-in in tests (the Twilio adapter has still never run against real Twilio). Branch `feature/number-authority-sync`. Not merged into RC2 or main. Release BLOCKED.**

## Authority model
| Concern | Owner |
|---|---|
| Purchase, release, provider lifecycle, billing | **Numbers & Plans** (`qorlla-meet-video/server/telephony`, tables `qphone_*`) only |
| Account-to-number assignment, usability, caller-ID ownership as seen by calling | Voice engine **projection** (`voice_number_projection`), written only from authority events |
| Identity verification, suspension, tenant, fraud checks | Security Shield (`shield_*`) |
The engine has no purchase, release or activation code on this branch. (The separate `wip/voice-numbers` experiment contained a provider worker; **it must not be merged as it stands**; its audit/strictness ideas were carried over, its authority was not.)
A number is usable only when the projection says `active`, `personal`, not held, not conflicting, not stale **and** the shield says the account is known, verified, unsuspended, in a non-suspended organization, and (for PSTN) the destination/spend/concurrency checks pass.

## A1: Authority migration (`qorlla-meet-video/sql/v4_16_number_authority.sql`, non-destructive, idempotent)
- `qphone_numbers.authority_version` (bumped by a trigger on any change of state, owner, caller-ID flag or hold), `state_before_release`, `hold_reason` (non-null = carrier outcome uncertain).
- Identity is immutable (`provider_number_id`, `e164`, `kind`, `country`); a `released` number is final; owner cannot change while releasing / held; a shared **dial-in** number can never be assigned to a person.
- `qphone_number_outbox`: one row per change, written by trigger **in the same transaction**; `(provider_number_id, version)` unique; existing numbers get a snapshot event. Rows are never deleted by the application role.
- `qphone_provider_operations`: a durable record of every carrier call that changes something, written **before** the call.
- `qphone_accounts`: account standing as reported by the main app (`PUT /api/integrations/telephony/accounts/:id`); missing row = refused.
- Uniqueness: one live personal number per account (`qphone_one_live_personal`). **Existing duplicates are listed in `qphone_assignment_conflicts` and nothing is deleted or rewritten; the index is created only when none remain** (re-run the migration after an operator resolves them).
- `qphone_audit` is append-only for every role (UPDATE, DELETE and TRUNCATE refused); `005_app_role.sql` additionally revokes UPDATE/DELETE/TRUNCATE on it, and DELETE/TRUNCATE on numbers, operations, outbox, accounts and conflicts, from the application role (and `PUBLIC` from the audit table).

## Operating rules implemented in the service
- **Release** = (1) one transaction: number -> `releasing`, operation `in_flight`; (2) the carrier call; (3) record what is *known*. A definitive refusal (4xx other than 404/408) reverts at once. **404 = the carrier says it is gone = confirmed. Anything else (timeout, unreachable, 5xx, malformed answer, 408) leaves the operation `uncertain`, sets `hold_reason`, blocks reassignment, re-release and reuse** (service and database), until `reconcileOperations()` asks the carrier (`numberExists`): gone -> `released`; still owned -> reverted. If the carrier cannot be asked, nothing changes. An operation left `in_flight` by a crashed process is treated the same once stale.
- **Provisioning** records an operation before buying; an uncertain purchase is reconciled with `findOwnedByE164` (found -> recorded, assigned only if still safe, otherwise recorded unassigned with `assignment_conflict_needs_review`; not found -> closed). A second purchase for the same account is refused while one is unresolved.
- **Reassignment** requires an administrator, a 3-200 character reason, an existing **verified, unsuspended** target (from `qphone_accounts`), a personal number that is `active`/`suspended` and not held, and a target with no other live number; it resets the caller-ID verification, writes an audit row in the same transaction, and emits a new version.
- **Caller-ID verification** only for an active, assigned personal number whose owner is verified and unsuspended.
- **Outbox delivery**: at least once, one dispatcher at a time (advisory lock), strictly in version order per number (a failed version blocks later ones for that number), exponential backoff (2s..300s). Dispatcher also reconciles operations every minute and sends a **full snapshot** every five minutes.

## A2: Engine projection (`sql/012_number_projection.sql`, `src/number-sync.mjs`)
- Routes (workload identity, scope `numbers.sync`): `POST /v1/shield/numbers/events`, `.../reconcile`, `.../status`. User route `GET /v1/voice/numbers/me` (shows the number only when usable and the account is verified).
- Event handling: validated envelope/payload (a payload cannot describe another number or version), **dedupe by event id**, **stale** (version <= current) ignored, **gap** (version > current + 1, non-snapshot) refused with 409 and recorded in `voice_number_gaps` (healed when the missing version or a snapshot arrives), dial-in numbers never assignable, a second live personal number for an account or a live number under two ids is stored/recorded as **conflict** and is never usable.
- Reconciliation: a full snapshot applies newer versions, never moves the projection backwards, marks projection rows the authority no longer lists `stale` (unusable), and reports disagreement at the same version (and a projection *ahead* of the authority) instead of silently overwriting.
- Shield integration: PSTN caller ID must be a projection row that is a verified, active, personal, unheld, non-conflicting number owned by that account (replaces the shield-side caller-ID table, which is now unused and kept only for non-destructive history).

## Verified (test/numbers-sync.pg.test.mjs, 9 tests; plus the 8 shield tests, which now take caller IDs from the projection)
Migration on a database with existing duplicates (non-destructive, idempotent, snapshot events, uniqueness deferred then enforced); synchronization end to end with real signed workload credentials; unauthenticated / wrong-scope / forged / mismatched events; duplicate, stale and gap events; outbox ordering, retry and backoff; duplicate ownership (service and database); unauthorized, ineligible and dial-in reassignment; release with timeout-after-effect, timeout-without-effect, definitive refusal, 5xx, 404, and crash (in-flight) recovery; uncertain provisioning recorded or closed; caller-ID spoofing (unowned, someone else's, never verified, dial-in, held, conflicting); unverified and suspended accounts; emergency suspension during an active PSTN call (gateway told to terminate, outcome recorded); cross-organization isolation; snapshot reconciliation; audit immutability and effective privileges of the application role.

## NOT done (release stays BLOCKED)
- **The Twilio adapter has not run against real Twilio** (provisioning, release, `numberExists`, `findOwnedByE164`); the carrier in tests is a stand-in. Reconciliation correctness against Twilio's real error behaviour is unproven.
- The main app does not yet call `PUT .../accounts/:id` or register principals with the shield; no workload signing key/issuer is deployed (`PHONE_ENGINE_SYNC_*`); transport is application-layer workload JWT, not mTLS/SPIFFE.
- Account suspension does not automatically suspend the account's numbers in Numbers & Plans (the engine denies the account regardless).
- Billing holds are not linked to number state. No production data migration has been rehearsed; the migration was exercised on synthetic data only.
- Phase C (voice.js, Phone page, gateways) and a real carrier/PSTN path are not started. `VOICE_NUMBERS_ENABLED=false`; PSTN stays off.
- The earlier `wip/voice-numbers` module and its 9 tests are untouched on their own branch.
