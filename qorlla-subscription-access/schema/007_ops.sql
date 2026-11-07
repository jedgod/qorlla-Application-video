-- Qorlla Subscription Access - 007 operations: administration request log + durable alerting
-- (1) every request to the internal administration service is recorded, allowed or not, append-only
-- (2) alerts are stored first and delivered from an outbox with retry and acknowledgement; nothing is lost if a destination is down

CREATE TABLE IF NOT EXISTS admin_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jti text,
  user_id text,
  session_hash text,                         -- stored hashed again, never the raw session identifier
  action text,
  customer_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('attempt','ok','denied','invalid','replay','error')),   -- 'attempt' is written BEFORE the action runs
  status integer NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_requests_time_idx ON admin_requests (occurred_at DESC);
CREATE INDEX IF NOT EXISTS admin_requests_user_idx ON admin_requests (user_id, occurred_at DESC);
CREATE TRIGGER admin_requests_immutable_row BEFORE UPDATE OR DELETE ON admin_requests FOR EACH ROW EXECUTE FUNCTION qorlla_forbid_mutation();
CREATE TRIGGER admin_requests_immutable_trunc BEFORE TRUNCATE ON admin_requests FOR EACH STATEMENT EXECUTE FUNCTION qorlla_forbid_mutation();

CREATE TABLE IF NOT EXISTS ops_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 80),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
  details jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  occurrences integer NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by text,
  acknowledged_at timestamptz,
  resolved_at timestamptz
);
-- One live alert per condition: a repeat increments `occurrences` instead of flooding the destination.
CREATE UNIQUE INDEX IF NOT EXISTS ops_alerts_live_idx ON ops_alerts (dedupe_key) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS ops_alerts_status_idx ON ops_alerts (status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS ops_alert_deliveries (
  id bigserial PRIMARY KEY,
  alert_id uuid NOT NULL REFERENCES ops_alerts(id),
  destination text NOT NULL CHECK (char_length(destination) BETWEEN 1 AND 80),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  acknowledged_at timestamptz,               -- the DESTINATION confirmed it took responsibility
  last_error text,
  UNIQUE (alert_id, destination)
);
CREATE INDEX IF NOT EXISTS ops_alert_deliveries_due_idx ON ops_alert_deliveries (next_attempt_at) WHERE delivered_at IS NULL;

-- Roles. The administration service writes its request log. A dedicated `ops` role runs the monitor and the dispatcher: it can READ
-- the signals it watches and manage alerts, and nothing else.
GRANT SELECT, INSERT ON admin_requests TO qorlla_sub_admin;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qorlla_sub_ops') THEN CREATE ROLE qorlla_sub_ops NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA subscription_access TO qorlla_sub_ops;
GRANT SELECT ON security_events, billing_inbox, billing_outbox, quota_reservations, admin_requests, stepup_audit TO qorlla_sub_ops;
GRANT SELECT, INSERT ON ops_alerts, ops_alert_deliveries TO qorlla_sub_ops;
GRANT UPDATE (severity, summary, details, status, occurrences, last_seen_at, acknowledged_by, acknowledged_at, resolved_at) ON ops_alerts TO qorlla_sub_ops;
GRANT UPDATE (attempts, next_attempt_at, delivered_at, acknowledged_at, last_error) ON ops_alert_deliveries TO qorlla_sub_ops;
GRANT USAGE, SELECT ON SEQUENCE ops_alert_deliveries_id_seq TO qorlla_sub_ops;
