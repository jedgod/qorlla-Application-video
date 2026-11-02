# Real Qorlla repository integration map
Repository: https://github.com/jedgod/qorlla-Application-video
Baseline inspected: main at 810e196349e00bd68befcf4b43ccdb3df80a3ae3

- MAIN identity: `qorlla-portal/server/auth.mjs` — MAIN JWKS session cookie; do not replace with app-managed tokens.
- Billing: `qorlla-portal/server/billing/routes.mjs`, `stripe.mjs`, `service.mjs` — preserve idempotency and provider webhooks.
- Telephony: `qorlla-portal/server/telephony/twilio.mjs`, `routing.mjs`, `worker.mjs` — never route PSTN directly from client.
- Meeting directory: `meet-sync/sql/006_meeting_directory.sql` — use authorized diagnostics.
- Reverse proxy: `deploy/nginx/` — protect installer distribution and backend origin.

These are integration targets, not completed integrations. Current feature branches must be reconciled before merging. Do not overwrite main or release tags.
