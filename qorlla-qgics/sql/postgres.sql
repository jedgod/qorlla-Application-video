CREATE SCHEMA IF NOT EXISTS qgics;
CREATE TABLE IF NOT EXISTS qgics.users (
 id UUID PRIMARY KEY, tenant_id UUID NOT NULL, email TEXT NOT NULL,
 email_verified BOOLEAN NOT NULL DEFAULT FALSE, display_name TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS qgics_users_email_unique ON qgics.users (lower(email));
CREATE INDEX IF NOT EXISTS qgics_users_tenant_name ON qgics.users (tenant_id, lower(display_name));
CREATE TABLE IF NOT EXISTS qgics.number_counters (
 country_iso CHAR(2) PRIMARY KEY, next_serial BIGINT NOT NULL CHECK(next_serial >= 1)
);
CREATE TABLE IF NOT EXISTS qgics.numbers (
 user_id UUID PRIMARY KEY REFERENCES qgics.users(id),
 country_iso CHAR(2) NOT NULL, country_code VARCHAR(4) NOT NULL,
 serial BIGINT NOT NULL, issued_number VARCHAR(24) NOT NULL UNIQUE,
 assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(country_iso,serial)
);
CREATE TABLE IF NOT EXISTS qgics.extensions (
 tenant_id UUID NOT NULL, extension VARCHAR(12) NOT NULL,
 user_id UUID NOT NULL REFERENCES qgics.users(id),
 PRIMARY KEY(tenant_id,extension), UNIQUE(tenant_id,user_id)
);
CREATE TABLE IF NOT EXISTS qgics.calls (
 id UUID PRIMARY KEY, tenant_id UUID NOT NULL,
 caller_id UUID NOT NULL REFERENCES qgics.users(id),
 callee_id UUID NOT NULL REFERENCES qgics.users(id),
 media_type TEXT NOT NULL CHECK(media_type IN ('audio','video')),
 status TEXT NOT NULL CHECK(status IN ('ringing','accepted','rejected','ended','expired')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS qgics_calls_caller_idx ON qgics.calls(caller_id,created_at DESC);
CREATE INDEX IF NOT EXISTS qgics_calls_callee_idx ON qgics.calls(callee_id,created_at DESC);
CREATE TABLE IF NOT EXISTS qgics.audit (
 id BIGSERIAL PRIMARY KEY, actor_id UUID, action TEXT NOT NULL,
 subject_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
