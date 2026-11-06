# Automated security verification

- Git HEAD: `c1847ea7a7e7fea96e97d30e6eab88df2a7ab49f` (branch ; source tree DIRTY: M cert/README.md,  M cert/run-security.mjs,  M cert/stack-down.ps1,  M cert/stack-up.ps1,  M docker-compose.yml)
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
| SEC10 | PASS | Logs contain no secrets (bridge secret, vault/escrow keys, JWT secret, host secrets) | scanned 3 KiB of logs |
| SEC11 | PASS | MAIN: login brute force is throttled; weak passwords refused; error text does not reveal which field was wrong | 401,401,401,401,401,429,429,429,429,429,429,429,429,429 |
| SEC12 | PASS | MAIN: cross-site request cannot use the session cookie (SameSite) - no state change from a hostile origin | request completed as a cross-site POST; browser omitted the session cookie and the session remained active |
| SEC13 | PASS | Containers run unprivileged (MAIN, worker) |  |
| SEC14 | PASS | Application database roles are least-privilege (not superuser, no DDL, cannot drop tables) |  |
| SEC15 | PASS | Recovery responses are no-store; escrow is ciphertext at rest; invalid escrow key fails closed at startup |  |
