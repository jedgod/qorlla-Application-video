# Security review - Workplace v4.2 to v4.5

**This is the AUTHOR'S review**, performed by the engineer (an AI assistant) who wrote the code. It is a structured self-review plus the automated
tests listed below. It is **not** an independent security assessment and does not replace one; the independent review and a penetration test remain **BLOCKED**
until a qualified third party is engaged (see the release report).

Scope: `qorlla-portal/server/**` (meeting AI, phone/receptionist, notes/documents/assistant, billing operations, admin console), their SQL migrations,
the nginx routing for them, and the browser UI. Out of scope: the Meet service and MAIN (covered by the v3.9.2 review), third-party services.

## 1. Method

1. Threat model per feature (who can call it, what it costs, what it can read or change, what an attacker controls).
2. Line-by-line review of every route registration (`docs/API_CONTRACT.md` is generated from them) for authentication class, workspace scoping, role checks, input validation and error behaviour.
3. Adversarial tests written for each threat, run against real PostgreSQL (`qorlla-portal/tests/*.test.mjs`) and, for the cross-user cases, in a real browser (`qorlla-portal/e2e/*.spec.js`).
4. Test doubles stand in for Stripe, Twilio and the language model. They prove **our** handling of provider traffic, not the providers' behaviour.

## 2. Findings that were fixed during this work

| # | Severity | Finding | Fix | Evidence |
|---|---|---|---|---|
| F1 | High (availability) | `GET /app` redirected to `/app/` and `/app/` matched the same Express route, so the portal root looped forever (the first full browser run found it) | exact-path regex route | `navigation.spec.js` "every internal link ... resolves" |
| F2 | Medium (integrity) | Action-item due dates entered in time zones behind UTC were stored as the next day (23:59 local -> next-day UTC) and displayed a day late after reload | store the date as noon UTC | `meeting-ai.spec.js` due-date assertion |
| F3 | Medium (cost abuse) | No per-user limit on endpoints that cost money (model calls, AI drafts, meeting-AI jobs, click-to-call, refunds) | per-user limiters (30/10/10/6/10 per minute) and a per-IP limiter on provider webhooks; refused requests do no work | `limits.test.mjs` |
| F4 | Medium (availability/integrity) | The global 128 kB JSON limit made documents and transcript imports fail well below their documented limits (200k/500k characters) | 2 MB limit on those routes only; oversized bodies return JSON 413 instead of 500 | `limits.test.mjs` |
| F5 | Low | The platform admin console required the admin to belong to a workspace | admin route handled before the onboarding gate | `billing-launch.spec.js` |
| F6 | Low | Pricing header overflowed the page on phone widths (usability/accessibility) | wrapping header | `navigation.spec.js` phone layout |

## 3. Controls verified by tests

| Area | Control | Test |
|---|---|---|
| Telephony | Every provider callback must carry a valid `X-Twilio-Signature` over the public URL **built from configuration** (never from the Host header); a signature for one endpoint is useless on another; replays are idempotent (`telephony_events`) | `phone.test.mjs` "webhook security", "call status" |
| Telephony | OFF by default; compliance acknowledgement required even with credentials; numbers cannot be activated while off; no fake calls | `phone.test.mjs` "off by default" |
| Telephony | Recording only after the recording notice was played; recording callbacks for calls without a notice are ignored | `phone.test.mjs` "inbound call flow" |
| Telephony | The provider's recording URL is only fetched with our credentials when its origin equals the provider API origin (no credential exfiltration) | `phone.test.mjs` "recording URLs outside the provider are refused" |
| Telephony | Toll-fraud guard: premium-rate/emergency numbers never dialled, international off by default, outbound only for workspace members, plan minutes cap | `phone.test.mjs` "outbound calling" |
| Telephony | Voicemail audio proxied only after the caller's own permission check; managers only | `phone.test.mjs` "voicemails" |
| Documents/notes | Private by default; unauthorised access answers **404** (existence not revealed); workspace admins cannot read private notes/unshared documents; sharing limited to workspace members; revocation immediate; restore creates a new immutable version | `workspace-tools.test.mjs` |
| Assistant | The model can only **propose**; each task needs a human approval; email is blocked (no provider); retrieved workspace text is passed as untrusted data and another user's private content never reaches the model; injection that makes the model "obey" still yields only a blocked proposal | `workspace-tools.test.mjs` "prompt injection", "retrieval only uses what the caller may read" |
| Billing | Plans change only after the provider is re-read and matches the price snapshot; client-supplied prices ignored; failed/unconfirmed changes leave the plan alone; downgrade cannot strand members | `billing-launch.test.mjs` "plan changes" |
| Billing | Overage needs paid plan + explicit opt-in + published price + switch ON; prices ship empty; per-event price snapshot; month-end provider item idempotent | `billing-launch.test.mjs` "usage-based AI billing" |
| Admin | Platform console invisible (404) to everyone not in `PLATFORM_ADMIN_USER_IDS`; unauthenticated 401; refunds idempotent and audited; kill switches need a reason and are audited | `billing-launch.test.mjs`, `billing-launch.spec.js` |
| Operations | `/internal/metrics` needs a bearer token (>= 24 chars, constant-time compare), is not routed by nginx, and exposes no secrets or personal data | `billing-launch.test.mjs`, runner checks D08/D09 |
| Data | Migrations are idempotent and reversible; check constraints reject invalid states in the database itself | `migrations.test.mjs` |

## 4. Residual risks and open items (not fixed)

| # | Risk | Severity | Recommendation |
|---|---|---|---|
| R1 | **No live provider verification.** Stripe plan changes use `price_data` + the existing product id and `/v1/refunds`, `/v1/invoiceitems`; Twilio signatures, TwiML and recording downloads; the Anthropic request/response shape. All were implemented from the providers' documented contracts and exercised only against test doubles | High until verified | run the live-verification checklist in `docs/RUNBOOK.md` in provider **test mode** before any production enablement |
| R2 | Recording / voicemail consent law differs by jurisdiction; the product plays a configurable notice and records nothing without it, but cannot decide what is legally sufficient | High (legal) | legal review; the `TELEPHONY_COMPLIANCE_ACK` gate exists to force that decision |
| R3 | Platform admin is a static allowlist of MAIN user ids with no step-up (MFA) for refunds or switches | Medium | add MFA/IP allow-listing for `/api/v1/admin`, or put the console behind VPN/SSO |
| R4 | Voicemail audio/transcripts and call records have no automatic retention purge (meeting transcripts do: 90 days) | Medium (privacy) | define and implement retention; the delete endpoint exists for manual removal |
| R5 | Rate-limit counters are in process memory; with several portal replicas the effective limit is multiplied | Low/Medium | shared store (Redis/Postgres) when scaling out |
| R6 | Transcripts, notes and documents are stored unencrypted at the application layer (disk/volume encryption is the operator's responsibility) | Medium | volume encryption; consider field-level encryption for transcripts |
| R7 | The MRR shown to admins is an estimate from list prices, not accounting data | Low | reconcile with the provider's reporting |
| R8 | Overage invoice items are attached to the customer's next invoice by the provider; behaviour when a customer has no upcoming invoice (cancelled mid-month) is unverified | Medium | verify in provider test mode; handle `usage_overage_events` for cancelled subscriptions explicitly |
| R9 | No malware scanning on content; documents are stored as JSON and shown in form controls (never rendered as HTML), so stored XSS is not possible by construction, but AI output is displayed as plain text only for the same reason - keep it that way | Info | n/a |
| R10 | `npm audit` / dependency review: see the release report for the result of the audit run at certification time | Info | run in CI |
| R11 | Independent review and penetration test not done | High for production | engage a third party |

## 5. Conclusion

No known unmitigated critical or high-severity defect in the reviewed code **as tested with doubles**. The residual high risks (R1, R2, R11) are about unverified external dependencies and
legal obligations, which is why the release gate for production is **BLOCKED** (see the release report) while the staging gate can pass.
