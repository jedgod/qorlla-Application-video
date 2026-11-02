# Automated security verification

- Git HEAD: `782cd39b6e96a84ae95a1bf45a26a32e6a2e3386` (branch release/qorlla-meet-v3.9.2-production-closure; source tree DIRTY:  M cert/PROXY_EVIDENCE.json,  M cert/PROXY_EVIDENCE.md,  M cert/SECURITY_EVIDENCE.json,  M cert/SECURITY_EVIDENCE.md,  M cert/evidence.json,  M cert/screenshots/C16-guest.png,  M cert/screenshots/C16-host.png,  M cert/screenshots/C24-pending.png,  M cert/screenshots/P06-proxy-passcode.png,  M cert/screenshots/P07-proxy-guest.png,  M cert/screenshots/P07-proxy-host.png)
- Result: **4 passed, 11 failed** (automated controls only; not an independent review)

| ID | Result | Control | Detail |
|---|---|---|---|
| SEC01 | PASS | Meet serves an enforced CSP (script-src self, frame-ancestors none) and the page has no inline script/handler attributes |  |
| SEC02 | FAIL | Passcode brute force is throttled per client+meeting (8 failures -> 429); other clients unaffected | sequence 404,404,404,404,404,404,404,404,404,404 |
| SEC03 | PASS | Rate limits are keyed on the real client address behind a proxy (X-Forwarded-For) - one noisy client cannot starve others | limited 10/100 for the noisy client only |
| SEC04 | FAIL | WebSocket authorization: no/forged/expired/foreign-secret tokens are refused; cross-meeting REST access is refused | valid token refused |
| SEC05 | FAIL | Host-only actions are enforced server-side (notes, polls, end, lock refused for guests) | guest socket |
| SEC06 | FAIL | Socket flood control: events beyond the per-socket budget are refused with "Rate limited" | connect |
| SEC07 | FAIL | SQL injection probes are inert (parameterised queries; no 500s, tables intact) | hostile title/name rejected? 500 |
| SEC08 | PASS | Bridge: wrong-length/prefix/empty secrets refused; bridge traffic has its own higher rate budget |  |
| SEC09 | FAIL | Stored XSS: hostile chat text/display name never becomes markup or runs script (browser-verified, CSP active) | page.waitForSelector: Timeout 30000ms exceeded.
Call log:
[2m  - waiting for locator('#app:not(.hidden)') to be visible[22m
 |
| SEC10 | PASS | Logs contain no secrets (bridge secret, vault/escrow keys, JWT secret, host secrets) | scanned 32 KiB of logs |
| SEC11 | FAIL | MAIN: login brute force is throttled; weak passwords refused; error text does not reveal which field was wrong | fetch failed |
| SEC12 | FAIL | MAIN: cross-site request cannot use the session cookie (SameSite) - no state change from a hostile origin | fetch failed |
| SEC13 | FAIL | Containers run unprivileged (MAIN, worker) | Command failed: docker exec zoom_core_backend_instance id -u
Error response from daemon: No such container: zoom_core_backend_instance
 |
| SEC14 | FAIL | Application database roles are least-privilege (not superuser, no DDL, cannot drop tables) | Command failed: docker exec qcert-main-db-1 psql -U qorlla_app -d qorlla_main -tAc SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname=current_user
Error response from daemon: container 932c3d56730fddac7a4d1a884781fa64fdbee1f3448c17e5b74a091233c48795 is not running
 |
| SEC15 | FAIL | Recovery responses are no-store; escrow is ciphertext at rest; invalid escrow key fails closed at startup | fetch failed |
