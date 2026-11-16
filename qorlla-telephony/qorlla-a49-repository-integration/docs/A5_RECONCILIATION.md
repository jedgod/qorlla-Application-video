# Reconcile A49 scaffold with the NEWER A5 telephone admission implementation

GitHub sources inspected on 2026-11-07:

- `main` @ `810e196349e00bd68befcf4b43ccdb3df80a3ae3`: Portal's legacy Twilio-facing
  phone routes; Meet does not contain A5.
- `feature/qorlla-meet-telephone-admission-meet`: has `server/phone.mjs`,
  `server/phone-lifecycle.mjs`, `server/phone-peer.mjs`, `server/phone-gateway-auth.mjs`,
  `server/shield-client.mjs`, `server/telephony/provider-contract.mjs` and
  `sql/v4_25_phone_verification_peer.sql`.
- `feature/qorlla-meet-telephone-admission`: associated telephone admission work.

## Production architecture decision

DO NOT apply A49's extra `a49_waiting_calls`/`a49_command_receipts` Meet tables to the A5
Meet branch. A5 already owns `phone_calls`, the canonical lifecycle, host decisions,
restricted verification-peer authentication, and media-admission guards. Duplicating them
would allow two sources of truth for host approval and connected status.

For **telephone admission into a Qorlla Meet session**, use the A5 lifecycle:

```
REQUESTED -> VERIFIED -> AWAITING_HOST -> APPROVED ->
MEDIA_CONNECTING -> MEDIA_CONNECTED -> TERMINATED
```

`phone-lifecycle.mjs` requires observed RTP counters, allowed codecs, encryption, and
fresh evidence; `phone-peer.mjs` provides one-time restricted signaling access. The
HMAC `MEDIA_VERIFIED` event in this main-branch scaffold is NOT a replacement for it.

For **native Qorlla user-to-user WebRTC calls**, use the existing Voice Engine; avoid SIP.
For **internal SIP endpoints**, extend the A4 gateway and bridge it into A5's verification
peer when needed. Only the gateway should handle SIP/RTP; Portal remains the
subscription/identity/ledger control plane.

For **external PSTN**, extend A5's `telephony/provider-contract.mjs` using its existing
`{internalExtensions, publicNumbers, pstn}` capabilities. Keep `VOICE_NUMBERS_ENABLED=false`,
`VOICE_PSTN_ENABLED=false`, and `PHONE_CARRIER=internal` until a licensed carrier/SBC,
number authority, fraud, emergency policy, billing and certification are complete.

## What A49 can contribute without duplicating A5

1. Portal-only outbox, billing reconciliation, release gates, tenant-checked call
   authorization, and reporting; map to A5 call IDs with a durable service-to-service
   idempotency key. Do NOT use an independent authoritative Meet call state.
2. Extend Portal's subscription authorization into the A5 gateway path with a trusted
   service identity, signed bearer / certificate binding and account suspension checks.
3. Add internal A4 command transport only after the real gateway implements its
   authenticated idempotent command API. Bridge A5's proof-of-media and recovery events
   into Portal's read-only call history, not the other way around.
4. Use a PostgreSQL outbox on each side with retries, leases, fencing and idempotent
   cross-service consumers; never join Portal and Meet databases in one transaction.
5. Add rated accounting and double-entry postings independently of subscription
   invoices. Ensure the carrier CDR settlement does not itself make a call connected.

## Suggested integration order

1. Create clean worktrees for both A5 branches, record their exact heads, compare
   against main, and resolve overlapping Meet migrations before running anything.
2. Test A5 on disposable PostgreSQL with Shield and physical browsers and SIP peer;
   keep live/public calling OFF.
3. Apply only the Portal-side non-overlapping A49 modules and tailor them to A5
   `phone_calls` service APIs. Do not install the A49 Meet shim.
4. Run end-to-end fault matrix, load, mTLS, encryption, failover and operations gates.
5. Introduce an approved wholesale SBC/carrier adapter after A5 internal certification.

This ZIP's `scripts/apply.mjs` is intentionally **main-only**. It refuses to run on an
A5 checkout that already contains `phone-peer.mjs`.
