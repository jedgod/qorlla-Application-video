BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS voice_identities (
 user_id uuid PRIMARY KEY, extension text NOT NULL UNIQUE CHECK (extension ~ '^QRL-[0-9]{9}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS voice_extension_seq START 100000000;
CREATE TABLE IF NOT EXISTS voice_country_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES voice_identities(user_id),
 country_code char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
 kind text NOT NULL CHECK (kind IN ('ip_suggestion','verified_residency','verified_business')),
 verified_by text, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_evidence_lookup ON voice_country_evidence(user_id, country_code, kind, created_at DESC);
CREATE TABLE IF NOT EXISTS voice_number_inventory (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL, provider_number_id text NOT NULL,
 e164 text NOT NULL UNIQUE CHECK (e164 ~ '^\+[1-9][0-9]{1,14}$'), country_code char(2) NOT NULL,
 status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','assigned','quarantined','retired')),
 capabilities jsonb NOT NULL DEFAULT '{}'::jsonb, UNIQUE(provider, provider_number_id)
);
CREATE TABLE IF NOT EXISTS voice_number_assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES voice_identities(user_id),
 inventory_id uuid NOT NULL REFERENCES voice_number_inventory(id),
 status text NOT NULL CHECK (status IN ('pending','active','suspended','release_pending','released','failed')),
 provider_operation_id text, request_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id, request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_current_number_per_user ON voice_number_assignments(user_id)
 WHERE status IN ('pending','active','suspended','release_pending');
CREATE UNIQUE INDEX IF NOT EXISTS one_current_owner_per_number ON voice_number_assignments(inventory_id)
 WHERE status IN ('pending','active','suspended','release_pending');
CREATE TABLE IF NOT EXISTS voice_provider_events (
 provider text NOT NULL, event_id text NOT NULL, payload_hash text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(provider,event_id)
);
CREATE TABLE IF NOT EXISTS voice_audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor text NOT NULL, subject_user_id uuid,
 action text NOT NULL, resource_id uuid, details jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION voice_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'voice audit events are append-only'; END $$;
DROP TRIGGER IF EXISTS voice_audit_no_mutation ON voice_audit_events;
CREATE TRIGGER voice_audit_no_mutation BEFORE UPDATE OR DELETE ON voice_audit_events
 FOR EACH ROW EXECUTE FUNCTION voice_audit_immutable();
CREATE TABLE IF NOT EXISTS voice_outbox (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, assignment_id uuid NOT NULL REFERENCES voice_number_assignments(id),
 action text NOT NULL CHECK (action IN ('provision','release')),
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','done','dead')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(assignment_id, action)
);
COMMIT;
