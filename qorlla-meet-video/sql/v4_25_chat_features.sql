-- v4.25 meeting chat upgrade: replies, quotes (a reply with quoted text), edit, rich text, GIF and file messages, bookmarks, pins and tasks.
-- Additive only. `messages.body` stays PLAIN TEXT: the AI summary, the integration export and old clients keep reading it unchanged.
-- `body_rich` holds the canonical, server-sanitized rich-text markup (see public/chat-markup.js) and is NULL for plain messages.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to uuid REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind varchar(8) NOT NULL DEFAULT 'text';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS body_rich varchar(8000);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_kind_check') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text', 'gif', 'file'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS messages_meeting_created ON messages (meeting_id, created_at, id);

-- a person's private bookmarks
CREATE TABLE IF NOT EXISTS chat_bookmarks (
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (participant_id, message_id)
);

-- messages pinned for everybody in the meeting (host only)
CREATE TABLE IF NOT EXISTS chat_pins (
  message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  pinned_by uuid NOT NULL REFERENCES participants(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_pins_meeting ON chat_pins (meeting_id);

-- tasks created from a message
CREATE TABLE IF NOT EXISTS chat_tasks (
  id uuid PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  title varchar(250) NOT NULL,
  assignee_id uuid REFERENCES participants(id),
  due_date date,
  created_by uuid NOT NULL REFERENCES participants(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_tasks_meeting ON chat_tasks (meeting_id, created_at);

-- files attached to a message (only used when CHAT_ATTACHMENTS_ENABLED=true; bytes live in the configured directory, never in a public path)
CREATE TABLE IF NOT EXISTS chat_attachments (
  id uuid PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  uploader_id uuid NOT NULL REFERENCES participants(id),
  file_name varchar(200) NOT NULL,
  content_type varchar(60) NOT NULL,
  size_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_attachments_meeting ON chat_attachments (meeting_id);
