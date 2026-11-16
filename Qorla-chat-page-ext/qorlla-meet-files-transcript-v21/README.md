# Qorlla Meet V2.1 — Shared Files and Consent-Gated Live Transcript

**Status: integration candidate, NOT production certified.** This is concrete application code, not a claim of deployment or an operational speech-to-text service.

## Included
- `sql/021_collaboration.sql`: tenant/meeting/room-scoped file metadata, approvals, scanning state, transcription sessions, participant consent, transcript segments and audit schema.
- `src/files.mjs`: S3-compatible presigned uploads, size/MIME/byte verification, fail-closed scanning, host approval, scoped downloads and deletion.
- `src/scanner.mjs`: ClamAV + content signature detector injection; must connect to actual scanner and detector. Fail closed.
- `src/transcripts.mjs`: room-wide unanimous consent, revocation epoch, session pause, trusted-worker ingestion with repeated consent checks, and transcript access.
- `src/router.mjs`: Express API router; mount behind existing Meet auth and rate limits.
- `ui/MeetCollaboration.tsx`: starter React UI for files and transcript consent; must integrate into existing Meet tabs.

## Integration contracts (required)
- `authority.verify(token, occurrenceId)` returns authenticated `{tenantId,occurrenceId,participantId,role,roomId}` from Meet's actual session authority; never trust browser-supplied roles/room.
- `authority.listActiveRoomMembers(pgClient,tenantId,occurrenceId,roomId)` reads authoritative presence/membership **inside the same DB transaction**. Must include everyone whose audio could be captured, including guests. Membership joins/leaves/moves MUST synchronously call `transcripts.membershipChanged` before audio is accepted; race-free consent requires an authoritative shared lock/protocol on membership and capture.
- `mediaControl.startCapture(sessionId,consentEpoch)` and `.stopCapture(sessionId)` must be implemented in an actual consent-aware capture gateway; Meet's P2P signaling alone cannot obtain every participant's audio. It MUST reject audio unless epoch and unanimous consent are still current; revocation MUST stop all sources and queued chunks. `stt.start/stop` is an internal-only speech-to-text worker, not an external vendor. No raw audio to Portal or third parties.
- `storage` S3-compatible bucket is private; do not allow public ACL, CORS wildcard, or client-selected object keys. Presigned PUT is short-lived. Protect uploads from stale URLs, malicious metadata and concurrent finalize races; scan retries need a supervised queue.
- `scanner.inspect` requires a real ClamAV and MIME signature detector; fail closed on outage. Allowlist is intentionally narrow; content disarm and reconstruction may be needed for PDF/Office documents.
- Apply real rate limits, CSRF protections as appropriate, audit hooks, object lifecycle rules, encryption-at-rest, access logging, and retention policies.

## Known release blockers / security limitations
1. `finalize` scans after upload; the signed upload URL may remain valid for its TTL, so **object version pinning or immutable quarantine-to-clean copy** is REQUIRED before enabling downloads. A malicious uploader could overwrite a scanned object using an unexpired PUT URL. Production should use unique quarantine keys, S3 versionId/ETag verification, and promote only the scanned immutable version.
2. Transcript consent currently uses room-membership reads but needs a **single serializable membership/capture transaction protocol** in the actual Meet repository to eliminate join/revoke races. Without it, do not enable audio capture.
3. `transcriptService.consent` coordinates DB and STT outside a transaction; if a process crashes, a reconciler must stop orphan capture and fail closed. Do not start media without a fenced worker lease and repeated epoch validation.
4. `transcriptService.list` must enforce the product's transcript consent and withdrawal/retention policy, not just room access. A guest's historical transcript visibility must be specified and enforced.
5. Shared files require actual S3-compatible storage, scanner, quarantine promotion, object retention/deletion worker, and cross-server authorization tests.
6. Speech recognition requires a deployed private STT engine (e.g. self-hosted Whisper-compatible service), streaming gateway, diarization policy, and real mobile/Safari tests. This package does not include those running services.
7. Independent security review, privacy review, accessibility, load, and end-to-end certification are outstanding.

## Quick checks
`npm test` (Node 22). `npm run check`. Apply SQL only on a disposable PostgreSQL first. Do not deploy migration or services without approval.

## Proposed APIs
`POST /:occ/files`, `POST /:occ/files/:id/finalize`, `POST /:occ/files/:id/approve`, `GET /:occ/files`, `GET /:occ/files/:id/download`, `DELETE /:occ/files/:id`; `POST /:occ/transcripts`, `POST /:occ/transcripts/:id/consent`, `GET /:occ/transcripts/:id`, `POST /:occ/transcripts/:id/stop`.

## Release verdict
**NO-GO** until integration contracts and blockers are resolved and independently tested. No live deployment performed.
