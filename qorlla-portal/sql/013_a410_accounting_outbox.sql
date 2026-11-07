-- Accounting notifications only; Meet remains authoritative for call state.
BEGIN;
CREATE TABLE portal.a410_accounting_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  topic text NOT NULL CHECK (topic IN ('accounting.rating_recorded', 'accounting.cdr_recorded')),
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner uuid,
  lease_token uuid,
  lease_until timestamptz,
  delivered_at timestamptz,
  dead_lettered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL)
      OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (delivered_at IS NULL OR dead_lettered_at IS NULL)
);
CREATE INDEX a410_accounting_outbox_due ON portal.a410_accounting_outbox(next_attempt_at, id)
  WHERE delivered_at IS NULL AND dead_lettered_at IS NULL;
COMMIT;
