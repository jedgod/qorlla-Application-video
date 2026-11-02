-- Main-side host recovery state (v3.9). One stable request ID per schedule, persisted BEFORE calling Meet.
CREATE TABLE IF NOT EXISTS qorlla_host_recovery (
 source_id text PRIMARY KEY REFERENCES qorlla_schedules(source_id),
 request_id text NOT NULL,
 generation bigint,
 ack_pending boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
