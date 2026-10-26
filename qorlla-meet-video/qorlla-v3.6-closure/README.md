# Qorlla Meet v3.6 — MAIN-side pending sync and backfill integration pack

This is an **integration pack**, not a claim that the unprovided MAIN `workplace.js`, MAIN database, `server.js`, or actual two-server deployment has been modified or tested.

## Install
Node >=20; `npm install pg` in MAIN app. Copy `integration/` into MAIN server-only directory. Run `sql/main_sync.sql` against MAIN PostgreSQL DB (not Meet). Back up MAIN and Meet databases first. Set MAIN `DATABASE_URL`, `MEET_BASE_URL`, `QORLLA_BRIDGE_SECRET` (>=32 characters). Do not put bridge secrets in the browser.

## Scheduling lifecycle
- In a transaction with schedule creation/edit, save the schedule as `pending_sync` and enqueue an upsert with its durable `sourceId`, `legacyCode`, `title`, `ownerName`, and `scheduledAt`. Do not show a join link until mapping is saved and status is `synced`.
- `enqueue(pool,sourceId,'upsert',payload)` supports retries and duplicate jobs. **Important:** the included function does not itself wrap the MAIN schedule mutation in the same transaction; adapt it to accept the transaction client and call it inside your existing MAIN transaction.
- Worker calls Meet GET, PATCH or POST and stores mapping. Provide real encrypted `saveHostSecret(sourceId,secret)` and `onSynced(sourceId,mapping)` callbacks. The host secret must never be logged or returned to a browser.
- For cancellation, mark MAIN schedule `cancel_pending`, enqueue cancel, and block joins immediately in MAIN. Finalize local cancellation after remote acknowledgment. A cancellation must suppress any queued upsert for the same source ID; enforce this in MAIN transaction or replace queue with an ordered per-source event log.
- For edits, update the local desired schedule state and enqueue upsert. A concurrent worker may observe an older payload; use schedule version checks/serial ordering before production.
- Failed jobs back off exponentially and become `dead` after 12 attempts; inspect and manually requeue after resolving permanent 4xx errors. A 409 collision must not be silently reassigned.

## Backfill existing schedules
Export **actual** MAIN schedules as JSONL, one object per line, e.g.:
`{"sourceId":"schedule-1042","legacyCode":"858 9833 3712","title":"Team Meeting","ownerName":"Host","scheduledAt":"2026-10-30T15:00:00Z"}`

Dry-run: `node integration/backfill.mjs schedules.jsonl`
Apply: `node integration/backfill.mjs schedules.jsonl --apply`

Backfill enqueues only; the worker must be configured and running to register. Dry-run validates format and duplicate legacy codes **within the export**; it does not verify collisions already stored in Meet. Preserve original IDs. Do not backfill canceled/deleted schedules.

## Host-secret first-response risk
Meet v3 registration returns `hostSecret` only on first successful creation. If the MAIN process crashes between registration and vault persistence, a retry can recover the mapping but **cannot recover host privileges**. Do not claim host recovery is solved. Add a protected server-to-server host credential rotation/recovery endpoint with authorization and audit before certification. This pack fails closed when vault callback is absent.

## Still outstanding
- Actual MAIN scheduling persistence adapter and encrypted vault implementation
- Safe cancel/upsert ordering, optimistic version checks, transactional outbox integration
- Host credential recovery, title/passcode dialog, `/index.html` canonical route fix
- PostgreSQL migration execution, cross-server tests C01–C16, and device media tests

## Suggested certification extension
C17 Meet offline -> MAIN pending -> retry -> synced; C18 duplicate backfill; C19 legacy collision -> dead/manual resolution; C20 worker crash during lease; C21 host vault failure and recovery; C22 cancellation vs queued upsert; C23 edit during in-flight sync; C24 no join link until synced. Do not mark these passed without execution.
