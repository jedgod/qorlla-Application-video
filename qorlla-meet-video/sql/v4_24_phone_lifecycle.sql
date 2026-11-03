-- Qorlla Meet: telephone call lifecycle (v4.24). Idempotent; run as the owner BEFORE sql/005_app_role.sql. Rollback: sql/v4_24_phone_lifecycle.rollback.sql
--
-- A telephone caller is "connected" only when VERIFIED, ENCRYPTED, TWO-WAY AUDIO exists. Until now Meet marked the caller connected as soon as the PIN was right (and the host, if any, had approved).
-- Lifecycle:  REQUESTED -> VERIFIED -> AWAITING_HOST -> APPROVED -> MEDIA_CONNECTING -> MEDIA_CONNECTED -> TERMINATED
--             plus REFUSED, TIMED_OUT, CANCELLED, and ORPHANED (media exists for a call Meet refused, ended or timed out).
-- The legacy `status` column stays (every existing reader keeps working) but is now DERIVED: 'connected' only in MEDIA_CONNECTED. The database itself enforces it (two CHECK constraints below).
ALTER TABLE phone_calls ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE phone_calls ADD COLUMN IF NOT EXISTS state_changed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE phone_calls ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE phone_calls ADD COLUMN IF NOT EXISTS media_nonce_hash text;          -- SHA-256 of the one-time media token handed to the gateway; the token itself is never stored
ALTER TABLE phone_calls ADD COLUMN IF NOT EXISTS media_nonce_issued_at timestamptz;
ALTER TABLE phone_calls ADD COLUMN IF NOT EXISTS media_verified_at timestamptz;  -- last time Meet itself accepted audio evidence for this call
ALTER TABLE phone_calls ADD COLUMN IF NOT EXISTS media_evidence jsonb;
ALTER TABLE phone_calls ADD COLUMN IF NOT EXISTS terminated_at timestamptz;
ALTER TABLE phone_calls ADD COLUMN IF NOT EXISTS hangup_confirmed_at timestamptz; -- the gateway/carrier confirmed the leg is gone

-- Existing rows. A 'connected' row never had verified media (no gateway exists), so it cannot be kept as connected: it is ended and says why.
UPDATE phone_calls SET state = CASE status WHEN 'waiting' THEN 'AWAITING_HOST' WHEN 'denied' THEN 'REFUSED' ELSE 'TERMINATED' END WHERE state IS NULL;
UPDATE phone_calls SET status='ended', state='TERMINATED', ended_at=COALESCE(ended_at, now()), end_reason='legacy_unverified_media' WHERE status='connected' AND state <> 'MEDIA_CONNECTED';
ALTER TABLE phone_calls ALTER COLUMN state SET DEFAULT 'REQUESTED';
ALTER TABLE phone_calls ALTER COLUMN state SET NOT NULL;
ALTER TABLE phone_calls DROP CONSTRAINT IF EXISTS phone_calls_state_check;
ALTER TABLE phone_calls ADD CONSTRAINT phone_calls_state_check CHECK (state IN ('REQUESTED','VERIFIED','AWAITING_HOST','APPROVED','MEDIA_CONNECTING','MEDIA_CONNECTED','TERMINATED','REFUSED','TIMED_OUT','CANCELLED','ORPHANED'));
ALTER TABLE phone_calls DROP CONSTRAINT IF EXISTS phone_calls_connected_means_media;
ALTER TABLE phone_calls ADD CONSTRAINT phone_calls_connected_means_media CHECK (status <> 'connected' OR state = 'MEDIA_CONNECTED');
ALTER TABLE phone_calls DROP CONSTRAINT IF EXISTS phone_calls_media_needs_evidence;
ALTER TABLE phone_calls ADD CONSTRAINT phone_calls_media_needs_evidence CHECK (state <> 'MEDIA_CONNECTED' OR media_verified_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS phone_calls_open ON phone_calls (state, state_changed_at) WHERE state IN ('AWAITING_HOST','APPROVED','MEDIA_CONNECTING','MEDIA_CONNECTED');
CREATE INDEX IF NOT EXISTS phone_calls_unconfirmed ON phone_calls (terminated_at) WHERE hangup_confirmed_at IS NULL AND state IN ('REFUSED','TIMED_OUT','CANCELLED','TERMINATED','ORPHANED');

-- Every state change, append-only (a trigger refuses UPDATE and manual DELETE; rows go only when their call is deleted with its meeting).
CREATE TABLE IF NOT EXISTS phone_call_events (
  id         bigserial PRIMARY KEY,
  call_id    uuid NOT NULL REFERENCES phone_calls(id) ON DELETE CASCADE,
  from_state text,
  to_state   text NOT NULL,
  reason     text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phone_call_events_call ON phone_call_events (call_id, id);
CREATE OR REPLACE FUNCTION phone_call_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;      -- the cascade from a deleted call
  RAISE EXCEPTION 'phone_call_events is append-only';
END $$;
DROP TRIGGER IF EXISTS phone_call_events_no_change ON phone_call_events;
CREATE TRIGGER phone_call_events_no_change BEFORE UPDATE OR DELETE ON phone_call_events FOR EACH ROW EXECUTE FUNCTION phone_call_events_guard();

-- Gateway workload tokens are accepted once (jti), shared by every Meet replica.
CREATE TABLE IF NOT EXISTS phone_gateway_replay ( jti text PRIMARY KEY CHECK (length(jti) BETWEEN 16 AND 200), issuer text NOT NULL, expires_at timestamptz NOT NULL );
CREATE INDEX IF NOT EXISTS phone_gateway_replay_expiry ON phone_gateway_replay (expires_at);
-- Fixed-window request counters for the gateway endpoints, shared by every replica (the in-memory express-rate-limit counters are per process).
CREATE TABLE IF NOT EXISTS phone_gateway_rate ( bucket text NOT NULL, window_start timestamptz NOT NULL, n int NOT NULL DEFAULT 0, PRIMARY KEY (bucket, window_start) );
-- Gateway heartbeat: the evidence behind "gatewayHealthy".
CREATE TABLE IF NOT EXISTS phone_gateway_health ( instance text PRIMARY KEY CHECK (instance ~ '^[A-Za-z0-9_.:-]{1,80}$'), healthy boolean NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(), detail text );

-- A fifth release gate: explicit production approval, recorded by an operator with evidence like the others.
ALTER TABLE qphone_gates DROP CONSTRAINT IF EXISTS qphone_gates_gate_check;
ALTER TABLE qphone_gates ADD CONSTRAINT qphone_gates_gate_check CHECK (gate IN ('dialin','carrier','bridge','billing','production'));
