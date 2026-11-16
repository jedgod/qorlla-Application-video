
-- Apply only after 001_breakouts.sql in an isolated Meet database.
CREATE TABLE IF NOT EXISTS meet_breakouts.help_requests (
 id uuid PRIMARY KEY, occurrence_id text NOT NULL REFERENCES meet_breakouts.sessions(occurrence_id),
 room_id uuid NOT NULL REFERENCES meet_breakouts.rooms(id),
 requester_id text NOT NULL, status text NOT NULL DEFAULT 'open'
 CHECK(status IN ('open','acknowledged','resolved','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_help_per_participant
 ON meet_breakouts.help_requests(occurrence_id,requester_id) WHERE status='open';
CREATE INDEX IF NOT EXISTS help_by_room ON meet_breakouts.help_requests(occurrence_id,room_id,status);
CREATE TABLE IF NOT EXISTS meet_breakouts.room_content_acl (
 occurrence_id text NOT NULL REFERENCES meet_breakouts.sessions(occurrence_id),
 content_kind text NOT NULL CHECK(content_kind IN ('note','poll')),
 content_id text NOT NULL,
 room_id uuid REFERENCES meet_breakouts.rooms(id),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(occurrence_id,content_kind,content_id)
);
CREATE INDEX IF NOT EXISTS content_room_scope
 ON meet_breakouts.room_content_acl(occurrence_id,content_kind,room_id);
CREATE TABLE IF NOT EXISTS meet_breakouts.transition_requests (
 id uuid PRIMARY KEY, occurrence_id text NOT NULL REFERENCES meet_breakouts.sessions(occurrence_id),
 participant_id text NOT NULL, from_room uuid, to_room uuid,
 state text NOT NULL CHECK(state IN ('pending','acknowledged','failed')),
 created_at timestamptz NOT NULL DEFAULT now(), acknowledged_at timestamptz
);
