-- Qorlla Workplace - consent-fence hardening from the independent review. Reverse with sql/rollback/011_consent_hardening.down.sql.
--  * meet_consent_watermark: the highest Meet revision the portal has EVER seen per meeting. An answer below it (a restored backup, a stale replica, a replay) is refused: the fence only works if Meet's numbers never go backwards.
--  * the host attestation row can be revoked (revoked_at set once) but never un-revoked, edited or deleted by the application.
BEGIN;
CREATE TABLE IF NOT EXISTS portal.meet_consent_watermark (
  meet_meeting_id uuid PRIMARY KEY,
  revision bigint NOT NULL CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION portal.meeting_ai_consents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'portal.meeting_ai_consents rows cannot be deleted'; END IF;
  IF OLD.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'a revoked consent cannot be changed or restored'; END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.meet_meeting_id IS DISTINCT FROM OLD.meet_meeting_id OR NEW.scope IS DISTINCT FROM OLD.scope OR NEW.basis IS DISTINCT FROM OLD.basis
     OR NEW.notice_version IS DISTINCT FROM OLD.notice_version OR NEW.notice_text IS DISTINCT FROM OLD.notice_text OR NEW.granted_by IS DISTINCT FROM OLD.granted_by OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
  THEN RAISE EXCEPTION 'only the revocation fields of a consent can be set'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS meeting_ai_consents_guard ON portal.meeting_ai_consents;
CREATE TRIGGER meeting_ai_consents_guard BEFORE UPDATE OR DELETE ON portal.meeting_ai_consents FOR EACH ROW EXECUTE FUNCTION portal.meeting_ai_consents_guard();
COMMIT;
