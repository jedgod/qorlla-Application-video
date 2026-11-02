-- REFERENCE MIGRATION ONLY. Adapt to real engine schema before applying.
-- Existing account IDs are TEXT; calls and room IDs in the engine are UUID.
-- Never apply this in production without reconciliation to existing wallet/ledger/outbox tables.
BEGIN;
CREATE TABLE IF NOT EXISTS a38_corridors (
 origin char(2) NOT NULL, destination char(2) NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 PRIMARY KEY(origin,destination)
);
CREATE TABLE IF NOT EXISTS a38_quotes (
 id uuid PRIMARY KEY, account_id text NOT NULL, tenant_id text NOT NULL,
 number_e164 text NOT NULL, origin char(2) NOT NULL, destination char(2) NOT NULL,
 currency char(3) NOT NULL, price_per_minute_minor bigint NOT NULL CHECK(price_per_minute_minor>0),
 connection_fee_minor bigint NOT NULL CHECK(connection_fee_minor>=0),
 expires_at timestamptz NOT NULL, used boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS a38_calls (
 id uuid PRIMARY KEY, account_id text NOT NULL, tenant_id text NOT NULL,
 quote_id uuid NOT NULL REFERENCES a38_quotes(id), number_e164 text NOT NULL,
 currency char(3) NOT NULL, reserved_minor bigint NOT NULL CHECK(reserved_minor>=0),
 charged_minor bigint CHECK(charged_minor>=0), caller_id text,
 status text NOT NULL CHECK(status IN ('queued','dispatching','connected','settled','failed')),
 idempotency_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS a38_carrier_events (
 provider_event_id text PRIMARY KEY, call_id uuid NOT NULL REFERENCES a38_calls(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS a38_vouchers (
 id uuid PRIMARY KEY, pin_hash text NOT NULL UNIQUE,
 currency char(3) NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0),
 status text NOT NULL CHECK(status IN ('inactive','active','redeemed','expired','void')),
 expires_at timestamptz NOT NULL, redeemed_by text, redeemed_at timestamptz
);
CREATE TABLE IF NOT EXISTS a38_voucher_redemptions (
 account_id text NOT NULL, idempotency_key text NOT NULL,
 voucher_id uuid NOT NULL REFERENCES a38_vouchers(id),
 PRIMARY KEY(account_id,idempotency_key), UNIQUE(voucher_id)
);
-- Integrator MUST add FKs to real identities, least-privilege grants, RLS where applicable,
-- durable wallet ledger, reconciliation, rate snapshot, webhook inbox and existing outbox.
COMMIT;
