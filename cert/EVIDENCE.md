# Certification evidence

- Started: 2026-10-26T20:16:52.579Z
- Finished: 2026-10-26T20:30:36.277Z
- Git HEAD: `f3e5ef721c45cb724ab2c6387562f69e3fbc5283` (working tree DIRTY: 9 changed/untracked paths — commit before treating this SHA as the tested build)
- Tested-file fingerprints (sha256/16): workplace.js:de23499937889b83, qorlla.html:681d3df95d85e6d5, Dockerfile:1563dfe34338afd4, docker-compose.yml:7c1f081c4770d7ed, meet-sync/src/worker.mjs:16fbabb5c760393a, meet-sync/src/store.mjs:5cc42fe5f6f5fb17, qorlla-meet-video/server/index.js:ee9361fc15ddb410, qorlla-meet-video/server/recovery-service.mjs:d55003d9abb539f4
- Result: **5 passed, 33 failed, 0 not run**

| ID | Result | Check | Detail |
|---|---|---|---|
| C01 | FAIL | New schedule creates a Meet mapping (pending_sync -> synced, DB rows) | Timed out waiting for b5b29ab8-e95a-4aea-98f4-6fbf7ddbdf89 synced (last: undefined) |
| C02 | FAIL | Retry/idempotency: re-registering same sourceId returns same mapping | Cannot read properties of null (reading 'id') |
| C03 | FAIL | Legacy (formatted) code resolves to the registered meeting | Cannot read properties of null (reading 'meetingId') |
| C04 | FAIL | Join via UUID and via numeric public code | Cannot read properties of null (reading 'uuid') |
| C05 | FAIL | Title/time update propagates to Meet | Cannot read properties of null (reading 'id') |
| C06 | FAIL | Cancellation (delete in MAIN) ends the meeting and prevents joining | Timed out waiting for 93630b2b-3d39-4b7e-bd62-332aee66ad80 synced (last: "fetch failed") |
| C07 | PASS | Bridge rejects missing/wrong secret (401) |  |
| C08 | FAIL | Legacy-code collision returns 409 and does not remap | Cannot read properties of null (reading 'meetingId') |
| C09 | FAIL | MAIN restart while pending: retry completes with same sourceId | fetch failed [cause: ECONNREFUSED] |
| C10 | FAIL | Meet restart keeps persisted mapping | Cannot read properties of null (reading 'meetingId') |
| C11 | FAIL | Simultaneous registration of one sourceId creates exactly one meeting | relation "external_meeting_links" does not exist |
| C12 | FAIL | Leave returns to the originating MAIN page on the same host (independent session) | page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5000/ Call log: [2m  - navigating to "http://localhost:5000/", waiting until "load"[22m  |
| C13 | FAIL | Camera/mic preferences from MAIN dialog are honoured in Meet | page.waitForURL: Timeout 30000ms exceeded. =========================== logs =========================== waiting for navigation until "load" ============================================================ |
| C14 | FAIL | Browser: scheduled meeting with passcode prompts in the Meet lobby (wrong -> error, right -> enters) | page.goto: net::ERR_EMPTY_RESPONSE at http://localhost:5000/ Call log: [2m  - navigating to "http://localhost:5000/", waiting until "load"[22m  |
| C14a | FAIL | Passcode enforced server-side (wrong/missing -> 403, correct -> 200) | Cannot read properties of null (reading 'uuid') |
| C15 | FAIL | /index.html repaired (served by MAIN), /qorlla.html preserved, 1index.html untouched | fetch failed [cause: UND_ERR_SOCKET] |
| C16 | PASS | Two browsers: real (fake-device) media between peers, chat, and recovery after network disruption | video tiles flowing on host after disruption: 2 |
| C17 | PASS | Meet outage -> schedules stay pending -> automatic recovery | attempts during outage: 2 |
| C18 | PASS | Backfill is idempotent (duplicate apply creates no duplicates) |  |
| C19 | FAIL | REAL timers: legacy-code collision -> 409s -> exponential backoff -> dead after 12 attempts (no timestamp edits) | Timed out waiting for job reaches dead via real backoff (last: false) |
| C20 | PASS | REAL lease expiry: worker killed mid-job; job re-claimed only after its lease expires (6s lease, wall-clock) | lease_until=2026-10-26T20:21:36.124Z killed=2026-10-26T20:21:33.572Z completed=2026-10-26T20:21:39.439Z (waited 5.867s after kill) |
| C21 | FAIL | Crash after Meet commit, before vault write: recovery rotates once, vaults, acks, host login works | Timed out waiting for recovered vault secret (last: "Command failed: docker exec qcert-main-db-1 psql -U qorlla_main -d qorlla_main -tAc SELECT ciphertext\|\|'\|'\|\|iv\|\|'\|'\|\|tag FROM qorlla_host_vault WHERE source_id='c3fb1a0b-839d-4d77-9f7d-3532d123044b'\npsql: error: connection to server on socket \"/var/run/postgresql/.s.PGSQL.5432\" failed: FATAL:  database \"qorlla_main\" does not exist\n") |
| C22 | FAIL | Cancel wins over a queued (unprocessed) upsert | fetch failed [cause: ECONNREFUSED] |
| C23 | FAIL | Concurrent edits apply in version order (last edit wins) | fetch failed [cause: ECONNREFUSED] |
| C24 | FAIL | Browser: pending/unregistered meetings show no Join; cancelled meetings are not joinable | fetch failed [cause: ECONNREFUSED] |
| R01 | FAIL | Lost response replays the SAME generation and secret (no second rotation) | fetch failed [cause: ECONNREFUSED] |
| R02 | FAIL | Unvaulted/unacknowledged recovery leaves escrow PENDING with encrypted secret | relation "host_recovery_escrow" does not exist |
| R03 | FAIL | Ack failure (wrong secret) is rejected and retryable; correct ack succeeds | Cannot read properties of undefined (reading 'data') |
| R04 | FAIL | Different request ID while pending -> 409 | fetch failed [cause: ECONNREFUSED] |
| R05 | FAIL | After replay + ack, new credential claims host and the previous credential fails | Cannot read properties of undefined (reading 'data') |
| RC01 | FAIL | Ack failure retried by its OWN worker (no schedule job), bounded real backoff, escrow retained until Meet confirms | fetch failed [cause: UND_ERR_SOCKET] |
| RC02 | FAIL | Worker restart mid-retry: ack state is durable and the ack still completes | Timed out waiting for 03f67eca-9e0a-4991-97c1-9aaaaf49c0f2 synced (last: undefined) |
| RC03 | FAIL | Lost ack RESPONSE (Meet processed it): retry gets "not pending" and finishes idempotently; host credential intact | Timed out waiting for 13fa798b-787b-4746-a966-ee5e606a3957 synced (last: "fetch failed") |
| RC04 | FAIL | Repeated acknowledgment is rejected (409) and changes nothing | fetch failed [cause: ECONNREFUSED] |
| RC05 | FAIL | Concurrent workers: exactly one ack request is issued for a pending recovery | fetch failed [cause: ECONNREFUSED] |
| RC06 | FAIL | REAL lease expiry on ack: worker killed mid-ack; another worker acks only after the lease expires | fetch failed [cause: ECONNREFUSED] |
| RC07 | FAIL | Cancellation during recovery: pending ack still completes; recovery of the cancelled meeting is refused | fetch failed [cause: ECONNREFUSED] |
| RC08 | FAIL | Meet database interruption during ack: escrow retained, ack completes after the database returns | fetch failed [cause: ECONNREFUSED] |
