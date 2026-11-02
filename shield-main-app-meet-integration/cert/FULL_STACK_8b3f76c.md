# Full-stack certification - exact SHA 8b3f76c9505bf9e209612649be46e2a8a294a8f8

Branch `feature/qorlla-workplace-v4.6-provider-certification`. Source tree was clean when the run started (the only modified files afterwards are this run's own evidence outputs, committed separately as the evidence commit; they are not part of the tested code). This record is frozen: later work is a different SHA with its own report.

## Fingerprints
| Item | Value |
|---|---|
| docker-compose.yml sha256 (first 16) | 1395e0d85b3eafa8 |
| nginx config (snippets + templates) | a6f694eb6944399d |
| Dockerfiles (MAIN + portal) | fd46476838055713 |
| Images | workspace-signaling-engine 97e3977512cc, qorlla-portal bcf1e6a7657d, meet 7f5efd812682, meet-sync-worker 0b9d3081ba40 |
| Portal migrations present | 001_portal, 002_billing, 004_meeting_ai, 005_phone, 006_workspace_tools, 007_billing_launch |
| Browser | Playwright Chromium, HTTPS reverse proxy origin (self-signed), fake media devices |

## PASS
* Root Playwright suite against standalone MAIN: **70 / 70** (guest security 19, Welcome 12, wiring 8, existing meeting/product/i18n/workspace suites).
* Portal node:test suites (real PostgreSQL): **168 / 168**.
* Stack: D01 compose valid + restart policies; D02 all services healthy; D03 single HTTPS entry; D04 unprivileged containers, JSON logs, no secrets in logs; D05 least-privilege DB roles; D06 portal fails closed then 401; D07 restart resilience; D08 admin console/metrics not public; D09 private metrics.
* Browser E2E through the unified HTTPS origin: **38 passed** - database-backed pricing (monthly/annual/seats/unavailable states), checkout and webhook (payment provider is a local TEST DOUBLE), portal sign-in/onboarding/authorization, token renewal and sign-out, billing, notes/documents/sheets/slides, QorllaMate approval flow (model is a TEST DOUBLE), phone page and receptionist (telephony OFF), plan limits, navigation/keyboard/mobile/tablet layouts, Meet under /meet/ (two browsers, websocket upgrade, passcode, rejoin), meeting-to-report workflow (model is a TEST DOUBLE).

## FAIL
* `navigation.spec.js:65` "legacy pages keep working ... /login.html": **stale test expectation, not a confirmed product defect.** `/login.html` now deliberately hands off to the main page (sign-in merge); the sign-in form is inside an iframe that `body` text does not include. `/login.html?standalone=1` is the supported compatibility route. Correction pending in a later commit.

## NOT RUN (through the unified HTTPS origin)
* Guest Welcome / Join / Pre-Join, meeting passcode and lockout, host-only invitations, guest-session security and legacy-API protection were verified only by the root suite against standalone MAIN on HTTP. They have **not** been exercised through the nginx HTTPS origin or in the container.
* Passcode lockout across a MAIN restart (not durable at this SHA: **confirmed code-review finding**), concurrent attempts, WebSocket passcode bypass over the proxy, password-reset token expiry and reuse, session invalidation after password change, CSRF/CORS/cookie checks over HTTPS, invitation abuse at scale.
* Backup/restore and load for this SHA.

## BLOCKED (no evidence exists; never inferred from test doubles)
SMTP delivery, real AI model, Twilio calling, Stripe test-mode transactions, physical-device testing, independent security review, production-like load, approved backup and recovery operations, real-provider billing and telephony activation.

## Known findings at this SHA
1. Meeting passcode lockout is in process memory and resets on restart (FAIL, to be fixed with the approved dual-adapter store).
2. MAIN meetings (4-32 chars, scrypt) and Meet meetings (up to 100 chars, bcrypt, passcode hash supplied by MAIN for scheduled meetings) use different passcode policies; to be documented and tested independently.
3. No waiting room / host admission exists in MAIN.

## Decision at this SHA
Functional stack checks PASS except one stale test; **security closure FAIL (finding 1); production BLOCKED.** Nothing was pushed, merged, deployed, billed or telephony-enabled.
