# Certification harness

`run-cert.mjs` drives the real stack and writes `evidence.json` + `EVIDENCE.md` (with the Git HEAD SHA, dirty-tree flag and file fingerprints).

Stack: MAIN + sync worker + main PostgreSQL in Docker (`docker compose -p qcert up -d --build main-db workspace-signaling-engine meet-sync-worker`),
Meet PostgreSQL in Docker (container `cert-meet-db`, host port 25501, schema + v2/v3/v3.1-3.5/002 migrations applied), Meet itself as a node process on :3000 (the runner starts/stops it),
Chromium via Playwright for the browser checks. Required env file keys: MAIN_DB_PASSWORD, QORLLA_BRIDGE_SECRET, QORLLA_VAULT_KEY, MEET_BASE_URL, JWT_SECRET, RECOVERY_ESCROW_KEY.

Run (PowerShell): `node cert/run-cert.mjs <path-to-env-file>`

Notes: C12 shares the C13 browser session (it records leaving Meet and landing back on MAIN). C20 simulates the lease state by editing the outbox row; C19 fast-forwards backoff timestamps.
