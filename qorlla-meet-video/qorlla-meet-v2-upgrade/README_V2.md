# Qorlla Meet v2 — integration and meeting-code compatibility

This is an incremental v2 upgrade to the existing starter, **not an SFU-powered enterprise deployment**.

## Included in this patch
- Public 12-digit meeting codes for newly created rooms, alongside internal UUID identifiers. Spaces and hyphens in numeric meeting IDs are accepted on join.
- `GET /api/resolve/:code` resolves a public code to an internal UUID.
- Host-only `POST /api/meetings/:id/lock` with `{ "locked": true | false }`.
- URL handoff from `qorlla.html` with `start`, `meetingId`, `name`, `title`, `mic`, `camera`, and same-host `return`.
- An ES-module integration helper at `integration/qorlla-main-bridge.js`.
- SQL migration for existing installations.

## Run / migrate

```bash
cp .env.example .env # only for a new install; configure JWT_SECRET
npm install
docker compose up -d
docker compose exec -T postgres psql -U qorlla -d qorlla_meet < sql/schema.sql
docker compose exec -T postgres psql -U qorlla -d qorlla_meet < sql/v2_migration.sql
npm run check
npm run dev
```

The main Qorlla server still runs separately on port 5000. Its files were **not included** in the supplied starter, so this patch cannot repair its `server.js` `/index.html` route or its deleted/untracked files. Do not rename or delete those files without inspecting the actual repository.

## Critical scheduling distinction
A numeric code is not a scheduled meeting. A meeting created in the main application must be created in the Meet database (or explicitly mapped to its UUID) before a user can join by that code. Existing numeric IDs from the main page are **not** automatically backfilled. The scheduling integration must store the Meet API's returned `meetingId` and `meetingCode`, and not invent identifiers.

## Release limitations
- The app still uses guest JWTs and peer-to-peer WebRTC mesh, **not LiveKit SFU**.
- No server-enforced waiting room, enterprise SSO, breakout rooms, cloud recording, AI, whiteboard, or webinar service.
- The 12-digit meeting code is a public locator, not a security credential. Protect meetings with passcodes, permissions and verified identity.
- Passcodes should not be included in URL query strings; the integration helper deliberately omits them.
- Room creation codes use random bytes reduced to decimal; a rare unique-index collision will fail creation rather than retry. Add a bounded retry in a production version.
- Run end-to-end tests across both ports and real devices before release; syntax checks alone are not sufficient.

## Suggested verification
1. Start Postgres and Meet on 3000, main page on 5000.
2. Create a meeting from the main page; confirm title/name/mic/camera preferences.
3. Record the returned public meeting code and join from a separate browser profile.
4. Check passcode failures, host lock, leave and same-host return behavior.
5. Check that a pre-existing scheduled ID without a Meet record does **not** join.
6. Verify `/index.html` handling in the main server independently.
