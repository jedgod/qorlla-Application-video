# Qorlla Workplace v4.6 - Real provider and production certification

_Generated 2026-10-27T01:50:17.080Z by `node cert/build-v46-report.mjs` from evidence files._

## Decision: **FAIL**

- Branch `feature/qorlla-workplace-v4.6-provider-certification`, HEAD `5b2a334c9f3a9ffbe15ca0192197c17dbb9f886f`
- Base source SHA `e9878003952817b2216c251506e639b34bbe1238` (v4.5), evidence commit `5499d0a`
- The Meet production-closure branch was not modified; both stash entries were left untouched; nothing was pushed, merged, deployed, and no live payment, call or model request was made by this work.

| Gate | Status | Evidence / reason |
|---|---|---|
| P1 - Real AI provider: contracts, structured output, quality thresholds, injection, cost | **BLOCKED** | missing inputs: AI_LLM_API_KEY, AI_LLM_MODEL, AI_PRICE_IN_PER_MTOK, AI_PRICE_OUT_PER_MTOK, AI_DPA_APPROVED (cert/provider/ai-evidence.json) |
| P2 - Twilio: number, inbound/outbound authorised calls, signed webhooks, voicemail, handoff, usage | **BLOCKED** | missing inputs: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_TEST_FROM, TWILIO_TEST_TO, PORTAL_PUBLIC_URL, PORTAL_OWNER_COOKIE, PORTAL_OWNER_CSRF, PORTAL_WORKSPACE_ID, DATABASE_URL, TWILIO_INTERACTIVE (cert/provider/twilio-evidence.json) |
| P3 - Stripe test mode: lifecycle, failures, refunds, usage billing, replay/reconciliation, ledger | **BLOCKED** | missing inputs: STRIPE_TEST_SECRET_KEY, STRIPE_WEBHOOK_SECRET, PORTAL_PUBLIC_URL, PORTAL_OWNER_COOKIE, PORTAL_OWNER_CSRF, PORTAL_WORKSPACE_ID, PORTAL_ADMIN_COOKIE, PORTAL_ADMIN_CSRF, DATABASE_URL (cert/provider/stripe-evidence.json) |
| P4a - Load test on the candidate | **FAIL** | targets missed: L1 meeting creation, L2 concurrent joins, L4 scheduling throughput (host: 4 CPUs, win32; a loaded developer machine is not a production-like host - rerun on one before deciding) (cert/LOAD_EVIDENCE.json) |
| P4b - Backup and restore of MAIN and Meet databases, encrypted secret restoration | **PASS** | cert/BACKUP_RESTORE_EVIDENCE.json |
| P4c - Portal database restoration and key recovery tested | **BLOCKED** | portal database restore test not recorded in cert/provider/ops-approvals.json (ops-approvals.json#portalRestore) |
| P4d - RPO/RTO documented and approved; automated backup monitoring in place | **BLOCKED** | approved RPO/RTO and backup monitoring not recorded in cert/provider/ops-approvals.json (ops-approvals.json#rpoRto) |
| P4e - Physical-device audio/video and responsive UI testing | **BLOCKED** | physical-device results (>= 3 devices) not recorded in cert/provider/ops-approvals.json (ops-approvals.json#devices) |
| P4f - Independent security review signed; no open release-blocking findings | **BLOCKED** | signed independent security review not recorded in cert/provider/ops-approvals.json (ops-approvals.json#securityReview) |
| R1 - v4.5 regression evidence still valid (portal, Meet, security, proxy, browser) | **PASS** | cert/WORKPLACE_V4_5_REPORT.json (SHA e9878003952817b2216c251506e639b34bbe1238) |

## What exists now

- `cert/provider/run-ai-cert.mjs` - real-provider run on a synthetic evaluation set with documented thresholds (`--self-test` validates the scorer only).
- `cert/provider/run-twilio-cert.mjs` and `run-stripe-cert.mjs` - credential-gated certification runners. They are written to the providers' documented contracts but have **never been executed against a real account**; expect first-run corrections. They refuse to run without all inputs, and the Stripe runner refuses live keys.
- This builder, and `cert/provider/ops-approvals.example.json`, the form in which humans record device results, the independent review, RPO/RTO approval and restore tests.

## Exactly what is needed to unblock

- **P1** - missing inputs: AI_LLM_API_KEY, AI_LLM_MODEL, AI_PRICE_IN_PER_MTOK, AI_PRICE_OUT_PER_MTOK, AI_DPA_APPROVED
- **P2** - missing inputs: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_TEST_FROM, TWILIO_TEST_TO, PORTAL_PUBLIC_URL, PORTAL_OWNER_COOKIE, PORTAL_OWNER_CSRF, PORTAL_WORKSPACE_ID, DATABASE_URL, TWILIO_INTERACTIVE
- **P3** - missing inputs: STRIPE_TEST_SECRET_KEY, STRIPE_WEBHOOK_SECRET, PORTAL_PUBLIC_URL, PORTAL_OWNER_COOKIE, PORTAL_OWNER_CSRF, PORTAL_WORKSPACE_ID, PORTAL_ADMIN_COOKIE, PORTAL_ADMIN_CSRF, DATABASE_URL
- **P4c** - portal database restore test not recorded in cert/provider/ops-approvals.json
- **P4d** - approved RPO/RTO and backup monitoring not recorded in cert/provider/ops-approvals.json
- **P4e** - physical-device results (>= 3 devices) not recorded in cert/provider/ops-approvals.json
- **P4f** - signed independent security review not recorded in cert/provider/ops-approvals.json

## Failures

- **P4a** - targets missed: L1 meeting creation, L2 concurrent joins, L4 scheduling throughput (host: 4 CPUs, win32; a loaded developer machine is not a production-like host - rerun on one before deciding)

