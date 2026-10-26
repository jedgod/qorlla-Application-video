#!/bin/sh
# Least-privilege role for the portal (runs once at database initialisation, as the bootstrap superuser).
# It can only touch the portal schema: no DDL, no access to MAIN's sync tables, DELETE only where the product needs it.
set -e
: "${PORTAL_DB_PASSWORD:?PORTAL_DB_PASSWORD is required}"
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v pw="$PORTAL_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE qorlla_portal_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qorlla_portal_app') \gexec
GRANT CONNECT ON DATABASE qorlla_main TO qorlla_portal_app;
GRANT USAGE ON SCHEMA portal TO qorlla_portal_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA portal TO qorlla_portal_app;
GRANT DELETE ON portal.members TO qorlla_portal_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA portal TO qorlla_portal_app;
REVOKE ALL ON SCHEMA public FROM qorlla_portal_app;
SQL
