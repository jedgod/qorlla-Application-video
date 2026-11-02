-- Qorlla Voice Engine v1.5 (group calls): voice rooms with a host, invitations and a member roster. Media is a full mesh of one-to-one WebRTC connections (up to max_members),
-- so the server only relays signaling and never carries audio. Idempotent.
CREATE TABLE IF NOT EXISTS voice_rooms (
  id uuid PRIMARY KEY,
  host_id text NOT NULL REFERENCES voice_identities(account_id),
  title text NOT NULL DEFAULT '',
  meeting_ref text,
  status text NOT NULL CHECK (status IN ('live','ended')),
  max_members integer NOT NULL DEFAULT 6 CHECK (max_members BETWEEN 2 AND 8),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text,
  version bigint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS voice_rooms_one_live_meeting ON voice_rooms (meeting_ref) WHERE status = 'live' AND meeting_ref IS NOT NULL;
CREATE TABLE IF NOT EXISTS voice_room_members (
  room_id uuid NOT NULL REFERENCES voice_rooms(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES voice_identities(account_id),
  role text NOT NULL CHECK (role IN ('host','member')),
  status text NOT NULL CHECK (status IN ('invited','joined','left','declined','removed','missed')),
  invited_by text,
  device_id uuid,
  lease_token uuid,
  generation bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  invited_at timestamptz NOT NULL DEFAULT now(),
  joined_at timestamptz,
  left_at timestamptz,
  PRIMARY KEY (room_id, account_id)
);
CREATE INDEX IF NOT EXISTS voice_room_members_account ON voice_room_members (account_id) WHERE status IN ('invited','joined');
CREATE UNIQUE INDEX IF NOT EXISTS voice_room_one_joined ON voice_room_members (account_id) WHERE status = 'joined';
