-- Qorlla Subscription Access — Production Schema (v2)
-- Corrected: partial unique indexes, capacity vs consumption, lifecycle fields.

-- Applied by src/migrate.js inside the dedicated `subscription_access` schema (SET LOCAL search_path); nothing here touches other schemas.
-- Requires PostgreSQL 13+ (gen_random_uuid() is built in; no extension and no CREATE EXTENSION privilege needed).

-- ---------------------------------------------------------------------------
-- Plans
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  code text PRIMARY KEY CHECK (code IN ('basic','pro','business','enterprise')),
  display_name text NOT NULL,
  rank integer NOT NULL UNIQUE,
  is_public boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plans (code, display_name, rank) VALUES
  ('basic',      'Basic',      0),
  ('pro',        'Pro',        10),
  ('business',   'Business',   20),
  ('enterprise', 'Enterprise', 30)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Subscriptions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL UNIQUE,
  plan_code text NOT NULL REFERENCES plans(code),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('trialing','active','past_due','paused','canceled','incomplete','expired')),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  trial_ends_at timestamptz,
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end timestamptz NOT NULL,
  grace_period_ends_at timestamptz,          -- explicit payment grace window
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at timestamptz,
  paused_at timestamptz,
  external_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriptions_customer_status_idx
  ON subscriptions (customer_id, status);

CREATE INDEX IF NOT EXISTS subscriptions_period_end_idx
  ON subscriptions (current_period_end)
  WHERE status IN ('active','trialing','past_due');

-- ---------------------------------------------------------------------------
-- Features
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS features (
  key text PRIMARY KEY,
  description text,
  category text,
  value_type text NOT NULL CHECK (value_type IN ('boolean','numeric','unlimited')),
  metering text NOT NULL DEFAULT 'none'
    CHECK (metering IN ('none','capacity','consumption')),  -- capacity = snapshot limit; consumption = metered usage
  period text CHECK (period IN ('none','daily','monthly','billing')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Plan entitlements
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_entitlements (
  plan_code text NOT NULL REFERENCES plans(code) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES features(key) ON DELETE CASCADE,
  value jsonb NOT NULL,
  soft_limit boolean NOT NULL DEFAULT false,
  PRIMARY KEY (plan_code, feature_key)
);

-- ---------------------------------------------------------------------------
-- Customer overrides (validated on write)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entitlement_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  feature_key text NOT NULL REFERENCES features(key),
  value jsonb NOT NULL,
  reason text,
  expires_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, feature_key)
);

CREATE INDEX IF NOT EXISTS entitlement_overrides_customer_idx
  ON entitlement_overrides (customer_id);

-- ---------------------------------------------------------------------------
-- Usage events (consumption metering)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  feature_key text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text,
  reservation_id uuid,                       -- links to a prior reservation
  metadata jsonb NOT NULL DEFAULT '{}',
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL
);

-- Partial unique index (correct PostgreSQL syntax)
CREATE UNIQUE INDEX IF NOT EXISTS usage_events_idempotency_idx
  ON usage_events (customer_id, feature_key, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS usage_events_lookup_idx
  ON usage_events (customer_id, feature_key, period_start, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Quota reservations (atomic check-and-reserve)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quota_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  feature_key text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved','committed','released','expired')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  committed_at timestamptz,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  idempotency_key text,
  metadata jsonb NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS quota_reservations_idempotency_idx
  ON quota_reservations (customer_id, feature_key, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status = 'reserved';

CREATE INDEX IF NOT EXISTS quota_reservations_active_idx
  ON quota_reservations (customer_id, feature_key, status, expires_at)
  WHERE status = 'reserved';

-- ---------------------------------------------------------------------------
-- Access audit (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS access_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  feature_key text,
  allowed boolean NOT NULL,
  reason text,
  plan_code text,
  limit_value jsonb,
  used_value bigint,
  requested_quantity integer,
  actor text,
  request_id text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS access_audit_customer_time_idx
  ON access_audit (customer_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Security events (durable, for alerting)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  customer_id uuid,
  details jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_events_severity_time_idx
  ON security_events (severity, occurred_at DESC);

-- Recommended grants (adjust role name)
-- GRANT SELECT ON plans, features, plan_entitlements TO qorlla_app;
-- GRANT SELECT, INSERT, UPDATE ON subscriptions, quota_reservations TO qorlla_app;
-- GRANT SELECT, INSERT ON usage_events, access_audit, security_events TO qorlla_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON entitlement_overrides TO qorlla_app;
