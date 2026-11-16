BEGIN;
CREATE TABLE IF NOT EXISTS meet_collab.audio_chunks (
 session_id uuid NOT NULL REFERENCES meet_collab.transcript_sessions(id) ON DELETE CASCADE,
 chunk_id uuid NOT NULL,
 speaker_id text NOT NULL,
 epoch bigint NOT NULL,
 status text NOT NULL CHECK(status IN ('processing','done','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 PRIMARY KEY(session_id,chunk_id)
);
CREATE INDEX IF NOT EXISTS audio_chunks_cleanup ON meet_collab.audio_chunks(created_at);
COMMIT;
