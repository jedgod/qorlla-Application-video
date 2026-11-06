-- Qorlla Subscription Access - 003 billing-provider-neutral inbox / outbox
-- No payment collection happens here. This stores verified provider events idempotently and
-- publishes downstream notifications durably.

-- Maps a provider's customer reference to a Qorlla customer. Written ONLY by an authenticated
-- administrative action, never by a webhook, so a webhook cannot attach itself to a tenant.
CREATE TABLE IF NOT EXISTS billing_customers (
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  external_customer_id text NOT NULL CHECK (char_length(external_customer_id) BETWEEN 1 AND 200),
  customer_id uuid NOT NULL,
  linked_by text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, external_customer_id),
  UNIQUE (provider, customer_id)
);

-- Transactional inbox: one row per provider event id, processed at most once to 'applied'.
CREATE TABLE IF NOT EXISTS billing_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  event_id text NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 200),
  event_type text NOT NULL,
  revision bigint,
  customer_id uuid,
  raw_sha256 text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','applied','stale','ignored','failed','dead')),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, event_id)
);
CREATE INDEX IF NOT EXISTS billing_inbox_status_idx ON billing_inbox (status, received_at) WHERE status IN ('received','failed');

-- Durable outbox: written in the SAME transaction as the state change, drained by a publisher.
CREATE TABLE IF NOT EXISTS billing_outbox (
  id bigserial PRIMARY KEY,
  dedupe_key text NOT NULL UNIQUE,
  topic text NOT NULL,
  customer_id uuid,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX IF NOT EXISTS billing_outbox_pending_idx ON billing_outbox (id) WHERE published_at IS NULL;
