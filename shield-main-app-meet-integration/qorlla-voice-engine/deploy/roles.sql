-- Least-privilege database roles for Qorlla Voice (v1.9). Placeholders: {{APP_ROLE}} {{APP_PASSWORD}} {{SCHEMA}} {{OWNER}} (the migration role that owns the tables).
--   * the MIGRATION role owns the schema and runs sql/*.sql (it is used only by `npm run db:migrate`, never by the running service);
--   * the APP role is what the service and its outbox worker connect as: data access only, no DDL, no TRUNCATE, no superuser, and no access to the certification record.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{{APP_ROLE}}') THEN
    CREATE ROLE {{APP_ROLE}} LOGIN PASSWORD '{{APP_PASSWORD}}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA {{SCHEMA}} TO {{APP_ROLE}};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA {{SCHEMA}} TO {{APP_ROLE}};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA {{SCHEMA}} TO {{APP_ROLE}};
ALTER DEFAULT PRIVILEGES FOR ROLE {{OWNER}} IN SCHEMA {{SCHEMA}} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {{APP_ROLE}};
ALTER DEFAULT PRIVILEGES FOR ROLE {{OWNER}} IN SCHEMA {{SCHEMA}} GRANT USAGE, SELECT ON SEQUENCES TO {{APP_ROLE}};
REVOKE ALL ON {{SCHEMA}}.voice_certification_runs FROM {{APP_ROLE}};
