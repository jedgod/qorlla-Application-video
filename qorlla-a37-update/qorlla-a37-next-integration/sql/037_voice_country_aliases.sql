-- ADAPT to existing principal and extension PK types and migration conventions.
-- This table is an alias index, NOT a second number authority.
-- Keep retired rows forever to prevent reassignment.
CREATE TABLE IF NOT EXISTS voice_country_aliases (
  account_id text PRIMARY KEY,
  extension_id text NOT NULL UNIQUE,
  iso_country char(2) NOT NULL,
  national text NOT NULL,
  canonical_national text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','retired')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CHECK (canonical_national ~ '^[0-9]{4,15}$')
);
CREATE INDEX IF NOT EXISTS voice_country_alias_country_lookup
  ON voice_country_aliases(iso_country,canonical_national) WHERE status='active';
-- The real integration MUST add FKs to the engine's authoritative accounts and
-- extensions and deny direct DML to ordinary application principals.
