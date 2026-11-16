-- Reverses sql/v4_34_files_transcripts.sql. Deletes shared-file METADATA and all transcript data (sessions, consents, segments). Stored file objects on disk are NOT touched here:
-- remove FILES_DIR/clean and FILES_DIR/quarantine separately if the files must go too. Roll the code back first or together.
BEGIN;
DROP TABLE IF EXISTS more_transcript_chunks;
DROP TABLE IF EXISTS more_transcript_segments;
DROP TABLE IF EXISTS more_transcript_consents;
DROP TABLE IF EXISTS more_transcript_sessions;
DROP TABLE IF EXISTS more_files;
COMMIT;
