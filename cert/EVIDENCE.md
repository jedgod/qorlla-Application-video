# Certification evidence

- Started: 2026-10-26T18:38:45.832Z
- Finished: 2026-10-26T18:41:30.639Z
- Git HEAD: `5c96568b3a8515a826df06677ec9a8deca12a0ec` (working tree DIRTY: 12 changed/untracked paths — commit before treating this SHA as the tested build)
- Tested-file fingerprints (sha256/16): workplace.js:de23499937889b83, qorlla.html:eb1398d0f0b5c44a, Dockerfile:645e3e2360f1c5c2, docker-compose.yml:f104d00522229bf1, meet-sync/src/worker.mjs:65d3c943a39926ad, meet-sync/src/store.mjs:5cc42fe5f6f5fb17, qorlla-meet-video/server/index.js:9f594cd3e02a749b, qorlla-meet-video/server/recovery-service.mjs:d55003d9abb539f4
- Result: **30 passed, 0 failed, 0 not run**

| ID | Result | Check | Detail |
|---|---|---|---|
| C01 | PASS | New schedule creates a Meet mapping (pending_sync -> synced, DB rows) | source=241f6063-4b38-4c66-80ab-b61b032faeec code=961035282907 uuid=f8614aeb-6539-4d6d-b851-630a74a4a531 |
| C02 | PASS | Retry/idempotency: re-registering same sourceId returns same mapping |  |
| C03 | PASS | Legacy (formatted) code resolves to the registered meeting | 304 3874 2781 |
| C04 | PASS | Join via UUID and via numeric public code |  |
| C05 | PASS | Title/time update propagates to Meet |  |
| C06 | PASS | Cancellation (delete in MAIN) ends the meeting and prevents joining |  |
| C07 | PASS | Bridge rejects missing/wrong secret (401) |  |
| C08 | PASS | Legacy-code collision returns 409 and does not remap |  |
| C09 | PASS | MAIN restart while pending: retry completes with same sourceId |  |
| C10 | PASS | Meet restart keeps persisted mapping |  |
| C11 | PASS | Simultaneous registration of one sourceId creates exactly one meeting |  |
| C12 | PASS | Leave returns to the originating MAIN page (same host) | left Meet and landed at localhost:5000 |
| C13 | PASS | Camera/mic preferences from MAIN dialog are honoured in Meet | left Meet and landed at localhost:5000 |
| C14 | PASS | Browser: scheduled meeting with passcode prompts in the Meet lobby (wrong -> error, right -> enters) |  |
| C14a | PASS | Passcode enforced server-side (wrong/missing -> 403, correct -> 200) |  |
| C15 | PASS | /index.html repaired (served by MAIN), /qorlla.html preserved, 1index.html untouched |  |
| C16 | PASS | Two browsers: real (fake-device) media between peers, chat, and recovery after network disruption | video tiles flowing on host after disruption: 2 |
| C17 | PASS | Meet outage -> schedules stay pending -> automatic recovery | attempts during outage: 1 |
| C18 | PASS | Backfill is idempotent (duplicate apply creates no duplicates) |  |
| C19 | PASS | Legacy-code collision in worker -> 409s, ends dead, never mapped to the wrong meeting | dead\|12\|Meet bridge 409: Legacy code already in use |
| C20 | PASS | Lease expiry: stale leased job is re-claimed and completed (simulated lease state) |  |
| C21 | PASS | Crash after Meet commit, before vault write: recovery rotates once, vaults, acks, host login works |  |
| C22 | PASS | Cancel wins over a queued (unprocessed) upsert | meet link rows after cancel race: 0 |
| C23 | PASS | Concurrent edits apply in version order (last edit wins) |  |
| C24 | PASS | Browser: pending/unregistered meetings show no Join; cancelled meetings are not joinable |  |
| R01 | PASS | Lost response replays the SAME generation and secret (no second rotation) |  |
| R02 | PASS | Unvaulted/unacknowledged recovery leaves escrow PENDING with encrypted secret |  |
| R03 | PASS | Ack failure (wrong secret) is rejected and retryable; correct ack succeeds |  |
| R04 | PASS | Different request ID while pending -> 409 |  |
| R05 | PASS | After replay + ack, new credential claims host and the previous credential fails |  |
