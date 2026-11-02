# Qorlla Meet v3.9 — Recovery consistency and release gate

This is a **repository integration overlay**, not a production-certified deployment. It was developed against the available v3.5 Meet schema and the user's description of their v3.8 modifications. The actual current `workplace.js`, `server.js`, `qorlla.html`, and v3.8 Meet server are not in this archive; do not overwrite them with older versions.

## Critical v3.9 change: stable recovery request and acknowledgment

`meet/recovery-service.mjs` implements a durable recovery escrow in the Meet PostgreSQL database. A rotation writes both the host credential hash and encrypted recovery secret in **one Meet transaction**. If the main worker loses the response or fails to vault the secret, retrying with the **same persisted request ID** returns the same generation and secret; it does **not** rotate again. A different request ID receives 409 while the first recovery is pending. After main durably stores the secret and verifies that it can claim host privileges, main acknowledges the generation and Meet erases the escrow ciphertext.

Use `meet/002_recovery.sql` after backing up the Meet database. Set `RECOVERY_ESCROW_KEY` to a distinct 32-byte base64 key held in a secret manager (do not reuse `QORLLA_VAULT_KEY`). Back it up securely: losing this key prevents decrypting pending recovery records. Never log or return the escrow secret to browser clients.

**Integration steps:**
1. Verify the current Meet schema and bridge authentication before migration. `recoveryService(pool,key)` uses `external_meeting_links` with `source_system='qorlla-main'` and `meetings.host_secret_hash` as in the supplied v3.5 schema. Confirm the v3.8 rotation route and its hash format; adapt the hash to the same credential verifier before use.
2. Replace the v3.8 blind rotation route with two server-only endpoints: `POST /api/integrations/scheduled-meetings/:sourceId/recover-host` invoking `issue({sourceId,requestId})`, and `POST .../:sourceId/ack-host` invoking `acknowledge({sourceId,requestId,generation})`. Require bridge authentication, private networking, source-specific authorization, rate limits and audit entries. Return `Cache-Control: no-store` and never log secrets.
3. Main PostgreSQL must persist a stable recovery request ID **before** invoking Meet, using a row lock/unique key per schedule. `main/recovery-client.mjs` orchestrates the call. Implement `vaultPut` as an atomic upsert of encrypted secret, generation and request ID; verify host login before ack. Store ack-pending state for retries.
4. Prevent concurrent recovery and cancellation races. Lock the schedule row and recheck state/version before and after remote calls. Cancelled meetings must not accept recovery. Add periodic expiry monitoring for unacknowledged escrow records, but never discard an outstanding secret without an explicit incident recovery procedure.
5. Ensure the main UI never receives host secrets or passcodes. Add meeting title and optional passcode fields to the authenticated create/edit form. Validate on server (`main/route-and-dialog.mjs`), hash passcodes with a password KDF, and use a protected body payload, not URL query parameters.
6. Once confirmed that `/qorlla.html` is canonical, use `installCanonicalRoute(app)` **before** any broken `/index.html` handler. Review Git history and preserve `1index.html` until its purpose is known.

## Certification (C01–C24)

Execute the existing C01–C24 matrix from v3.5–v3.8 with real Meet + main PostgreSQL, worker, both web servers and two browsers. Especially test C17 (Meet outage/retry), C18 (idempotent backfill), C19 (alias collision), C20 (worker lease expiry), C21 (crash after remote rotation before vault write), C22 (cancel wins), C23 (concurrent edits), C24 (join unavailable until synced). Add R01–R05: lost response replays same generation; vault failure leaves escrow pending; ack failure can be retried; concurrent different request IDs get 409; host claim succeeds after replay and old credential fails.

Record exact Git SHA, migration versions, timestamps, HTTP responses, redacted logs and browser screenshots. Do not mark production ready without full passing evidence, independent security review, backup/restore, rate-limit and load testing.

## Local checks

```sh
node --check meet/recovery-service.mjs
node --check main/recovery-client.mjs
node --check main/route-and-dialog.mjs
node --test tests/*.test.mjs
```

The included tests are unit-level only and do not exercise PostgreSQL or the two live applications.
