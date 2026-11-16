-- Requires migrations 001 and 002. Run on disposable PG first.
ALTER TABLE meet_breakouts.assignments ADD COLUMN IF NOT EXISTS move_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE meet_breakouts.assignments ADD COLUMN IF NOT EXISTS media_status text NOT NULL DEFAULT 'unknown'
 CHECK(media_status IN ('unknown','switching','client_reported','failed'));
ALTER TABLE meet_breakouts.assignments ADD COLUMN IF NOT EXISTS media_reported_at timestamptz;
CREATE TABLE IF NOT EXISTS meet_breakouts.room_lead_grants (
 occurrence_id text NOT NULL, room_id uuid NOT NULL, participant_id text NOT NULL,
 capability text NOT NULL CHECK(capability IN ('help_triage','room_announcement','room_notes','room_polls')),
 granted_by text NOT NULL, PRIMARY KEY(occurrence_id,room_id,participant_id,capability),
 FOREIGN KEY(occurrence_id,room_id) REFERENCES meet_breakouts.rooms(occurrence_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS meet_breakouts.move_commands (
 id uuid PRIMARY KEY, occurrence_id text NOT NULL, participant_id text NOT NULL,
 from_room uuid, to_room uuid, epoch bigint NOT NULL, state text NOT NULL
 CHECK(state IN ('pending','client_reported','failed','superseded')),
 issued_at timestamptz NOT NULL DEFAULT now(), reported_at timestamptz,
 UNIQUE(occurrence_id,participant_id,epoch)
);
CREATE TABLE IF NOT EXISTS meet_breakouts.outbox (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, occurrence_id text NOT NULL,
 event_kind text NOT NULL, audience text NOT NULL, payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
 lease_owner text, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS outbox_pending ON meet_breakouts.outbox(id) WHERE delivered_at IS NULL;
