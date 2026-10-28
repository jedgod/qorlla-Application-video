-- Qorlla Meet: free-plan meeting time limit and how a meeting ended (v4.12). Idempotent; run as the database owner BEFORE sql/005_app_role.sql.
-- time_limit_ms / grace_ms are set by the scheduling backend when it registers a meeting (NULL = no limit, e.g. a paid host).
-- Rollback: ALTER TABLE meetings DROP COLUMN time_limit_ms, DROP COLUMN grace_ms, DROP COLUMN end_reason;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS time_limit_ms bigint, ADD COLUMN IF NOT EXISTS grace_ms bigint, ADD COLUMN IF NOT EXISTS end_reason text;
