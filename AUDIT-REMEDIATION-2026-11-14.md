# Audit remediation — 14 November 2026

Source: `assess_audit_copilot-11-13-2026.txt`.

Disposition: local remediation; **public/production release remains NO-GO**. These source changes are not deployed. Earlier security-standing results do not certify this candidate. No protected services were intentionally stopped/restarted; no production migration, carrier enablement, merge, tag or deployment was performed.

## Implemented

| Finding | Change | Limits |
|---|---|---|
| Missing root UI | Restored index.html from byte-identical 1index.html / 2index.html. | Original snapshots retained. |
| Legacy meeting entry | Production disables root meeting APIs and inbound legacy socket events regardless of development flags. Legacy page redirects to configured Meet or reports unavailable. | Development rooms remain a prototype; never expose a development server publicly. |
| Host-only notes | Notes writes recheck server-derived host ownership; guest-denial/host-acceptance regression added. | Authenticated Meet is a separate service. |
| Legacy abuse | Chat history capped at 200, documents at 100, payloads at 64 KiB; per-socket event/signaling budgets and malformed-payload checks. | Not enterprise persistence. |
| Prototype APIs | Docs, appointments, post-meeting and notifications return 404 in production. | Mock services were not turned into production services. |
| UI initialization | Controls wait for initialization; new hosts reconnect sockets after receiving host cookies. | Prevents lost early clicks and stale host handshakes. |
| Signup | Persisted per-source attempt limit: 10/hour default; SIGNUP_LIMIT 1–100. Invalid attempts count before hashing. | Existing single-process JSON-store model. Disposable Playwright server explicitly uses 100. |
| Sessions | Default 12 hours; SESSION_TTL_HOURS 1–168. Own-session listing/deletion and logout-all APIs. Production cookies always Secure. | Existing sessions retain their recorded expiry until revoked/expired. No live accounts were forcibly revoked. |
| CSRF | Production cookie-authenticated API mutations require an HMAC token bound to the session. GET /api/auth/csrf is no-store. Browser fetch adds it only to same-origin API mutations. Origin checks remain. | Development retains prior origin checks for API compatibility. Production clients must send X-CSRF-Token. Per-process HMAC key assumes the current single-instance root deployment. |
| CSP | Fresh script nonce on root HTML; no unsafe-inline/eval scripts; object embedding denied and base/forms/framing constrained. nginx HTML now proxies through Node. | Inline CSS remains permitted. |
| Phone ledger | Non-lab SIP startup, production HTTP startup and direct production admission fail closed without a durable shared ledger. PostgreSQL adapter declares durability. | The marker is a trusted adapter contract, not evidence of a deployed database. Lab mode does not waive readiness gates. |
| Phone documentation | README distinguishes implemented lab SIP/IVR/RTP/SRTP/mesh components from uncertified production PSTN. | All six gates still need independent evidence. |
| Meet signaling | Separate limits: 120 signals/second burst, 600/10 seconds sustained. | Requires large-room/load validation. |
| Meet credentials | Default expiry reduced from eight hours to one; JWT_TTL_MINUTES 5–480. | Refresh and general server-side revocation remain open. Clients may need to rejoin after expiry. |
| Dependencies | Root Multer and phone Zod upgraded; missing telephony lockfile generated. | Exact resolved versions are in lockfiles. |
| Build | Allowlisted .dockerignore excludes account data, secrets and unrelated snapshots. Root image defaults to production. | No image tagged/deployed. |
| TLS defaults | Production requires an HTTPS PUBLIC_URL; Compose requires explicit PROXY_TLS_CONF. Plain-HTTP proxy ports return 426 instead of serving the app. | Real certificates, edge behavior and nginx runtime still need deployment verification. |

## Validation

Results are appended after checks complete. Skipped integration cases are not passes; functional tests do not establish performance certification.

### Completed validation

- Root browser suite: **27 passed**, clean runner exit with normal Windows process permissions (1.8 minutes). Earlier restricted-shell runs completed all 27 tests but hung during Windows process-tree teardown; their timeout was not treated as a clean pass. Test-source quota isolation fixed the earlier full-suite guest-join failure. Browser fixtures explicitly disable inherited SMTP, database, encryption and bridge wiring.
- Production security regression: **1 passed** after HTTPS configuration enforcement. Covers production prototype/legacy denial, nonce CSP, CSRF enforcement, session lifetime/revocation and signup throttling. Command: `npm run test:security`.
- Meet: syntax checks and **4 tests passed**, including the separate signaling budget.
- Phone: TypeScript build and **153 passed, 0 failed, 66 skipped** after the dependency upgrade and recovery assertion correction (219 total). Skips include PostgreSQL, Redis, real Meet and heavy A5_E2E fixtures. The old fixed 800 ms ICE assertion was intermittent; the corrected test requires fresh tone evidence in both directions within a bounded recovery window. This is not latency certification or a claimed media-engine fix.
- Telephony: **54 passed, 0 failed, 6 skipped** (database fixtures absent).
- Production dependency audits: root, Meet, phone and telephony each returned **0 known vulnerabilities** after upgrades/lockfile generation. This is an npm advisory check, not a full image/SBOM or independent security audit.
- Compose syntax validation: `docker compose config --no-interpolate --quiet` passed without printing expanded secrets.
- Clean Docker build: **blocked**. Docker buildx returned `DeadlineExceeded: context deadline exceeded` / a closed Docker engine pipe. No successful image build or nginx runtime verification is claimed. Docker was not restarted.
- No performance/load/repeatability certification was performed. No carrier or physical-phone certification was performed.

Git was unavailable in the command environment; no clean-worktree or commit identity is asserted. `evidence/audit-2026-11-14/source-sha256.json` identifies the reviewed local source files. `security-standing.txt` retains the historical review with a current-source disclaimer.

## Remaining release blockers / actions

1. Implement/review host/admin MFA or passkeys with recovery and authenticated host integration. Decide and enforce verified-email requirements for privileged/external actions. Review the existing eight-character password policy and update UI/client requirements together.
2. Add durable participant/token revocation and refresh; enforce expiry/revocation on ongoing Meet sockets. Replace in-memory/meeting-wide join throttles with shared per-source backoff. Shorter issuance does not revoke existing credentials.
3. Constrain or replace single-process JSON persistence; implement retention, encrypted backup/restore tests, atomic cross-process quotas and operational monitoring before enterprise/multi-instance deployment.
4. Validate actual TLS edge, certificates, proxy trust boundaries, secrets, database roles and live headers. The accidental HTTP-only source fallback has been removed; source defaults do not establish deployment compliance. Configure the HTTPS URLs/certificates before starting this candidate.
5. Independently verify Shield migration 019 / alerts.report and lifecycle, durable PostgreSQL/Redis, carrier/public number, TLS/mTLS/SRTP, caller/trunk budgets, concurrency, billing, emergency/fraud policy, monitoring and runbooks. No production migration was attempted.
6. Run skipped PostgreSQL/Redis/real-Meet/A5_E2E cases on disposable isolated fixtures, physical-phone/carrier tests, valid load tests and independent repeatability on a stable host. Do not reuse protected databases without confirming isolation.
7. Scan every shipped artifact/image, exercise restoration and commission independent security review. Historical snapshots were not all upgraded or audited.

Prior Docker inspection located active services in other repositories/images. Fixing this workspace does not prove those running services contain these changes. Deployment remains separately controlled.

## Final source verification

The final browser rerun with the test-only PID launcher/teardown completed **27 passed, exit code 0 (2.7 minutes)**. The launcher records only its disposable server child, and teardown terminates that child without a public shutdown endpoint. Final Compose validation passed after making PUBLIC_URL required. All 32 source SHA-256 entries matched the manifest. No deployment or production certification is implied.

## Commit preparation

Git was subsequently found at its installed absolute path. Unrelated edits and pre-existing untracked projects are excluded from the remediation commit. The local telephony tree is untracked and is not being added wholesale; its generated lockfile and test results describe local validation, not a newly shipped telephony module. Source hashes identify local validation files and can include that untracked module. Original line endings were preserved on unchanged UI/test lines during commit preparation.
