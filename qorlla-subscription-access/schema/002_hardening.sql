-- Qorlla Subscription Access - 002 hardening
-- Constraints, reservation idempotency across ALL states, override history, and append-only
-- (immutable) audit/usage tables.

-- ---------------------------------------------------------------------------
-- Reservations: idempotency must hold in every state, not only while 'reserved'
-- (otherwise a retry after commit would consume the quota a second time).
-- ---------------------------------------------------------------------------
UPDATE quota_reservations SET idempotency_key = 'legacy:' || id::text WHERE idempotency_key IS NULL;
ALTER TABLE quota_reservations ALTER COLUMN idempotency_key SET NOT NULL;
ALTER TABLE quota_reservations ADD CONSTRAINT quota_reservations_idempotency_len CHECK (char_length(idempotency_key) BETWEEN 1 AND 200);

DROP INDEX IF EXISTS quota_reservations_idempotency_idx;
CREATE UNIQUE INDEX quota_reservations_idempotency_idx
  ON quota_reservations (customer_id, feature_key, idempotency_key);

ALTER TABLE quota_reservations ADD COLUMN IF NOT EXISTS max_expires_at timestamptz;
ALTER TABLE quota_reservations ADD COLUMN IF NOT EXISTS renewed_count integer NOT NULL DEFAULT 0;
ALTER TABLE quota_reservations ADD COLUMN IF NOT EXISTS late boolean NOT NULL DEFAULT false;
UPDATE quota_reservations SET max_expires_at = expires_at WHERE max_expires_at IS NULL;
ALTER TABLE quota_reservations ALTER COLUMN max_expires_at SET NOT NULL;

ALTER TABLE quota_reservations ADD CONSTRAINT quota_reservations_window CHECK (expires_at > reserved_at AND period_end > period_start);
ALTER TABLE quota_reservations ADD CONSTRAINT quota_reservations_max_expiry CHECK (expires_at <= max_expires_at);
ALTER TABLE quota_reservations ADD CONSTRAINT quota_reservations_committed_at CHECK ((status = 'committed') = (committed_at IS NOT NULL));

-- The sweeper looks for reserved rows whose time ran out.
CREATE INDEX IF NOT EXISTS quota_reservations_sweep_idx ON quota_reservations (expires_at) WHERE status = 'reserved';

-- ---------------------------------------------------------------------------
-- Usage: one usage row per reservation, sane window
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS usage_events_reservation_idx ON usage_events (reservation_id) WHERE reservation_id IS NOT NULL;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_window CHECK (period_end > period_start);
-- Usage is counted by when the operation started, whatever window was stored with the row.
CREATE INDEX IF NOT EXISTS usage_events_occurred_idx ON usage_events (customer_id, feature_key, occurred_at);

-- ---------------------------------------------------------------------------
-- Subscriptions: provider revision ordering + period sanity
-- ---------------------------------------------------------------------------
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_revision bigint NOT NULL DEFAULT 0 CHECK (provider_revision >= 0);
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_period_order CHECK (current_period_end > current_period_start);
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_provider_pair CHECK ((provider IS NULL) = (external_id IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_external_idx ON subscriptions (provider, external_id) WHERE provider IS NOT NULL;

-- Writers vs. in-flight reservations. A reservation holds a SHARED advisory lock on 'sub:<customer>' for its whole
-- transaction (readers do not need any write privilege for that). Every write to subscriptions or entitlement_overrides
-- takes the matching EXCLUSIVE lock here, in the database, so ANY writer (webhook worker, admin service, or a manual psql
-- session) waits for in-flight reservations and is waited for by new ones: a downgrade can never slip between a
-- reservation's entitlement check and its write.
CREATE OR REPLACE FUNCTION qorlla_lock_customer_trg() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN c := OLD.customer_id; ELSE c := NEW.customer_id; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sub:' || c::text, 0));
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscriptions_customer_lock BEFORE INSERT OR UPDATE OR DELETE ON subscriptions FOR EACH ROW EXECUTE FUNCTION qorlla_lock_customer_trg();
CREATE TRIGGER entitlement_overrides_customer_lock BEFORE INSERT OR UPDATE OR DELETE ON entitlement_overrides FOR EACH ROW EXECUTE FUNCTION qorlla_lock_customer_trg();

-- Keep updated_at honest.
CREATE OR REPLACE FUNCTION qorlla_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE TRIGGER subscriptions_touch BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION qorlla_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Overrides: validated, bounded, and every change recorded
-- ---------------------------------------------------------------------------
ALTER TABLE entitlement_overrides ADD CONSTRAINT entitlement_overrides_reason CHECK (reason IS NOT NULL AND btrim(reason) <> '');
ALTER TABLE entitlement_overrides ADD CONSTRAINT entitlement_overrides_value_shape CHECK (
  jsonb_typeof(value) = 'boolean'
  OR (jsonb_typeof(value) = 'number' AND (value::text ~ '^[0-9]{1,9}$'))
  OR value = '"unlimited"'::jsonb);

CREATE TABLE IF NOT EXISTS entitlement_override_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  feature_key text NOT NULL,
  action text NOT NULL CHECK (action IN ('set','remove')),
  old_value jsonb,
  new_value jsonb,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  expires_at timestamptz,
  actor text NOT NULL,
  actor_roles text[] NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entitlement_override_history_customer_idx ON entitlement_override_history (customer_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Audit: more context, and append-only
-- ---------------------------------------------------------------------------
ALTER TABLE access_audit ADD COLUMN IF NOT EXISTS reservation_id uuid;

CREATE OR REPLACE FUNCTION qorlla_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% not allowed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['access_audit','security_events','usage_events','entitlement_override_history'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION qorlla_forbid_mutation()', t || '_immutable_row', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION qorlla_forbid_mutation()', t || '_immutable_trunc', t);
  END LOOP;
END $$;

-- Retention: audit tables are meant to be archived by partition detach/export run by the DBA
-- (disable the triggers deliberately in a controlled maintenance window), never by the application.
