# Telephone bridge: Meet, Shield and Portal (provider-neutral architecture and open decisions)

**Status: Proposed — Not Approved. Release status: NO-GO for the Portal bridge and for any carrier.**

Decisions D1-D9 in section 10 are proposals. They stay open until the Qorlla owners (architecture, security, billing, operations) approve them. Nothing in this document is implemented as a service, deployed, certified or authorized for implementation. It records what exists, what is missing, and the decisions the owners must make before a production receiver is built. Public numbers, PSTN and every carrier-dependent feature stay disabled (`VOICE_NUMBERS_ENABLED=false`, `VOICE_PSTN_ENABLED=false`) until a carrier is selected and certified. Internal extension calls keep their existing tested scope.

Sections marked **Proposed** are recommendations, not decisions.

## 1. What exists today (verified in code, not deployed)

| Piece | Where | State |
|---|---|---|
| Immutable call-lifecycle outbox, one row per transition, per-call `lifecycle_version` | Meet `sql/v4_26`, `v4_28` | Built; not applied anywhere |
| Delivery metadata: leases, fencing token, retry with jitter, dead letter, per-call ordering, delivery timeout, operator requeue, blocked-stream report | Meet `sql/v4_27`, `server/telephony/phone-event-delivery.mjs` | Built and tested (injected receiver); not started by any service |
| Accounting references, ratings, carrier-record reconciliation, accounting outbox, simulated billing | Portal `sql/012`-`014`, `a49`/`a410`/`a411` | Built; not mounted; simulation only |
| Meeting-to-workspace bindings (bind, suspend, resume, revoke; audit; idempotent requests) | Portal `sql/015`, `a412-workspace-bindings.mjs` | Built; not mounted; its two authorizers are injected and unimplemented |
| Shield as the only enforcer of host/org suspension for phone calls; suspension is meeting-wide | Meet `shield-client`, `phone.mjs`; Shield migration 019 | Built; lab-verified; migration 019 not rolled out |
| Verification peer and gateway admission, with Shield fail-closed | Meet `phone.mjs`, gateway | Built; lab-verified; no carrier |

The event Meet can deliver contains only: `event_id`, `call_id`, `meeting_id`, `lifecycle_version`, `from_state`, `event_type` (the new state), `occurred_at`. It carries **no caller number, no PIN, no media or credential data**. Keep it that way.

## 2. Authority model (who decides what)

One owner per fact. A second owner for any row below is a defect.

| Fact | Sole authority | Others |
|---|---|---|
| Call state, admission, media connected | **Meet** | Portal and gateway never infer or set it |
| Meeting suspension and who may be admitted | **Shield**, enforced by Meet | Portal supplies workspace suspension as an input to Shield (section 6); it never ends calls itself |
| Which workspace owns a meeting | **Portal binding** (`a412`), provisioned by an authenticated, authorized principal | Never taken from event or caller data |
| Money: rating, reconciliation, ledger | **Portal** | Meet exports facts only |
| Media and SIP legs | **Gateway** | Reports evidence to Meet; Meet decides |

## 3. Event contract (Meet to Portal)

Existing semantics, to be kept:

- **At least once, ordered per call.** Version `n+1` is leased only after version `n` is delivered. Different calls are independent.
- **Receiver must deduplicate by `event_id`** and acknowledge `{ eventId, result: "accepted" | "duplicate" }` only after its own commit.
- **Failure is not silence:** exhausted events dead-letter and block that call's later events until an operator requeues them.

Proposed additions:

1. **Versioned envelope** (`schema: "phone.lifecycle.v1"`) so the contract can evolve without a flag day.
2. **Receiver rates a call's events only in order: `lifecycle_version = last_applied + 1`** (or version 1 for a new call). A later version is **durably stored as held, acknowledged, and not rated**; it is never discarded and never silently skipped. This turns a gap into a visible, bounded stall of that one call's financial effect instead of a silent accounting error. See section 3.1 for how a gap is resolved: a call must not stay blocked forever because one event is delayed or quarantined.

### 3.1 Recovery procedure for missing, delayed or quarantined events

1. **Delayed event.** The held events wait for a configured window (decision D1 sets it). Meet's delivery retries keep running; the window ends the moment the missing version arrives and rating resumes in order.
2. **Missing event after the window.** The receiver raises an alert naming the call and the missing version, and requests a redelivery from Meet. The Meet outbox is immutable, so the original event can always be resent byte for byte.
3. **Event that cannot be produced or is quarantined** (for example a pre-migration call, or a dead letter the operators decide not to send): two authorized people record a **gap resolution** with a reason. The call is then rated from Meet's authoritative terminal state and its verified duration, the gap is marked on the call and in the audit trail, and the held events are released. Nothing is skipped without that record.
4. **No permanent block.** A call is never left blocked indefinitely: every held stream has an owner, an alert and an escalation deadline, and the only exits are redelivery or an audited gap resolution.
5. **Idempotency applies throughout.** Redelivery, requeue and gap resolution can never create a second financial effect for the same `event_id` or the same call.
3. **Streams that start after version 1** (calls in progress when the migrations were applied) are **never exported**. They are listed by `blockedStreams()` and handled by an operator decision per call. No synthetic backfill.
4. **Payload stays minimal.** Adding any new field needs a data-classification review first.

## 4. Receiver requirements (Portal)

A new, separately deployed endpoint; not part of the user-facing Portal session surface.

- **Authentication:** mutual TLS plus a workload JWT scoped to `phone.events.write`, issuer and audience pinned. User sessions, CSRF and workspace-membership auth do not apply here and must not be reused.
- **Authorization:** the sender identity must be the Meet exporter identity. The receiver resolves `meeting_id` to a workspace **only through the binding table**; no binding, a suspended binding or a revoked binding means the event is stored but **not rated** and an alert is raised.
- **Idempotency:** insert-by-`event_id` and the ordering check in one transaction; acknowledge after commit. A replay with a different payload for the same `event_id` is a hard error and an alert.
- **Audit:** one row per accepted, duplicate or refused event, with sender identity, never with payload secrets.
- **Limits:** body size cap, per-sender rate limit, bounded batch size.
- **Least privilege:** a dedicated database role that can append to the event store and read bindings, and nothing else. The default broad Portal grants must not apply.

## 5. Gateway-session authority

Problem: the A5 verification-peer credential is short-lived, single-use and can be superseded, so it is **not** a session. Nothing currently defines a durable session that Portal could attribute media or cost to.

**Proposed:** the Meet call row is the session. Define the session as `(call_id, epoch)`, where the epoch increments when the gateway re-establishes media (ICE restart or gateway restart).

- Meet creates the session at admission and is the only writer of state; the gateway presents `call_id` and its current epoch on every report; Meet fences stale epochs (the A5.1 lease and fencing work already provides the mechanism).
- Portal records the session only as `call_id`. It never accepts a gateway-supplied session identifier.
- Session end is the Meet terminal state. Orphaned sessions (gateway gone) follow the existing reaper and `ORPHANED` rules.

The epoch exists for fencing only. **Billing identity is the stable logical call identity (`call_id`) across gateway restarts**: a gateway restart or ICE restart never creates a second billable session. This is the owner position for D4 and is still pending approval.

## 6. Workspace suspension and revocation

Facts from the code: Portal's workspace table has **no suspension state**, and there is **no authoritative mapping from Shield organizations to Portal workspaces**. Neither may be assumed.

**Proposed flow:**

1. Portal gains an authoritative workspace suspension record (who, when, why, reason code), changed only through an audited admin path.
2. Portal publishes the change to Shield for the mapped organization using a Shield workload identity. Shield's existing meeting-wide suspension policy then applies and Meet terminates calls through its existing sweep and signalling guard (about 1 s in the lab).
3. Portal does **not** call Meet to hang up calls. Meet remains the only enforcer, so there is one revocation path to test and audit.
4. The binding module's `suspend` and `revoke` actions become the Portal-side record that rating stops; they do not replace Shield enforcement.

This depends on the workspace-to-Shield-organization mapping (Decision D5).

## 7. mTLS and workload identity

Identities (one certificate and one JWT key per workload, never shared): `meet-exporter`, `portal-receiver`, `gateway`, `shield`.

**Proposed:**

- Internal CA (or the platform's existing workload-identity service); leaf lifetime 24 hours to 30 days, automated renewal at two-thirds of lifetime.
- Revocation by short lifetime plus an explicit deny list checked at the receiver; CRL/OCSP only if the platform already runs it.
- Certificates carry the workload name in a SAN; the receiver authorizes by that name, not by the CA alone.
- Keys never on shared disks; rotation does not require a restart.

Failure scenarios that must be tested before acceptance: expired certificate, not-yet-valid certificate, wrong CA, correct CA with the wrong workload name, revoked identity, certificate rotation under load (no dropped or duplicated event), receiver restarted mid-batch, clock skew between sender and receiver, TLS downgrade attempt.

## 8. Failure and recovery behaviour (target)

| Situation | Required behaviour |
|---|---|
| Receiver down or slow | Delivery times out before the lease expires; retry with backoff; no event lost; alert on oldest-pending age |
| Duplicate delivery | `duplicate` acknowledgement; no second rating or journal entry |
| Out-of-order or gap | Retryable refusal; stream stalls visibly; `blockedStreams()` lists it |
| Dead letter | Alert; an authorized operator uses the controlled requeue path described in section 8.1. **Today `requeueDeadLetter()` is an unaudited database write, so it must not be used in production until section 8.1 is met.** |
| Meet or Portal database restart | Leases expire, work resumes; no gap in `lifecycle_version` |
| Certificate failure | Fail closed (no unauthenticated fallback); calls are unaffected; accounting queues |
| Binding missing or suspended | Event stored, not rated, alert raised |

Calls must never depend on accounting health: a bridge outage delays accounting, it does not end or block calls.

### 8.1 Production acceptance requirement: dead-letter requeue

The unaudited `requeueDeadLetter()` is a security and financial-integrity concern. Before any production use:

> Every dead-letter requeue must record the authorized actor, the reason, the event identifier, the original delivery state, the timestamp, and the resulting state transition. Requeue must not bypass idempotency or create duplicate financial effects.

Concretely: the requeue is performed only through an authenticated, role-checked path (not a direct database write by an operator); the audit record is written in the same transaction as the state change; a requeue of an event that was in fact already applied by the receiver resolves to a `duplicate` acknowledgement and no second effect; and requeue attempts that are refused are audited too.

## 9. Acceptance evidence required (maps to the agreed order)

1. Contract frozen and reviewed (this document, decisions D1-D9 answered), including the dead-letter requeue audit requirement (8.1) and the missing-event recovery procedure (3.1), each with a test that proves no duplicate financial effect.
2. Authenticated ingestion and session authority: receiver tests for every refusal in section 4; session fencing test with a stale epoch.
3. Suspension: workspace suspension to call termination in the lab with the real Shield, including the case where Portal is unavailable.
4. mTLS: the failure matrix in section 7, all cases.
5. End to end: delivery, retry, duplicate, restart and recovery on disposable infrastructure, repeated runs, with load recorded (the lab host is oversubscribed; results must state it).
6. Only then: any billing effect, still simulation-only until a tariff, tax and ledger design is approved.

## 10. Decisions needed

The middle column is the owner position put forward for review. **Every decision below is OPEN until the named owners approve it in this review; none authorizes implementation.**

| # | Decision | Owner position (proposed) | Review needed from | Status |
|---|---|---|---|---|
| D1 | Event contract | Versioned envelope, per-call ordering, idempotent acknowledgements; held-not-rated handling and the recovery procedure in 3.1 (window length to be set) | Architecture, billing | **Open** |
| D2 | Pre-migration calls | Never export retrospectively; a gap resolution (3.1) is the only way such a call is ever rated | Billing, operations | **Open** |
| D3 | Receiver | Separately deployed, authenticated service with its own least-privilege database role | Architecture, security | **Open** |
| D4 | Billing session | Stable logical call identity (`call_id`) across gateway restarts; never a duplicate billable session | Billing, architecture | **Open** |
| D5 | Suspension | Portal authoritative for workspace suspension; Shield enforces policy through Meet; Shield-organization to workspace mapping still to be defined | Architecture, security | **Open** |
| D6 | mTLS | Workload-specific certificates, short lifetimes, automated rotation and revocation; issuer and lifetime to be chosen | Security, operations | **Open** |
| D7 | Retention | Set by operational recovery needs and applicable financial-record requirements; no period is proposed here and none should be chosen arbitrarily | Billing, security, legal | **Open** |
| D8 | Admin roles | Least-privilege roles with MFA and audit; dead-letter requeue is a controlled, audited path (8.1) | Security, operations | **Open** |
| D9 | Carrier | Defer selection and certification until the internal bridge is validated | Owner | **Open (deferred)** |

## 11. Explicitly out of scope here

- Carrier integration, public numbers, PSTN, billing against real money.
- The main application's and the mobile app's 11-digit validators: deferred; they live in files with unrelated uncommitted work and on a separate branch, and need an ownership agreement before an isolated worktree change.
- Anything in Qorlla Docs.
