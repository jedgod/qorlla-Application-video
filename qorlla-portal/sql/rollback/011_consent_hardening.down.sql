-- Reverses sql/011_consent_hardening.sql. Removes the Meet revision watermark (the portal then trusts any revision again) and the host-attestation guard. Back up first.
BEGIN;
DROP TRIGGER IF EXISTS meeting_ai_consents_guard ON portal.meeting_ai_consents;
DROP FUNCTION IF EXISTS portal.meeting_ai_consents_guard();
DROP TABLE IF EXISTS portal.meet_consent_watermark;
COMMIT;
