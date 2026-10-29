-- Qorlla Meet v4.17: who a participant is, as the trusted main app reports it. Account ids come ONLY from the main app through the bridge (never from a browser); a participant without one is a guest.
-- Meetings carry the host account, the organization and whether guests may join, so the Security Shield can decide each signaling session. Idempotent, nullable, non-destructive.
-- Rollback: ALTER TABLE participants DROP COLUMN account_id; ALTER TABLE meetings DROP COLUMN host_account_id, DROP COLUMN org_id, DROP COLUMN guest_enabled;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS host_account_id text;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS org_id text;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS guest_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS account_id text;
