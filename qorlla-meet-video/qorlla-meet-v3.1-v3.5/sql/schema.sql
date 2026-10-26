CREATE TABLE IF NOT EXISTS meetings (
 id uuid PRIMARY KEY, title varchar(160) NOT NULL, host_secret_hash text NOT NULL,
 passcode_hash text, created_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
 notes text NOT NULL DEFAULT '', locked boolean NOT NULL DEFAULT false, meeting_code varchar(12) UNIQUE
);
CREATE TABLE IF NOT EXISTS participants (
 id uuid PRIMARY KEY, meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
 display_name varchar(70) NOT NULL, role varchar(12) NOT NULL CHECK(role IN ('host','guest')),
 joined_at timestamptz NOT NULL DEFAULT now(), left_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_participants_meeting ON participants(meeting_id);
CREATE TABLE IF NOT EXISTS messages (
 id uuid PRIMARY KEY, meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
 participant_id uuid NOT NULL REFERENCES participants(id), body varchar(4000) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_meeting ON messages(meeting_id, created_at);
CREATE TABLE IF NOT EXISTS polls (
 id uuid PRIMARY KEY, meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
 question varchar(300) NOT NULL, options jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS poll_votes (
 poll_id uuid NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
 participant_id uuid NOT NULL REFERENCES participants(id), choice integer NOT NULL,
 PRIMARY KEY(poll_id,participant_id)
);
CREATE TABLE IF NOT EXISTS audit_events (
 id bigserial PRIMARY KEY, meeting_id uuid REFERENCES meetings(id) ON DELETE SET NULL,
 participant_id uuid, event_type varchar(70) NOT NULL, detail jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
