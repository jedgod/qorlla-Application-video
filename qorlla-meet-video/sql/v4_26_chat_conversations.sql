-- v4.26 meeting chat: private (direct) conversations inside a meeting, the host's "who can chat with whom" policy, soft delete and idempotent sends.
-- Additive only. A message with conversation_id NULL belongs to "Everyone" (the meeting's group chat), exactly as before; the integration export and the AI summary keep
-- reading ONLY those (server/index.js filters conversation_id IS NULL AND deleted_at IS NULL), so a private message never leaves its conversation.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS chat_policy varchar(8) NOT NULL DEFAULT 'group';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meetings_chat_policy_check') THEN
    ALTER TABLE meetings ADD CONSTRAINT meetings_chat_policy_check CHECK (chat_policy IN ('none', 'hosts', 'group', 'all'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS chat_conversations (
  id uuid PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES participants(id),
  member_key text NOT NULL,                       -- the sorted member ids joined with ',': one conversation per exact set of people
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, member_key)
);
CREATE TABLE IF NOT EXISTS chat_members (
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, participant_id)
);
CREATE INDEX IF NOT EXISTS chat_members_participant ON chat_members (participant_id);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES chat_conversations(id) ON DELETE CASCADE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS idempotency_key uuid;
CREATE INDEX IF NOT EXISTS messages_conversation_created ON messages (conversation_id, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_idempotency ON messages (participant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
