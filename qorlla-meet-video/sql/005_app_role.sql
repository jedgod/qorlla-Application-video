-- Least-privilege application role for Meet. Run AFTER every other migration, as the database owner (psql, not a GUI):
--   psql -v app_pw="$MEET_APP_DB_PASSWORD" -f sql/005_app_role.sql
-- Safe to re-run after later migrations (the role is created once; grants are re-applied).
SELECT format('CREATE ROLE qorlla_meet_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'app_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qorlla_meet_app') \gexec
GRANT CONNECT ON DATABASE qorlla_meet TO qorlla_meet_app;
GRANT USAGE ON SCHEMA public TO qorlla_meet_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO qorlla_meet_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO qorlla_meet_app;
-- Recording consent (v4.7): consents and the audit trail are APPEND-ONLY for the application role (it may INSERT and SELECT, never UPDATE or DELETE them).
DO $$ BEGIN
  IF to_regclass('public.recording_consents') IS NOT NULL THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON recording_consents FROM qorlla_meet_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON recording_audit FROM qorlla_meet_app;
    REVOKE DELETE, TRUNCATE ON recording_sessions FROM qorlla_meet_app;
  END IF;
  -- Collaboration (v4.8): note revisions and poll ballots/voters are append-only for the application role.
  IF to_regclass('public.poll_ballots') IS NOT NULL THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON meeting_notes_revisions FROM qorlla_meet_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON poll_ballots FROM qorlla_meet_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON poll_voters FROM qorlla_meet_app;
  END IF;
  -- Recording storage (v4.9): AI consent is append-only; the audit/consent tables are also protected by triggers for every role.
  IF to_regclass('public.ai_consents') IS NOT NULL THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON ai_consents FROM qorlla_meet_app;
  END IF;
END $$;
-- Rows the application itself deletes in normal operation (each statement exists in server/): the encrypted chunks of a recording when the host deletes it or its retention ends, a person's note-editor grant, a poll draft, and
-- expired phone attempts. Without DELETE these fail with "permission denied" under this role (a 500 when the host deletes a recording; retention could never shred the media). Nothing else gains DELETE; the audit, consent and
-- numbers tables above stay append-only.
DO $$ BEGIN
  IF to_regclass('public.recording_chunks') IS NOT NULL THEN GRANT DELETE ON recording_chunks TO qorlla_meet_app; END IF;
  IF to_regclass('public.notes_editors') IS NOT NULL THEN GRANT DELETE ON notes_editors TO qorlla_meet_app; END IF;
  IF to_regclass('public.meeting_polls') IS NOT NULL THEN GRANT DELETE ON meeting_polls TO qorlla_meet_app; END IF;
  IF to_regclass('public.phone_attempts') IS NOT NULL THEN GRANT DELETE ON phone_attempts TO qorlla_meet_app; END IF;
END $$;
-- Numbers & Plans authority (v4.16). The audit trail is append-only (also for PUBLIC and for inherited/default privileges: only direct, explicit grants are given here, and the trigger refuses UPDATE/DELETE/TRUNCATE for every role).
-- The application may NOT delete numbers, operations or outbox rows, and may not truncate anything; identity columns are protected by trigger. Marking outbox rows delivered is UPDATE, which it keeps.
DO $$ BEGIN
  IF to_regclass('public.qphone_audit') IS NOT NULL THEN
    REVOKE ALL ON qphone_audit FROM PUBLIC;
    REVOKE UPDATE, DELETE, TRUNCATE ON qphone_audit FROM qorlla_meet_app;
  END IF;
  IF to_regclass('public.qphone_number_outbox') IS NOT NULL THEN
    REVOKE DELETE, TRUNCATE ON qphone_number_outbox, qphone_provider_operations, qphone_numbers, qphone_accounts, qphone_assignment_conflicts FROM qorlla_meet_app;
  END IF;
  IF to_regclass('public.phone_lifecycle_outbox') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON phone_lifecycle_outbox FROM qorlla_meet_app;
  END IF;
  IF to_regclass('public.phone_lifecycle_delivery') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON phone_lifecycle_delivery FROM qorlla_meet_app;
  END IF;
  IF to_regclass('public.phone_lifecycle_legacy_baseline') IS NOT NULL THEN
    REVOKE ALL ON phone_lifecycle_legacy_baseline FROM qorlla_meet_app;
  END IF;
END $$;
