# Qorlla Meet v3 — scheduled meeting reconciliation

## What this changes
- Server-authenticated, idempotent scheduling integration (`POST /api/integrations/scheduled-meetings`).
- Main application's stable `sourceId` maps to a Meet UUID, with a generated public 12-digit code.
- Existing 10–12 digit scheduled codes can be registered as aliases to the same UUID.
- `GET /api/integrations/scheduled-meetings/:sourceId` allows the trusted main server to retrieve an existing mapping.
- Conflicting legacy codes return HTTP 409 instead of silently joining the wrong meeting.
- A one-time host secret is returned on creation only. Keep it encrypted on the main backend.

## Setup
1. Back up PostgreSQL; run `sql/schema.sql`, `sql/v2_migration.sql`, then `sql/v3_migration.sql` (each once or safely re-run).
2. Set the same **random 32+ character** `QORLLA_BRIDGE_SECRET` on both backend servers. Never put it in `qorlla.html`, localStorage or query parameters.
3. Main backend: set `MEET_BASE_URL=http://127.0.0.1:3000` (or private internal Meet address). Import `integration/qorlla-main-server-v3.mjs` into the main server.
4. On main app scheduling, call `reconcileScheduledMeeting({sourceId: String(schedule.id),title,ownerName,legacyCode,scheduledAt})` from the **backend**, and persist `meetingId`, `meetingCode` before confirming schedule creation. On retries use the SAME sourceId.
5. Existing schedules: run the same operation for each existing record from the main app's real database, with its original source ID and numeric meeting code. No automatic blind migration is performed.
6. Main app UI: join using stored `meetingCode` (or legacy alias); do not invent codes. Passcode is entered in the Meet lobby, not the URL.

## Test cases
- First registration -> 201; retry same sourceId -> 200 with same UUID/code.
- Different sourceId with same legacyCode -> 409.
- Join with formatted legacy code `858 9833 3712` -> resolves to the registered meeting.
- Missing/incorrect bridge secret -> 401.
- Unregistered scheduled ID -> 404 (must fail closed).
- Ended meeting -> resolve returns 404; join rejects.
- Main page on port 5000, Meet on port 3000: verify new/join, camera/mic preferences, leave/return, two-browser communication.

## Not included / release blockers
- The actual main application's `server.js`, scheduling schema, and `qorlla.html` were not supplied. The integration helper is ready, but main-server wiring and `/index.html` fix must be done in that repository.
- No running PostgreSQL or cross-server end-to-end test was performed in this package.
- No SFU, TURN, cloud recording, waiting-room enforcement, enterprise SSO or real-device certification.
- Do not publish hostSecret in the browser or logs. A production host recovery/identity flow is still required.
