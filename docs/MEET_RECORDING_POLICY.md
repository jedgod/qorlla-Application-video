# Qorlla Meet - recording consent and privacy rules

Status: implemented in Meet (policy version `qorlla-recording-consent-2026-10`). **Not legal advice.** Have counsel review the wording, the retention
defaults and the jurisdiction rules (all-party-consent states/countries, GDPR/UK GDPR, CCPA/CPRA, FERPA/HIPAA/employment contexts) before production use.

## Rules
1. Recording is **off by default** for every meeting. There is no silent, hidden or automatic recording.
2. The **host** must send a recording request that discloses: purpose, recipients, retention period, data controller, a privacy contact and (optionally) a privacy-policy link, and which of video/audio is wanted.
3. Every person **currently in the meeting** must see that notice and agree (tick each requested scope + "I have reviewed the notice") before recording can start. Boxes are never pre-ticked.
4. **Decline** blocks the recording. The decliner may stay or leave; attendance never depends on consenting.
5. A **late joiner** pauses a running recording; it resumes only after they answer. If they decline, it stops.
6. **Withdrawing** consent stops the recording immediately for everyone; what was already captured stays with the host's file.
7. Everyone sees a persistent status banner (requested / blocked / ready / **recording** / paused) and a REC badge on the recorder's tile.
8. After any stop or cancellation, a **new request needs new consent** from everyone. Old consent never carries over.
9. AI transcription / summaries are **not part of this version** and are never covered by recording consent. They need their own disclosure and consent when added.

## State machine (enforced on the server)
`disabled -> awaiting -> ready -> recording <-> paused -> stopped`, with `blocked` when anyone declines and `cancelled` when the host withdraws the request.
At most one live request per meeting (database unique index).

| Endpoint (also under `/api/meetings/...`) | Who | Effect |
|---|---|---|
| `GET  /api/v1/meetings/:id/recording` | member | notice + state + counts (never who declined) |
| `POST .../recording/request` | host | disclosure required; 201, or 409 if one is already live |
| `POST .../recording/consent` | member | `agree` (needs `noticeReviewed` and all requested scopes) / `decline` / `withdraw`; returns an `auditRef` |
| `POST .../recording/start` | host | only from `ready`, otherwise 409 + state; audited as refused |
| `POST .../recording/stop` | host | stop or cancel |
| `GET  .../recording/consents` | member | host: every participant's answer; others: their own |
| `GET  .../recording/audit` | host | append-only event trail |

## Roles
| Role | Request | Start/Stop | Consent | See others' answers | Audit |
|---|---|---|---|---|---|
| Host | yes | yes | yes (auto-recorded as the requester) | yes | yes |
| Guest / participant | no | no | yes | no (own only) | no |
| Co-host, presenter, webinar attendee, workspace admin | **not implemented** - Meet has only host and guest today. When added, default to no request/start rights until granted. |

## Records (PostgreSQL, `sql/v4_7_recording_consent.sql`)
`recording_sessions` (request + notice terms + status), `recording_consents` (identity/session id, meeting id, scopes, policy version, timestamp, decision, `audit_ref`) and `recording_audit`.
Consents and audit events are **append-only**: the application role can INSERT/SELECT only (see `sql/005_app_role.sql`). Details never contain media, tokens or passcodes.

## Honest limits - do not overstate
- The current recorder runs **in the host's browser** and saves a file on the host's computer. A web page cannot technically stop someone recording their own screen with another tool; the notice, the consent record and the audit trail are the protection, not a technical lock.
- Server-side recording would have to call `authorize()` from `server/recording.mjs` before capturing anything. It does not exist yet.
- Not yet built (needed before any central storage/cloud recording): encryption at rest, access-controlled downloads, automated retention/deletion, data-subject (access/erasure) requests, breach procedure, and per-region notices. Until then the host is the custodian of the file.

## Operations
Apply `sql/v4_7_recording_consent.sql` as the database owner **before** `sql/005_app_role.sql` (compose does this; `npm run dev:stack` applies it on start). Rollback: stop the new Meet, then `DROP TABLE recording_audit, recording_consents, recording_sessions;` (consent history is lost).
Tests: `tests/recording-consent.test.mjs` (state machine) and `qorlla-portal/e2e/meet-recording-consent.spec.js` (end-to-end flows; local Meet: `E2E_BASE=http://localhost:3310 E2E_MEET_PATH=/`).

## Host connection loss vs. host departure (v4.0.2)
A dropped host connection is not a departure. The recording survives an outage of up to `HOST_RECONNECT_GRACE_MS` (default 30 000 ms); `recording.host_disconnected` and `recording.host_reconnected` are written to the audit trail. It is finalized immediately only by an intentional Leave, End for all, a decline/withdrawal, or an outage that outlasts the grace period (`end_reason = host_left`). While the host's browser is offline it keeps capturing locally; participants still see the recording banner.

## Secure storage, retention and deletion (v4.0.3)
Implemented in `server/recording-store.mjs`, `recording-crypto.mjs`, `recording-objects.mjs`, `recording-audit.mjs` and `sql/v4_9_recording_storage.sql`.

**Pipeline.** The host's browser composes the picture and audio (people who have not consented to the requested scopes are drawn as "Not recorded" and their audio is not mixed in) and uploads small chunks. The server accepts a chunk only from the recorder and only while the consent session is `recording`: not while someone is unanswered (paused), not after a decline or withdrawal, and, after a host-initiated stop, only for a short window (`RECORDING_LATE_CHUNK_MS`, default 30 s). A refused chunk is dropped and audited, never kept. Sequence numbers advance only when a chunk is stored, so interrupted uploads are retried without gaps or duplicates.

**Encryption.** Each recording gets a random 256-bit data key; every chunk is encrypted with AES-256-GCM (authenticated, bound to the recording id and position) before it reaches storage. The data key is wrapped by a master key from a keyring (`RECORDING_MASTER_KEYS`, `RECORDING_ACTIVE_KEY_ID`); rotation keeps old keys in the ring. Deleting a recording erases the objects and sets the wrapped key to NULL, so nothing can be decrypted afterwards.

**Storage.** Private object store behind an interface. Only the filesystem backend (`RECORDING_STORE=fs`, `RECORDING_STORE_DIR`, owner-only, never served by the web server) is implemented and tested. An S3-compatible backend is **not implemented**.

**Access.** Only the meeting's host can list, get a link, or delete (`GET .../recordings`, `GET /api/recordings/:id/access`, `DELETE /api/recordings/:id`). A link is signed, single-use, bound to the host, and expires (`RECORDING_LINK_SECONDS`, default 300); it is checked against the database clock. Every grant, refusal and download is audited. A chunk that fails authentication is never delivered (the download is cut and `recording.integrity_failure` is logged).

**Retention and legal hold.** The host chooses 7/30/90/365 days in the request; the notice text is generated from that number, so what participants read is what is enforced. A sweep deletes expired recordings. An administrator (header `x-qorlla-admin` = `RECORDING_ADMIN_SECRET`, not a meeting token) can place or lift a legal hold; a held recording cannot be deleted by the host or by retention.

**Recovery.** A recorder that disappears (no chunks for `RECORDING_IDLE_MS`, default 120 s) is finalized from what was received and flagged `partial`. Finalization that never completes is finished by the server after `RECORDING_FINALIZE_GRACE_MS` (default 45 s). Concurrent requests and starts are serialized by database constraints.

**Audit.** Recording and consent events are hash-chained per meeting (`GET .../recordings-audit` returns the events and the chain check) and the tables are append-only for every database role (trigger), unless a maintenance session sets `qorlla.allow_purge`. AI consent is a separate append-only record per purpose (`POST .../ai-consent`, `GET .../consent-status`); **no AI processing exists in this version**, so these only record choices.

**Not done / limits.** A modified browser can still send arbitrary media: capture is client-side, the strongest design is server-side (SFU) recording. No hardware/cloud KMS (keyring from your secret manager). No S3 backend, malware scanning (not needed for recordings, needed for the future shared-files feature), per-region legal text, or counsel review. Participants cannot download recordings (host only). Single-use links mean a failed or retried download needs a new link.
