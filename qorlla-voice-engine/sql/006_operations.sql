-- Qorlla Voice Engine v1.9: server-side consumer deduplication and recorded release-gate runs. Idempotent. Run with the migration role, not the runtime role.
-- voice_delivery_dedupe: a server-side consumer of durable events (for example a future Meet bridge) records each event it has applied, so a redelivery is applied once.
CREATE TABLE IF NOT EXISTS voice_delivery_dedupe (
  consumer_id text NOT NULL,
  event_id bigint NOT NULL REFERENCES voice_reliable_events(id) ON DELETE CASCADE,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_id, event_id)
);
-- voice_certification_runs: what `npm run release:gate -- --record` found, so the decision to release has a durable record. A row is an audit trail, never an approval.
CREATE TABLE IF NOT EXISTS voice_certification_runs (
  id uuid PRIMARY KEY,
  revision text NOT NULL,
  environment text NOT NULL,
  evidence jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('PASS','FAIL','INCOMPLETE')),
  created_at timestamptz NOT NULL DEFAULT now()
);
