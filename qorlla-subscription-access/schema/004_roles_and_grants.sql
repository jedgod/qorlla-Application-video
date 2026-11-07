-- Qorlla Subscription Access - 004 least-privilege roles
-- Three NOLOGIN group roles. Grant each to the matching LOGIN role of the service that needs it:
--   GRANT qorlla_sub_runtime TO <login role used by the request path>;
--   GRANT qorlla_sub_billing TO <login role used by the webhook worker>;
--   GRANT qorlla_sub_admin   TO <login role used by the billing-admin service>;
-- The tables are owned by the migrator; none of these roles owns anything, so none can ALTER or DROP.
-- The three group roles are the only cluster-level objects this package creates; their names all start with qorlla_sub_.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qorlla_sub_runtime') THEN CREATE ROLE qorlla_sub_runtime NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qorlla_sub_billing') THEN CREATE ROLE qorlla_sub_billing NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qorlla_sub_admin')   THEN CREATE ROLE qorlla_sub_admin   NOLOGIN; END IF;
END $$;

-- ISOLATION: every statement below is scoped to the `subscription_access` schema. Nothing is revoked from or granted on any
-- other schema, table, sequence, function or role, so this package can share a database with unrelated applications
-- (tests/isolation.pg.test.js snapshots every unrelated ACL before and after the migrations and requires them to be identical).
REVOKE ALL ON SCHEMA subscription_access FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA subscription_access FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA subscription_access FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA subscription_access FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA subscription_access REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA subscription_access REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA subscription_access REVOKE ALL ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA subscription_access TO qorlla_sub_runtime, qorlla_sub_billing, qorlla_sub_admin;

-- Request path: reads entitlements, reserves/commits/releases quota, writes audit. Cannot change plans or overrides.
GRANT SELECT ON plans, features, plan_entitlements, subscriptions, entitlement_overrides TO qorlla_sub_runtime;
GRANT SELECT, INSERT ON quota_reservations TO qorlla_sub_runtime;
GRANT UPDATE (status, committed_at, expires_at, renewed_count, late) ON quota_reservations TO qorlla_sub_runtime;
GRANT SELECT, INSERT ON usage_events, access_audit, security_events TO qorlla_sub_runtime;

-- Webhook worker: owns subscription state and the inbox/outbox. Cannot touch overrides, usage or reservations.
GRANT SELECT ON plans, features TO qorlla_sub_billing;
GRANT SELECT, INSERT, UPDATE ON subscriptions TO qorlla_sub_billing;
GRANT SELECT ON billing_customers TO qorlla_sub_billing;
GRANT SELECT, INSERT, UPDATE ON billing_inbox, billing_outbox TO qorlla_sub_billing;
GRANT USAGE, SELECT ON SEQUENCE billing_outbox_id_seq TO qorlla_sub_billing;
GRANT INSERT ON security_events TO qorlla_sub_billing;

-- Billing administrators (behind MFA and authorization in the application): overrides and customer links.
GRANT SELECT ON plans, features, subscriptions TO qorlla_sub_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON entitlement_overrides TO qorlla_sub_admin;
GRANT SELECT, INSERT ON entitlement_override_history, security_events TO qorlla_sub_admin;
GRANT SELECT, INSERT ON billing_customers TO qorlla_sub_admin;
