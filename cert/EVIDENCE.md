# Certification evidence

- Started: 2026-10-27T00:52:45.278Z
- Finished: 2026-10-27T00:58:33.277Z
- Git HEAD: `e9878003952817b2216c251506e639b34bbe1238` (working tree clean)
- Tested-file fingerprints (sha256/16): workplace.js:c8acede0c6670eb3, qorlla.html:681d3df95d85e6d5, Dockerfile:b67855d0307081b3, docker-compose.yml:1395e0d85b3eafa8, meet-sync/src/worker.mjs:16fbabb5c760393a, meet-sync/src/store.mjs:71d58434a747c855, qorlla-meet-video/server/index.js:d0eda8d55a1d48ac, qorlla-meet-video/server/recovery-service.mjs:e83daf387847648f
- Result: **38 passed, 0 failed, 0 not run**

| ID | Result | Check | Detail |
|---|---|---|---|
| C01 | PASS | New schedule creates a Meet mapping (pending_sync -> synced, DB rows) | source=259819ca-5f45-4c13-9697-9d1931e3eb65 code=095841040137 uuid=b4f903f8-b797-49b3-b581-1a27e012846f |
| C02 | PASS | Retry/idempotency: re-registering same sourceId returns same mapping |  |
| C03 | PASS | Legacy (formatted) code resolves to the registered meeting | 758 3126 2623 |
| C04 | PASS | Join via UUID and via numeric public code |  |
| C05 | PASS | Title/time update propagates to Meet |  |
| C06 | PASS | Cancellation (delete in MAIN) ends the meeting and prevents joining |  |
| C07 | PASS | Bridge rejects missing/wrong secret (401) |  |
| C08 | PASS | Legacy-code collision returns 409 and does not remap |  |
| C09 | PASS | MAIN restart while pending: retry completes with same sourceId |  |
| C10 | PASS | Meet restart keeps persisted mapping |  |
| C11 | PASS | Simultaneous registration of one sourceId creates exactly one meeting |  |
| C12 | PASS | Leave returns to the originating MAIN page on the same host (independent session) | returned to http://localhost:5000/#home |
| C13 | PASS | Camera/mic preferences from MAIN dialog are honoured in Meet | left Meet and landed at localhost:5000 |
| C14 | PASS | Browser: scheduled meeting with passcode prompts in the Meet lobby (wrong -> error, right -> enters) |  |
| C14a | PASS | Passcode enforced server-side (wrong/missing -> 403, correct -> 200) |  |
| C15 | PASS | /index.html repaired (served by MAIN), /qorlla.html preserved, 1index.html untouched |  |
| C16 | PASS | Two browsers: real (fake-device) media between peers, chat, and recovery after network disruption | video tiles flowing on host after disruption: 2 |
| C17 | PASS | Meet outage -> schedules stay pending -> automatic recovery | attempts during outage: 2 |
| C18 | PASS | Backfill is idempotent (duplicate apply creates no duplicates) |  |
| C19 | PASS | REAL timers: legacy-code collision -> 409s -> exponential backoff -> dead after 12 attempts (no timestamp edits) | dead\|12\|Meet bridge 409: Legacy code already in use after 39.038s real time |
| C20 | PASS | REAL lease expiry: worker killed mid-job; job re-claimed only after its lease expires (6s lease, wall-clock) | lease_until=2026-10-27T00:54:14.910Z killed=2026-10-27T00:54:11.477Z completed=2026-10-27T00:54:15.753Z (waited 4.276s after kill) |
| C21 | PASS | Crash after Meet commit, before vault write: recovery rotates once, vaults, acks, host login works |  |
| C22 | PASS | Cancel wins over a queued (unprocessed) upsert | meet link rows after cancel race: 0 |
| C23 | PASS | Concurrent edits apply in version order (last edit wins) |  |
| C24 | PASS | Browser: pending/unregistered meetings show no Join; cancelled meetings are not joinable |  |
| R01 | PASS | Lost response replays the SAME generation and secret (no second rotation) |  |
| R02 | PASS | Unvaulted/unacknowledged recovery leaves escrow PENDING with encrypted secret |  |
| R03 | PASS | Ack failure (wrong secret) is rejected and retryable; correct ack succeeds |  |
| R04 | PASS | Different request ID while pending -> 409 |  |
| R05 | PASS | After replay + ack, new credential claims host and the previous credential fails |  |
| RC01 | PASS | Ack failure retried by its OWN worker (no schedule job), bounded real backoff, escrow retained until Meet confirms | attempts while Meet down=3; backoff scheduled=t |
| RC02 | PASS | Worker restart mid-retry: ack state is durable and the ack still completes |  |
| RC03 | PASS | Lost ack RESPONSE (Meet processed it): retry gets "not pending" and finishes idempotently; host credential intact | ack requests seen by Meet: 2 |
| RC04 | PASS | Repeated acknowledgment is rejected (409) and changes nothing |  |
| RC05 | PASS | Concurrent workers: exactly one ack request is issued for a pending recovery | ack requests: 1 with two live workers |
| RC06 | PASS | REAL lease expiry on ack: worker killed mid-ack; another worker acks only after the lease expires | lease_until=2026-10-27T00:57:24.774Z completed=2026-10-27T00:57:26.507Z |
| RC07 | PASS | Cancellation during recovery: pending ack still completes; recovery of the cancelled meeting is refused |  |
| RC08 | PASS | Meet database interruption during ack: escrow retained, ack completes after the database returns |  |
