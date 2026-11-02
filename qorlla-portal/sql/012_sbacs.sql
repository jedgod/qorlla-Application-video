-- Qorlla SBACS (subscription-based access control), development slice 1. Reverse with sql/rollback/012_sbacs.down.sql.
-- Additive on top of 002/007: it REUSES portal.plans, portal.plan_prices, portal.entitlements, portal.subscriptions, portal.billing_events and
-- portal.workspace_effective_plan. Nothing here charges anybody, sets a price or turns on a payment provider. Quotas below are ILLUSTRATIVE
-- placeholders that Qorlla must approve before activation. Free = the existing 'basic' plan; "Professional" = the existing 'pro' plan.
BEGIN;

-- a plan can exist in the catalogue without being offered (Starter has no approved price yet)
ALTER TABLE portal.plans ADD COLUMN IF NOT EXISTS listed boolean NOT NULL DEFAULT true;
INSERT INTO portal.plans(slug, name, monthly_cents, description, sort_order, listed)
  VALUES ('starter', 'Starter', NULL, 'Individuals getting started (price not yet approved)', 2, false) ON CONFLICT (slug) DO NOTHING;
UPDATE portal.plans SET sort_order = CASE slug WHEN 'basic' THEN 1 WHEN 'starter' THEN 2 WHEN 'pro' THEN 3 WHEN 'business' THEN 4 WHEN 'enterprise' THEN 5 ELSE sort_order END;

-- a feature row can now say "known, but not granted on this plan"
ALTER TABLE portal.entitlements ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

-- account-level block: a suspended workspace is denied everything (guest join excepted) whatever it has paid
ALTER TABLE portal.workspaces ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE portal.workspaces ADD COLUMN IF NOT EXISTS suspended_reason text;
ALTER TABLE portal.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE portal.subscriptions ADD CONSTRAINT subscriptions_status_check CHECK (status IN ('active','trialing','past_due','canceled','expired','incomplete','suspended'));

-- ---- the feature matrix (feature keys are stable API; quota NULL = unlimited when enabled) ----
-- columns: feature, description, then free / starter / pro / business / enterprise as  enabled:quota  ('-' = not granted)
CREATE TEMP TABLE sbacs_seed(feature text, description text, free text, starter text, pro text, business text, enterprise text) ON COMMIT DROP;
INSERT INTO sbacs_seed VALUES
  ('meet.guest_join',        'Join a meeting as a guest',                 'y:',     'y:',     'y:',     'y:',     'y:'),
  ('meet.create',            'Create meetings',                           'y:',     'y:',     'y:',     'y:',     'y:'),
  ('meet.recording',         'Meeting recording',                         '-',      'y:10',   'y:',     'y:',     'y:'),
  ('docs.create',            'Docs, Sheets and Slides: create',           'y:25',   'y:250',  'y:',     'y:',     'y:'),
  ('docs.advanced',          'Advanced Docs, Sheets and Slides tools',    '-',      '-',      'y:',     'y:',     'y:'),
  ('clips.create',           'Clips',                                     'y:10',   'y:',     'y:',     'y:',     'y:'),
  ('ai.docs.draft',          'Qorlla AI drafting in Docs',                'y:20',   'y:200',  'y:1000', 'y:5000', 'y:'),
  ('ai.private',             'Qorlla AI Private (policy based)',          'y:',     'y:',     'y:',     'y:',     'y:'),
  ('analytics.advanced',     'Advanced analytics',                        '-',      '-',      'y:',     'y:',     'y:'),
  ('org.admin',              'Organization administration',               '-',      '-',      '-',      'y:',     'y:'),
  ('org.sso',                'SSO and advanced governance',               '-',      '-',      '-',      '-',      'y:'),
  ('voice.internal',         'Internal voice extensions',                 'y:',     'y:',     'y:',     'y:',     'y:'),
  -- never granted by any plan: needs an approved carrier and separate telephony certification; payment must not unlock it
  ('phone.pstn',             'Public PSTN calling and public numbers',    '-',      '-',      '-',      '-',      '-');
INSERT INTO portal.entitlements(plan_slug, feature, quota, description, enabled)
SELECT p.slug, s.feature, NULLIF(split_part(x.v, ':', 2), '')::integer, s.description, split_part(x.v, ':', 1) = 'y'
FROM sbacs_seed s
CROSS JOIN LATERAL (VALUES ('basic', s.free), ('starter', s.starter), ('pro', s.pro), ('business', s.business), ('enterprise', s.enterprise)) AS x(slug, v)
JOIN portal.plans p ON p.slug = x.slug
ON CONFLICT (plan_slug, feature) DO NOTHING;

-- ---- per-workspace overrides (support, contracts, trials). Every change is also written to entitlement_events. ----
CREATE TABLE IF NOT EXISTS portal.entitlement_overrides (
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  feature text NOT NULL,
  enabled boolean NOT NULL, quota integer CHECK (quota IS NULL OR quota >= 0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  expires_at timestamptz, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, feature)
);

-- ---- append-only record of billing state changes and entitlement overrides ----
CREATE TABLE IF NOT EXISTS portal.entitlement_events (
  id bigserial PRIMARY KEY,
  workspace_id uuid, actor_id uuid, kind text NOT NULL, detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entitlement_events_ws_idx ON portal.entitlement_events(workspace_id, id DESC);
CREATE OR REPLACE FUNCTION portal.entitlement_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'entitlement_events is append-only'; END $$;
DROP TRIGGER IF EXISTS entitlement_events_guard ON portal.entitlement_events;
CREATE TRIGGER entitlement_events_guard BEFORE UPDATE OR DELETE ON portal.entitlement_events FOR EACH ROW EXECUTE FUNCTION portal.entitlement_events_append_only();
DROP TRIGGER IF EXISTS entitlement_events_guard_truncate ON portal.entitlement_events;
CREATE TRIGGER entitlement_events_guard_truncate BEFORE TRUNCATE ON portal.entitlement_events FOR EACH STATEMENT EXECUTE FUNCTION portal.entitlement_events_append_only();

-- ---- metered usage: committed counter + open reservations (reserve -> finalize | release), one row lock per counter ----
CREATE TABLE IF NOT EXISTS portal.subscription_usage (
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id), feature text NOT NULL, period_start date NOT NULL,
  used bigint NOT NULL DEFAULT 0 CHECK (used >= 0), reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  PRIMARY KEY (workspace_id, feature, period_start)
);
CREATE TABLE IF NOT EXISTS portal.usage_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id), feature text NOT NULL, period_start date NOT NULL,
  units bigint NOT NULL CHECK (units > 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','finalized','released')),
  idempotency_key text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS usage_reservations_open_idx ON portal.usage_reservations(expires_at) WHERE status = 'reserved';

-- ---- effective plan: add the account block. A suspended workspace/subscription is "suspended", never a paid plan. ----
CREATE OR REPLACE VIEW portal.workspace_effective_plan AS
SELECT w.id AS workspace_id,
       CASE
         WHEN w.suspended_at IS NOT NULL OR s.status = 'suspended' THEN 'basic'
         WHEN s.plan_slug IS NOT NULL AND s.plan_slug <> 'basic' AND (
              (s.status IN ('active','trialing') AND (s.current_period_end IS NULL OR s.current_period_end > now() - interval '2 days'))
           OR (s.status = 'past_due' AND s.current_period_end IS NOT NULL AND s.current_period_end > now() - interval '7 days'))
         THEN s.plan_slug ELSE 'basic'
       END AS plan_slug
FROM portal.workspaces w LEFT JOIN portal.subscriptions s ON s.workspace_id = w.id;

COMMIT;
