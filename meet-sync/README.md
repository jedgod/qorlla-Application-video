# Qorlla Meet v3.7 — Main-side PostgreSQL closure pack

**Scope:** This is an integration package for a main Qorlla server that currently stores schedules in JSON. It does not modify the unavailable main `workplace.js` or `server.js`, and it does not claim C01–C24 certification.

## Install
1. Back up JSON schedules and Meet PostgreSQL.
2. Provision **main-side** PostgreSQL (separate database recommended). Run `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/001.sql`.
3. `npm install`. Set `DATABASE_URL`, `MEET_BASE_URL`, `QORLLA_BRIDGE_SECRET` (32+ chars), and `QORLLA_VAULT_KEY` (base64 of 32 random bytes). Never expose these in the browser.
4. Copy the v3.6 `integration/bridge.mjs` into `src/bridge.mjs` and change the import in `src/worker.mjs` from `../../qorlla-v3.6-closure/integration/bridge.mjs` to `./bridge.mjs` before deploying outside this workspace.
5. Integrate `saveSchedule(pool, schedule)` and `cancelScheduleLocal(pool, sourceId)` into authenticated main scheduling routes. **Remove the old inline Meet registration path** after switching; never run both. Schedule status `pending_sync` means Join must be disabled. Only `synced` rows with Meet UUID/code may expose a join link.
6. Run `npm run worker` in a supervised process; backfill with `node src/backfill.mjs export.jsonl` (dry-run), then `--apply`. Backfill expects actual JSON export normalized to `{sourceId,legacyCode,title,ownerName,scheduledAt}`. Never backfill cancelled records.

## Guarantees and limitations
- Transactional schedule/outbox writes; versioned stale-job suppression; per-source advisory lock; cancellation blocks local join immediately; retries with exponential backoff and dead-letter after 12 failures.
- Vault encryption uses AES-256-GCM; encryption key must be managed externally and backed up securely. Existing v3 Meet API returns hostSecret only once; **host recovery after a crash between remote registration and local vault commit remains unresolved**. A protected audited rotation endpoint must be implemented on Meet before production release.
- Existing JSON schedules are not automatically converted. The main app must switch read/edit/delete handlers to PostgreSQL. Do not remove JSON storage until reconciliation is verified.
- PostgreSQL row lock is held during remote API calls for per-source ordering. This is simple but can reduce throughput; use a dedicated per-source distributed lock/lease design at scale.
- The v3.5 Meet cancellation endpoint must be idempotent. The bridge must use authenticated server-side calls. Do not return vault contents to browsers.
- No main-page title/passcode form, schedule edit form, or `/index.html` repair is included because those source files were not supplied.

## Certification
C01–C16: create/join/update/delete/alias/host/authentication/migration/route flows on real main and Meet servers. C17–C24: outage retry, duplicate backfill, collision, lease expiry, host-secret recovery, cancel race, edit race, pending join block. **All require live testing; C21 must remain blocked until Meet-side host recovery is implemented.**
