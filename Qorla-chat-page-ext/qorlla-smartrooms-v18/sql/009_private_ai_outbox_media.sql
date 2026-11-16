-- Isolated migration; reconcile with existing Meet schema before applying.
CREATE SCHEMA IF NOT EXISTS smartrooms_v18;
CREATE TABLE smartrooms_v18.room_consent (
 occurrence_id text NOT NULL, room_id text NOT NULL, participant_id text NOT NULL,
 purpose text NOT NULL CHECK (purpose IN ('ai_report','transcription')),
 granted boolean NOT NULL DEFAULT false, revision bigint NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (occurrence_id,room_id,participant_id,purpose)
);
CREATE TABLE smartrooms_v18.ai_jobs (
 id uuid PRIMARY KEY, occurrence_id text NOT NULL, room_id text NOT NULL,
 requested_by text NOT NULL, state text NOT NULL CHECK(state IN ('queued','processing','complete','cancelled','failed')),
 quota_reservation text NOT NULL UNIQUE, consent_fingerprint text NOT NULL,
 source_digest text NOT NULL, report jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(report IS NULL OR state='complete')
);
CREATE TABLE smartrooms_v18.events (
 id bigserial PRIMARY KEY, occurrence_id text NOT NULL, room_id text,
 kind text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE smartrooms_v18.delivery (
 event_id bigint NOT NULL REFERENCES smartrooms_v18.events(id) ON DELETE CASCADE,
 consumer text NOT NULL, delivered_at timestamptz,
 PRIMARY KEY(event_id,consumer)
);
CREATE TABLE smartrooms_v18.outbox (
 id bigserial PRIMARY KEY, event_id bigint NOT NULL UNIQUE REFERENCES smartrooms_v18.events(id),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','done','dead')),
 attempts int NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 leased_until timestamptz, lease_token uuid,
 last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_ready_idx ON smartrooms_v18.outbox(available_at,id) WHERE state IN ('pending','leased');
CREATE TABLE smartrooms_v18.media_transitions (
 id uuid PRIMARY KEY, occurrence_id text NOT NULL, participant_id text NOT NULL,
 source_room text, target_room text, epoch bigint NOT NULL,
 client_state text NOT NULL DEFAULT 'pending' CHECK(client_state IN ('pending','client_reported','failed')),
 relay_observation text NOT NULL DEFAULT 'unavailable' CHECK(relay_observation IN ('unavailable','allocation_observed','traffic_observed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(occurrence_id,participant_id,epoch)
);
CREATE TABLE smartrooms_v18.audit (
 id bigserial PRIMARY KEY, occurrence_id text NOT NULL, actor_id text NOT NULL,
 action text NOT NULL, target_id text, created_at timestamptz NOT NULL DEFAULT now()
);
