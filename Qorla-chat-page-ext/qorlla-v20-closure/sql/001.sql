CREATE SCHEMA IF NOT EXISTS meet_dist;
CREATE TABLE IF NOT EXISTS meet_dist.events (
 id uuid PRIMARY KEY, meeting_id text NOT NULL, room_id text NOT NULL,
 epoch bigint NOT NULL, kind text NOT NULL, payload jsonb NOT NULL,
 actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_cursor ON meet_dist.events(meeting_id,created_at,id);
CREATE TABLE IF NOT EXISTS meet_dist.memberships (
 meeting_id text NOT NULL, participant_id text NOT NULL, room_id text NOT NULL,
 epoch bigint NOT NULL CHECK(epoch >= 0), connected_until timestamptz,
 PRIMARY KEY(meeting_id,participant_id)
);
CREATE INDEX IF NOT EXISTS membership_room ON meet_dist.memberships(meeting_id,room_id);
CREATE TABLE IF NOT EXISTS meet_dist.outbox (
 event_id uuid PRIMARY KEY REFERENCES meet_dist.events(id),
 attempts int NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 lease_owner text, lease_until timestamptz, published_at timestamptz,
 dead_at timestamptz
);
CREATE TABLE IF NOT EXISTS meet_dist.inbox (
 consumer_id text NOT NULL, event_id uuid NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(consumer_id,event_id)
);
CREATE TABLE IF NOT EXISTS meet_dist.report_requests (
 id uuid PRIMARY KEY, meeting_id text NOT NULL, room_id text NOT NULL,
 requester_id text NOT NULL, portal_job_id text, state text NOT NULL DEFAULT 'pending'
 CHECK(state IN ('pending','submitted','failed')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(meeting_id,room_id,id)
);
