-- Gate A5.1: ownership lease, generation fencing and per-state reaping for the telephone call ledger. Requires 001_phone_join.sql. Idempotent.
-- Rollback: sql/002_phone_join_lease.rollback.sql
-- lease_owner / lease_generation / lease_expires_at: the gateway instance that owns the live telephone leg, how many times ownership has changed hands (every transfer adds 1; a writer that does not
-- present the CURRENT generation changes nothing) and when the lease lapses unless renewed. lease_challenged_at: set by a reaper that found the lease lapsed; the owner's next renewal clears it. A lapse
-- is a question ("is the owner alive?"), not a verdict: only a lease that stayed lapsed for a whole grace period after being challenged lets a reaper take the call over.
ALTER TABLE phone_join_calls ADD COLUMN IF NOT EXISTS lease_owner         text;
ALTER TABLE phone_join_calls ADD COLUMN IF NOT EXISTS lease_generation    bigint NOT NULL DEFAULT 0;
ALTER TABLE phone_join_calls ADD COLUMN IF NOT EXISTS lease_expires_at    timestamptz;
ALTER TABLE phone_join_calls ADD COLUMN IF NOT EXISTS lease_challenged_at timestamptz;
-- rows written before this migration have no lease: they start as generation 1, owned by their claimant, already lapsed (so a reaper challenges them first, then reaps them if nobody renews)
UPDATE phone_join_calls SET lease_owner = claimed_by, lease_generation = 1, lease_expires_at = now() WHERE lease_generation = 0;
CREATE INDEX IF NOT EXISTS phone_join_calls_lease ON phone_join_calls (lease_expires_at) WHERE state IN ('claimed','authorizing','awaiting_host','attaching','terminating');
