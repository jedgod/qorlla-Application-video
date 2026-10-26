# Automated security verification

- Git HEAD: `16cfdc45038ed5de1f5a2da945fe4bfcaa6f8ec5` (branch release/qorlla-meet-v3.9.2-production-closure; source tree clean)
- Result: **14 passed, 1 failed** (automated controls only; not an independent review)

| ID | Result | Control | Detail |
|---|---|---|---|
| SEC01 | PASS | Meet serves an enforced CSP (script-src self, frame-ancestors none) and the page has no inline script/handler attributes |  |
| SEC02 | PASS | Passcode brute force is throttled per client+meeting (8 failures -> 429); other clients unaffected | 403,403,403,403,403,403,403,403,429,429 |
| SEC03 | PASS | Rate limits are keyed on the real client address behind a proxy (X-Forwarded-For) - one noisy client cannot starve others | limited 10/100 for the noisy client only |
| SEC04 | FAIL | WebSocket authorization: no/forged/expired/foreign-secret tokens are refused; cross-meeting REST access is refused | Bad "options.issuer" option. The payload already has an "iss" property. |
| SEC05 | PASS | Host-only actions are enforced server-side (notes, polls, end, lock refused for guests) |  |
| SEC06 | PASS | Socket flood control: events beyond the per-socket budget are refused with "Rate limited" | refused 30/70 |
| SEC07 | PASS | SQL injection probes are inert (parameterised queries; no 500s, tables intact) |  |
| SEC08 | PASS | Bridge: wrong-length/prefix/empty secrets refused; bridge traffic has its own higher rate budget |  |
| SEC09 | PASS | Stored XSS: hostile chat text/display name never becomes markup or runs script (browser-verified, CSP active) | rendered inert as text |
| SEC10 | PASS | Logs contain no secrets (bridge secret, vault/escrow keys, JWT secret, host secrets) | scanned 9 KiB of logs |
| SEC11 | PASS | MAIN: login brute force is throttled; weak passwords refused; error text does not reveal which field was wrong | 401,401,401,401,401,429,429,429,429,429,429,429,429,429 |
| SEC12 | PASS | MAIN: cross-site request cannot use the session cookie (SameSite) - no state change from a hostile origin | cross-site POST outcome: blocked:Failed to fetch |
| SEC13 | PASS | Containers run unprivileged (MAIN, worker) |  |
| SEC14 | PASS | Application database roles are least-privilege (not superuser, no DDL, cannot drop tables) |  |
| SEC15 | PASS | Recovery responses are no-store; escrow is ciphertext at rest; invalid escrow key fails closed at startup |  |
