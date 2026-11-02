# Automated security verification

- Git HEAD: `e9878003952817b2216c251506e639b34bbe1238` (branch feature/qorlla-workplace-v4.5; source tree DIRTY:  M cert/SECURITY_EVIDENCE.json,  M cert/evidence.json,  M cert/screenshots/C12-independent.png,  M cert/screenshots/C12-returned.png,  M cert/screenshots/C13-prefs.png,  M cert/screenshots/C14-passcode.png,  M cert/screenshots/C16-guest.png,  M cert/screenshots/C16-host.png,  M cert/screenshots/C24-pending.png)
- Result: **15 passed, 0 failed** (automated controls only; not an independent review)

| ID | Result | Control | Detail |
|---|---|---|---|
| SEC01 | PASS | Meet serves an enforced CSP (script-src self, frame-ancestors none) and the page has no inline script/handler attributes |  |
| SEC02 | PASS | Passcode brute force is throttled per client+meeting (8 failures -> 429); other clients unaffected | 403,403,403,403,403,403,403,403,429,429 |
| SEC03 | PASS | Rate limits are keyed on the real client address behind a proxy (X-Forwarded-For) - one noisy client cannot starve others | limited 10/100 for the noisy client only |
| SEC04 | PASS | WebSocket authorization: no/forged/expired/foreign-secret tokens are refused; cross-meeting REST access is refused |  |
| SEC05 | PASS | Host-only actions are enforced server-side (notes, polls, end, lock refused for guests) |  |
| SEC06 | PASS | Socket flood control: events beyond the per-socket budget are refused with "Rate limited" | refused 30/70 |
| SEC07 | PASS | SQL injection probes are inert (parameterised queries; no 500s, tables intact) |  |
| SEC08 | PASS | Bridge: wrong-length/prefix/empty secrets refused; bridge traffic has its own higher rate budget |  |
| SEC09 | PASS | Stored XSS: hostile chat text/display name never becomes markup or runs script (browser-verified, CSP active) | rendered inert as text |
| SEC10 | PASS | Logs contain no secrets (bridge secret, vault/escrow keys, JWT secret, host secrets) | scanned 13 KiB of logs |
| SEC11 | PASS | MAIN: login brute force is throttled; weak passwords refused; error text does not reveal which field was wrong | 401,401,401,401,401,429,429,429,429,429,429,429,429,429 |
| SEC12 | PASS | MAIN: cross-site request cannot use the session cookie (SameSite) - no state change from a hostile origin | cross-site POST outcome: blocked:Failed to fetch |
| SEC13 | PASS | Containers run unprivileged (MAIN, worker) |  |
| SEC14 | PASS | Application database roles are least-privilege (not superuser, no DDL, cannot drop tables) |  |
| SEC15 | PASS | Recovery responses are no-store; escrow is ciphertext at rest; invalid escrow key fails closed at startup |  |
