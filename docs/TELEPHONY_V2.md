# Qorlla Phone v2.0: production telephony integration

**Verdict: NOT production-ready.** The software foundation, the carrier adapter, the provisioning / calling / billing workflows and the fail-closed controls are built and tested against a local stand-in for the carrier. **Nothing has been run against a real carrier, a real number, a real call or real audio.** There is no media gateway. The seven certification phases (T01-T07) below are the work that remains, and they need things this repository cannot contain: a carrier account, a SIP/RTP media gateway, real telephones, and a person to sign off the evidence.

Source of the design: the `qorlla-telephony-v2` reference package (core rules, provider interface, service intents, migration draft) and the "Production Telephony Integration" instructions. The package was integrated, not copied: this repository has no workspaces or roles, so rows belong to a Qorlla account id and administrators are named by the server owner.

## 1. Where things live

```
Browser (qorlla.html: Phone, Numbers & Plans)
  -> Main app  (server.js /api/phone/*)        session auth; decides who is an administrator (PHONE_ADMIN_USERS); never trusts the browser for identity
  -> Qorlla Meet bridge  (/api/integrations/telephony/*, bridge secret)
        server/telephony/{core,provider,twilio,service,ivr,routes}.mjs      PostgreSQL: sql/v4_14_telephony.sql
  <- Carrier webhooks  (/api/telephony/webhooks/twilio/{voice,status}, signed)
        server/phone.mjs (existing PIN, waiting room, host controls, recording consent, attendance, history) is reused unchanged by the IVR
  X  Media gateway (SIP/RTP <-> Qorlla Meet WebRTC)      NOT BUILT. Interface only: UnconfiguredBridge
  X  Browser voice gateway (browser audio for outbound calls)   NOT BUILT. Interface only: UnconfiguredAudioGateway
```

Meet owns telephony because Meet owns PostgreSQL, the meeting rules and the participant roster. The main app is a thin authenticated pass-through.

## 2. Configuration

| Variable | Where | Meaning |
|---|---|---|
| `PHONE_CARRIER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Meet | Carrier credentials. Server-side only; never logged, never in an API result. Unset = the inert adapter. |
| `TWILIO_API_BASE` | Meet | Default `https://api.twilio.com`. Tests point it at a local stand-in. |
| `PHONE_PUBLIC_BASE` | Meet | The public **https** address Twilio calls (no port: for HTTPS voice callbacks Twilio signs the URL without one). Required for webhook verification and provisioning callbacks. |
| `PHONE_ADMIN_USERS` | Main | Comma list of usernames (a trailing `*` is a prefix) allowed to manage numbers, limits, usage and billing. Empty = nobody. |
| `PHONE_FEATURES` | Meet | Independent feature flags, a comma list of `dialin`, `carrier`, `bridge`, `billing`, `settings`. **Default: none.** A capability is active only with its flag AND its certified gate AND live evidence. |
| `PHONE_ALLOWED_COUNTRIES` | Meet | Default `US,CA,GB`. Eligibility for number requests and the only countries that can be dialled. |
| `PHONE_MAX_CALLS_PER_HOUR` | Meet | Default 30 call intents per account. |
| `PHONE_RESERVE_MICROS` | Meet | Amount held per in-flight call against the monthly limit. Default 500000 (0.50). |
| `PHONE_MARKUP_PERCENT`, `PHONE_TAX_PERCENT` | Meet | Customer charge = provider cost + markup; tax on the charge. Defaults 0. A flat percentage is not a tax engine: see gaps. |
| `PHONE_RECONCILE_DELAY_S`, `PHONE_RECONCILE_TOLERANCE_S` | Meet | Wait before asking the carrier for the final price (default 120 s); allowed difference between the carrier's and Qorlla's call duration (default 5 s). |
| `PHONE_WORKER_MS` | Meet | Worker interval (default 15000). Workers only run when a carrier is configured. |
| `SUPPORT_EMAIL` | Main | Optional: support tickets are also emailed here. |

Database: `qorlla-meet-video/sql/v4_14_telephony.sql` (idempotent; applied by `npm run dev:stack`; add it to the production migration order **before** `005_app_role.sql`, which grants the application role on tables that exist when it runs).

## 3. A status is evidence, not configuration

Every status on Numbers & Plans is derived by `deriveCapabilities` from stored evidence. Having credentials changes nothing by itself.

| Capability | Active only when |
|---|---|
| Provider | The carrier API health check **succeeded** (Test connection) **and** a **signed** webhook has been received. API ok but no webhook = *Pending*. |
| Dial-in numbers | Provider active **and** at least one carrier-confirmed shared number **and** gate `dialin` certified. |
| Carrier calling | Provider active **and** gate `carrier` certified. |
| Your Qorlla number | A personal number exists, was confirmed by the carrier, and is assigned to the account. |
| Audio bridge | A media bridge is installed **and** gate `bridge` certified. None is installed. |
| Billing | Gate `billing` certified **and** at least one usage record reconciled with the carrier's price. |

Phone-meeting join (`phoneMeetingJoinEnabled`) needs provider + dial-in + bridge. The six are **independent gates**: ordinary calling can be certified without meeting dial-in, and neither without billing.

Recording gates uses `scripts/phone-certify.mjs`, run by a person with the evidence file after the real test passes. There is no API or button for it:

```
DATABASE_URL=... node scripts/phone-certify.mjs --list
DATABASE_URL=... node scripts/phone-certify.mjs carrier --evidence ./evidence/T03-report.pdf --by "Name"
DATABASE_URL=... node scripts/phone-certify.mjs --revoke carrier --by "Name"
```
(Run as the database **owner**; the application role cannot DELETE.) The evidence file's SHA-256 and the person are stored and audited.

## 4. What fails closed (and is tested)

- No carrier / no health check / no verified webhook: nothing is provisioned, dialled or shown as connected.
- Inbound IVR: a number that is not one of ours is rejected. Without an installed **and** certified bridge, a caller hears "Joining meetings by telephone is not available yet" and the call ends; no PIN is asked. The bridge is asked to join only **after** the existing Qorlla rules say *connected* (PIN, attempt limits, waiting room, host admit/deny, lock, end).
- Invitations, phone-PIN invitations and the Join page do not present dial-in numbers as usable until phone joining is fully enabled.
- Outbound: carrier gate, billing gate, a voice gateway, an owned active number, a destination that passes the screen, a per-hour rate limit and a spending limit are **all** required. No limit set = paid calling is off. A retry with the same idempotency key never places a second call.
- Destination screen: premium-rate, satellite and special prefixes blocked; emergency numbers refused; only allowed countries.
- Webhooks: Twilio signature (HMAC-SHA1 over the URL and sorted parameters, checked against Twilio's published worked example in `tests/telephony.spec.js`), de-duplicated by event id, late and out-of-order events can never move a call backwards, PINs are never stored.
- Billing: the carrier's price and duration are authoritative. Qorlla's observed duration must match within tolerance or the record is *disputed*, not billed silently. Provider cost and customer charge are separate columns. Refunds and adjustments are new rows.
- Everything administrative checks `admin` server-side; accounts see only their own calls, usage and numbers.

## 5. Phases

| Phase | Deliverable | Status |
|---|---|---|
| T01 Provider connection | Authenticated carrier API, verified webhooks | **Code done, tested against a stand-in.** Needs a real Twilio account, a public https `PHONE_PUBLIC_BASE`, Test connection and a real signed callback. |
| T02 Number provisioning | Real number purchased, recorded, assigned | **Workflow done and tested** (request, eligibility, asynchronous worker, idempotency, confirmation, assignment, suspend/release/reassign). Needs a real purchase, and per-country regulatory requirements (some countries require address or identity bundles). |
| T03 Carrier calling | Inbound and outbound calls complete | **Backend done and tested** (intents, workers, status events, fraud and spending controls). Outbound needs a **browser voice gateway** that does not exist; inbound dial-in needs the T05 bridge. |
| T04 Meeting phone access | IVR resolves 11-digit IDs and PINs | **IVR done and tested** with the existing PIN rules. Cannot be used by real callers until T05. |
| T05 Audio bridge | Real two-way telephone-to-meeting audio | **NOT BUILT.** Interface only. See section 6. |
| T06 Billing | Provider charges reconciled and attributed | **Ledger and reconciliation done and tested** against the stand-in. Needs real carrier usage, real tax rules and an invoice system. |
| T07 Certification | Security, reliability, accessibility, operations | **Not started.** |

## 6. The audio bridge: what is actually needed

Adding a SIP server does not make telephone audio audible to meeting participants. Qorlla Meet has its own WebRTC signalling and peer connections, so a bridge must: terminate SIP/RTP from the carrier, transcode (G.711/Opus), join the Meet room as a participant, mix/forward audio both ways, relay DTMF, and obey admit, mute, remove, lock and meeting end. LiveKit SIP or similar only fits if Meet's media path is moved onto the same SFU; otherwise a purpose-built gateway is required. When one exists it implements `join({ callSid, meetingId, callRef })` (returning carrier markup such as `<Dial><Sip>`) and `ready`; the rest of the system is already wired to ask it **only after** the meeting rules admit the caller. Mute at the bridge (today recorded and announced only) and phone-audio recording (none today) also depend on it.

## 7. Certification checklist (what "done" must include)

Real carrier calls (inbound and outbound); valid and invalid meeting IDs; PIN attempts and lockout; host admission; meeting lock; call termination from every side; duplicate and out-of-order webhooks from the real carrier; billing reconciliation against a real invoice; carrier outage and recovery; country restrictions; codec, jitter, reconnect, DTMF, echo, level and multi-caller audio tests; load of simultaneous callers; accessibility and screen-reader checks; emergency-calling and caller-ID regulatory review; privacy and retention review; backup/restore; alerting on worker failure and stale provisioning (`STALE_NEEDS_REVIEW`).

## 8. Known gaps (honest list)

No media bridge; no browser voice gateway; no real-carrier run of anything; taxes are a flat percentage (no jurisdiction logic, no VAT handling); no invoice system (references stay empty); no number porting; no SMS; no caller-ID verification flow beyond an administrator flag; no organization hierarchy (extensions, queues, business hours, routing); admin is a server-owner list, not a role system; carrier suspension of an account is detected only when Test connection (or a later health check) runs; Edge, Safari and screen-reader audit not done; Firefox covers only part of the UI tests.

## Update (v2.2)

New in v2.2: independent feature flags (`PHONE_FEATURES`), per-preference activation with carrier read-back and drift detection (`sql/v4_15_telephony_features.sql`; the Twilio adapter supports none of these settings yet), and a support-ticket workflow with staff scope. See `PHONE_V2_2_HARDENING.md`. The bridge approach, based on an audit of Meet's mesh WebRTC design, is in `TELEPHONY_BRIDGE_ARCHITECTURE.md`.
