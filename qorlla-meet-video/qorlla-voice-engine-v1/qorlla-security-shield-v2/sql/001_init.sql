BEGIN;
CREATE SCHEMA IF NOT EXISTS shield;
CREATE TABLE IF NOT EXISTS shield.principal_state (
 principal_id uuid PRIMARY KEY, organization_id uuid, suspended boolean NOT NULL DEFAULT false,
 verified boolean NOT NULL DEFAULT false, mfa_enrolled boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shield.devices (
 principal_id uuid NOT NULL, device_id uuid NOT NULL, trusted boolean NOT NULL DEFAULT false,
 revoked boolean NOT NULL DEFAULT false, last_seen timestamptz,
 PRIMARY KEY(principal_id,device_id)
);
CREATE TABLE IF NOT EXISTS shield.organization_policy (
 organization_id uuid PRIMARY KEY, suspended boolean NOT NULL DEFAULT false,
 pstn_enabled boolean NOT NULL DEFAULT false, international_enabled boolean NOT NULL DEFAULT false,
 max_active_calls integer NOT NULL DEFAULT 2 CHECK(max_active_calls BETWEEN 0 AND 1000),
 max_calls_hour integer NOT NULL DEFAULT 30 CHECK(max_calls_hour BETWEEN 0 AND 100000)
);
CREATE TABLE IF NOT EXISTS shield.risk_signals (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, principal_id uuid NOT NULL,
 category text NOT NULL, score integer NOT NULL CHECK(score BETWEEN 0 AND 100),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS risk_active ON shield.risk_signals(principal_id,expires_at);
CREATE TABLE IF NOT EXISTS shield.security_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, principal_id uuid,
 organization_id uuid, action text NOT NULL, decision text NOT NULL,
 reason text NOT NULL, request_id uuid NOT NULL UNIQUE,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_actor_time ON shield.security_events(principal_id,created_at DESC);
CREATE TABLE IF NOT EXISTS shield.authorizations (
 id uuid PRIMARY KEY, principal_id uuid NOT NULL, action text NOT NULL,
 resource_id text NOT NULL, expires_at timestamptz NOT NULL,
 consumed_at timestamptz, request_id uuid NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shield.usage_counters (
 principal_id uuid NOT NULL, bucket text NOT NULL, window_start timestamptz NOT NULL,
 used integer NOT NULL DEFAULT 0, PRIMARY KEY(principal_id,bucket,window_start)
);
CREATE TABLE IF NOT EXISTS shield.active_calls (
 call_id uuid PRIMARY KEY, principal_id uuid NOT NULL, expires_at timestamptz NOT NULL,
 ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS active_calls_lookup ON shield.active_calls(principal_id,expires_at) WHERE ended_at IS NULL;
CREATE OR REPLACE FUNCTION shield.deny_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'security_events are append-only'; END $$;
DROP TRIGGER IF EXISTS security_events_append_only ON shield.security_events;
CREATE TRIGGER security_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON shield.security_events FOR EACH STATEMENT EXECUTE FUNCTION shield.deny_event_mutation();
COMMIT;
-- SECURITY DEPLOYMENT: use distinct owner/migrator and runtime roles.
-- REVOKE ALL ON SCHEMA shield FROM PUBLIC; REVOKE ALL ON ALL TABLES IN SCHEMA shield FROM PUBLIC;
-- Grant runtime only necessary SELECT/INSERT/UPDATE on non-audit tables; INSERT/SELECT only on security_events.
-- Verify effective inherited/default privileges; table owners and superusers can bypass SQL restrictions.
