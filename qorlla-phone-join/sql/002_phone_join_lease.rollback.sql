-- Rolls back 002_phone_join_lease.sql only (001 stays). Ownership fencing is lost; the pre-lease reaper must be deployed again.
DROP INDEX IF EXISTS phone_join_calls_lease;
ALTER TABLE phone_join_calls DROP COLUMN IF EXISTS lease_challenged_at;
ALTER TABLE phone_join_calls DROP COLUMN IF EXISTS lease_expires_at;
ALTER TABLE phone_join_calls DROP COLUMN IF EXISTS lease_generation;
ALTER TABLE phone_join_calls DROP COLUMN IF EXISTS lease_owner;
