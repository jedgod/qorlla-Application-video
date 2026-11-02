-- Forward-only additive migration. Apply with migration runner under an owner role.
BEGIN;
CREATE TABLE IF NOT EXISTS qve_history_calls (
  call_id uuid PRIMARY KEY,
  room_id text NOT NULL,
  room_name text,
  direction_hint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  ended_reason text,
  last_event_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qve_history_time_order CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);
CREATE TABLE IF NOT EXISTS qve_history_participants (
  call_id uuid NOT NULL REFERENCES qve_history_calls(call_id) ON DELETE CASCADE,
  account_id text NOT NULL,
  invite_id text,
  invited_at timestamptz,
  answered_at timestamptz,
  joined_at timestamptz,
  left_at timestamptz,
  decline_at timestamptz,
  kick_at timestamptz,
  role text NOT NULL DEFAULT 'member' CHECK(role IN ('member','host')),
  final_status text CHECK(final_status IN ('missed','declined','cancelled','completed','kicked')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(call_id,account_id)
);
CREATE TABLE IF NOT EXISTS qve_history_participation_segments (
  call_id uuid NOT NULL,
  account_id text NOT NULL,
  segment_id text NOT NULL,
  joined_at timestamptz NOT NULL,
  left_at timestamptz,
  PRIMARY KEY(call_id,account_id,segment_id),
  FOREIGN KEY(call_id,account_id) REFERENCES qve_history_participants(call_id,account_id) ON DELETE CASCADE,
  CHECK(left_at IS NULL OR left_at >= joined_at)
);
CREATE TABLE IF NOT EXISTS qve_history_event_receipts (
  source text NOT NULL,
  event_id text NOT NULL,
  call_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source,event_id)
);
CREATE TABLE IF NOT EXISTS qve_history_membership_events (
  source text NOT NULL,
  event_id text NOT NULL,
  call_id uuid NOT NULL,
  subject_account_id text NOT NULL,
  actor_account_id text,
  event_type text NOT NULL CHECK(event_type IN ('invited','joined','left','kicked','host_transferred','declined')),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY(source,event_id),
  FOREIGN KEY(call_id,subject_account_id) REFERENCES qve_history_participants(call_id,account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS qve_history_recent_idx ON qve_history_participants(account_id,updated_at DESC,call_id DESC);
CREATE INDEX IF NOT EXISTS qve_history_segments_idx ON qve_history_participation_segments(call_id,account_id,joined_at);
CREATE INDEX IF NOT EXISTS qve_history_receipts_call_idx ON qve_history_event_receipts(call_id);
COMMIT;
