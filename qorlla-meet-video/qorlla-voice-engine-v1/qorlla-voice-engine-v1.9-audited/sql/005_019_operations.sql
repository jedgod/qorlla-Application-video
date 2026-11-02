CREATE TABLE IF NOT EXISTS voice_delivery_dedupe (
 consumer_id text NOT NULL, event_id bigint NOT NULL REFERENCES voice_reliable_events(id) ON DELETE CASCADE,
 processed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(consumer_id,event_id)
);
CREATE TABLE IF NOT EXISTS voice_certification_runs (
 id uuid PRIMARY KEY, revision text NOT NULL, environment text NOT NULL,
 evidence jsonb NOT NULL, status text NOT NULL CHECK(status IN ('PASS','FAIL','INCOMPLETE')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_outbox_undelivered_idx ON voice_outbox(available_at,event_id)
 WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS voice_media_leases_expiry_idx ON voice_media_leases(expires_at);
-- Migration role must grant application/worker only least-privilege rights.
