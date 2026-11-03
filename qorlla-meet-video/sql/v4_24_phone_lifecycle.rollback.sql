-- Rolls back v4_24_phone_lifecycle.sql. Loses the lifecycle history, the replay record, the rate counters and the gateway heartbeat; export them first if they are needed.
DROP TABLE IF EXISTS phone_gateway_health;
DROP TABLE IF EXISTS phone_gateway_rate;
DROP TABLE IF EXISTS phone_gateway_replay;
DROP TRIGGER IF EXISTS phone_call_events_no_change ON phone_call_events;
DROP TABLE IF EXISTS phone_call_events;
DROP FUNCTION IF EXISTS phone_call_events_guard();
DROP INDEX IF EXISTS phone_calls_unconfirmed;
DROP INDEX IF EXISTS phone_calls_open;
ALTER TABLE phone_calls DROP CONSTRAINT IF EXISTS phone_calls_media_needs_evidence;
ALTER TABLE phone_calls DROP CONSTRAINT IF EXISTS phone_calls_connected_means_media;
ALTER TABLE phone_calls DROP CONSTRAINT IF EXISTS phone_calls_state_check;
ALTER TABLE phone_calls DROP COLUMN IF EXISTS hangup_confirmed_at, DROP COLUMN IF EXISTS terminated_at, DROP COLUMN IF EXISTS media_evidence, DROP COLUMN IF EXISTS media_verified_at,
  DROP COLUMN IF EXISTS media_nonce_issued_at, DROP COLUMN IF EXISTS media_nonce_hash, DROP COLUMN IF EXISTS approved_at, DROP COLUMN IF EXISTS state_changed_at, DROP COLUMN IF EXISTS state;
DELETE FROM qphone_gates WHERE gate = 'production';
ALTER TABLE qphone_gates DROP CONSTRAINT IF EXISTS qphone_gates_gate_check;
ALTER TABLE qphone_gates ADD CONSTRAINT qphone_gates_gate_check CHECK (gate IN ('dialin','carrier','bridge','billing'));
