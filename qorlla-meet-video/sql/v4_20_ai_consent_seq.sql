-- Qorlla Meet v4.20: a monotonic order for Qorlla AI consent. Idempotent. Run as the database owner AFTER v4_19_ai_request.sql and BEFORE (or re-run after) sql/005_app_role.sql.
-- Every answer in ai_consents, and every open/close of the host's request, gets the next number from ONE sequence. The Workplace portal uses the numbers to decide, without any shared transaction,
-- whether a person objected AFTER the answer its report was based on: "objection_seq > agreed_seq" means the report must not be shown. The numbers only ever increase; rows stay append-only.
-- Rollback: ALTER TABLE ai_consents DROP COLUMN seq; ALTER TABLE meetings DROP COLUMN ai_request_seq; DROP SEQUENCE ai_consent_seq;  (the portal then fails closed: it cannot verify consent)
CREATE SEQUENCE IF NOT EXISTS ai_consent_seq;
ALTER TABLE ai_consents ADD COLUMN IF NOT EXISTS seq bigint;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS ai_request_seq bigint;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM ai_consents WHERE seq IS NULL) THEN
    PERFORM set_config('qorlla.allow_purge', 'on', true);                       -- the append-only trigger allows exactly this maintenance step, in this transaction only
    UPDATE ai_consents c SET seq = n.rn FROM (SELECT id, nextval('ai_consent_seq') AS rn FROM (SELECT id FROM ai_consents WHERE seq IS NULL ORDER BY created_at, id) o) n WHERE n.id = c.id;
    PERFORM set_config('qorlla.allow_purge', 'off', true);
  END IF;
END $$;
ALTER TABLE ai_consents ALTER COLUMN seq SET DEFAULT nextval('ai_consent_seq');
ALTER TABLE ai_consents ALTER COLUMN seq SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_consents_seq_uq ON ai_consents (seq);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qorlla_meet_app') THEN GRANT USAGE, SELECT ON SEQUENCE ai_consent_seq TO qorlla_meet_app; END IF;
END $$;
