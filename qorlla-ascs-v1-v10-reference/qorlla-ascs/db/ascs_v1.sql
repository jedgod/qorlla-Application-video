-- PostgreSQL; adapt schema ownership to the existing Meet migration system.
BEGIN;
CREATE TABLE IF NOT EXISTS meet_ascs_shares (
 id uuid PRIMARY KEY, meeting_id uuid NOT NULL, owner_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('screen','window','tab','slides','docs','whiteboard','camera')),
 mode text NOT NULL CHECK(mode IN ('content','standout','side-by-side','reporter')),
 request_id text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(),
 ended_at timestamptz, revision bigint NOT NULL DEFAULT 1,
 UNIQUE(meeting_id,owner_id,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS meet_ascs_one_active ON meet_ascs_shares(meeting_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS meet_ascs_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, meeting_id uuid NOT NULL,
 share_id uuid, actor_id uuid, event_type text NOT NULL,
 payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meet_ascs_events_meeting ON meet_ascs_events(meeting_id,created_at);
COMMIT;
