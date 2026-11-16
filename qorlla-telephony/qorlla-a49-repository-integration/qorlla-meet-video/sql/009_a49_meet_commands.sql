-- Run in the Meet database, separate from Portal's database.
BEGIN;
CREATE TABLE IF NOT EXISTS a49_waiting_calls (
  call_id uuid PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES meetings(id),
  decision text NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','approved','denied','removed')),
  host_participant_id uuid REFERENCES participants(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE(meeting_id,call_id)
);
CREATE TABLE IF NOT EXISTS a49_command_receipts (
  command_id uuid PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES a49_waiting_calls(call_id),
  meeting_id uuid NOT NULL REFERENCES meetings(id),
  action text NOT NULL CHECK(action IN ('admit','deny','mute','remove','end')),
  status text NOT NULL CHECK(status IN ('applied','rejected')),
  media_peer_joined boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
