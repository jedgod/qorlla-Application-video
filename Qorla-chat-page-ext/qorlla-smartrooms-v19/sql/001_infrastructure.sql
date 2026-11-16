CREATE SCHEMA IF NOT EXISTS smartrooms_v19;
CREATE TABLE IF NOT EXISTS smartrooms_v19.room_consents (
 occurrence_id text NOT NULL, room_id text NOT NULL, participant_id text NOT NULL,
 consent boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(occurrence_id,room_id,participant_id)
);
CREATE TABLE IF NOT EXISTS smartrooms_v19.ai_jobs (
 id uuid PRIMARY KEY, occurrence_id text NOT NULL, room_id text NOT NULL,
 requested_by text NOT NULL, request_key text NOT NULL, status text NOT NULL DEFAULT 'queued'
 CHECK(status IN ('queued','processing','completed','failed','cancelled')),
 result jsonb, error_code text, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(occurrence_id,request_key)
);
CREATE TABLE IF NOT EXISTS smartrooms_v19.events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, occurrence_id text NOT NULL,
 room_id text, kind text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS smartrooms_v19.outbox (
 event_id bigint PRIMARY KEY REFERENCES smartrooms_v19.events(id),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','published','dead')),
 attempts integer NOT NULL DEFAULT 0, next_attempt timestamptz NOT NULL DEFAULT now(),
 lease_owner text, leased_until timestamptz, published_at timestamptz
);
CREATE INDEX IF NOT EXISTS v19_outbox_ready ON smartrooms_v19.outbox(next_attempt) WHERE state='pending';
CREATE TABLE IF NOT EXISTS smartrooms_v19.inbox (
 consumer text NOT NULL, event_id bigint NOT NULL REFERENCES smartrooms_v19.events(id),
 processed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(consumer,event_id)
);
CREATE TABLE IF NOT EXISTS smartrooms_v19.media_evidence (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, occurrence_id text NOT NULL,
 participant_id text NOT NULL, room_id text, epoch bigint NOT NULL,
 source text NOT NULL CHECK(source IN ('client','turn','gateway')),
 evidence jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now()
);
