# Qorlla Meet v3.1–v3.5 — reconciliation hardening pack

**Basis:** existing v3 Meet source. This package is not an implementation of the absent Qorlla main `server.js` or its scheduling DB.

## Version milestones
- **v3.1:** Main-server registration contract, pending-sync and idempotent backfill workflow, secure handling of hostSecret; preserves numeric alias resolution.
- **v3.2:** PATCH scheduled meeting title/time via authenticated bridge.
- **v3.3:** Idempotent cancellation; terminates Meet session and emits `meeting-ended`.
- **v3.4:** `/api/ready` readiness endpoint with DB and bridge-secret checks; migration indexes.
- **v3.5:** Main-server bridge client, route repair guidance, syntax checks and offline contract tests.

## Upgrade from v2 or v3
1. Back up the database and application; compare modified files before replacing. This package includes complete v3 source.
2. Copy `.env.example` to `.env`, configure `JWT_SECRET` and `QORLLA_BRIDGE_SECRET` (both >=32 characters), `DATABASE_URL`, and `MEET_BASE_URL` on MAIN.
3. Start PostgreSQL: `docker compose up -d`.
4. For an existing v2 DB, apply `sql/v3_migration.sql`; for a v3 DB skip it. For a fresh DB, apply `sql/schema.sql` followed by `sql/v3_migration.sql`.
5. Apply `sql/v3_1_to_v3_5_migration.sql`.
6. `npm install`, `npm run check`, `npm start`.
7. Start MAIN separately on port 5000 after wiring its real schedule routes according to `integration/main-scheduling-contract.md`.

## New bridge operations
- `POST /api/integrations/scheduled-meetings` — idempotent registration (v3)
- `GET /api/integrations/scheduled-meetings/:sourceId` — lookup (v3)
- `PATCH /api/integrations/scheduled-meetings/:sourceId` — update title/time
- `POST /api/integrations/scheduled-meetings/:sourceId/cancel` — terminate scheduled meeting
- `GET /api/ready` — DB and bridge readiness

All integration routes require `x-qorlla-bridge-secret`. Never invoke them directly from a browser.

## Important gaps / limitations
- The MAIN scheduling server and database are **not provided**, so scheduled meeting creation, backfill, title/passcode UI, and `/index.html` route cannot be directly modified or tested here.
- No new meeting passcode change API is provided. New rooms can set passcodes in the existing Meet lobby; schedule registration does not yet support passcodes.
- Existing v3 design has hostSecret first-response loss risk, shared-secret bridge authentication without per-tenant authorization, and in-memory presence. These need production closure.
- No Docker runtime or cross-server E2E certification was run. `npm run check` only validates syntax and bridge contract tests.
- Peer-to-peer WebRTC is not suitable for large conferences. SFU/TURN, recordings, enterprise SSO, security review and accessibility certification remain separate work.

## Certification matrix (must run in actual repository)
C01 new schedule -> Meet mapping; C02 retry idempotency; C03 legacy code resolves; C04 join via UUID and numeric code; C05 title/time update; C06 cancellation prevents joining; C07 bridge rejects wrong secret; C08 code collision returns 409; C09 MAIN restart retry; C10 Meet restart persisted mapping; C11 simultaneous registration; C12 leave return same host; C13 camera/mic preferences; C14 passcode prompts; C15 deleted `/index.html` repaired; C16 two browsers with real media and network disruption.
