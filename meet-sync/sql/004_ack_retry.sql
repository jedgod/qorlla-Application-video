-- Durable, independent retry state for host-recovery acknowledgment (v3.9.2).
ALTER TABLE qorlla_host_recovery ADD COLUMN IF NOT EXISTS ack_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE qorlla_host_recovery ADD COLUMN IF NOT EXISTS next_ack_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE qorlla_host_recovery ADD COLUMN IF NOT EXISTS ack_lease_until timestamptz;
ALTER TABLE qorlla_host_recovery ADD COLUMN IF NOT EXISTS ack_last_error text;
CREATE INDEX IF NOT EXISTS qorlla_host_recovery_ack_due ON qorlla_host_recovery(next_ack_at) WHERE ack_pending;
