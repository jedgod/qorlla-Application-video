-- Qorlla Meet v4.19: the host's Qorlla AI consent REQUEST (a marker on the meeting; the per-person answers stay in ai_consents, which is separate from recording consent). Idempotent.
-- Run as the database owner BEFORE sql/005_app_role.sql and AFTER v4_9_recording_storage.sql.
-- Rollback: ALTER TABLE meetings DROP COLUMN ai_requested_at, DROP COLUMN ai_requested_by;  (individual answers in ai_consents are untouched)
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS ai_requested_at timestamptz;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS ai_requested_by uuid;
