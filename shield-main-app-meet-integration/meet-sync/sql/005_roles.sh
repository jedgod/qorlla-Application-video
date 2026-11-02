#!/bin/sh
# Least-privilege application role for MAIN (runs once at database initialisation, as the bootstrap superuser).
# The web app and the sync worker connect as qorlla_app: no superuser/DDL, no DELETE or TRUNCATE on the sync tables.
set -e
: "${QORLLA_APP_DB_PASSWORD:?QORLLA_APP_DB_PASSWORD is required}"
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v app_pw="$QORLLA_APP_DB_PASSWORD" <<'SQL'
CREATE ROLE qorlla_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE qorlla_main TO qorlla_app;
GRANT USAGE ON SCHEMA public TO qorlla_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO qorlla_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO qorlla_app;
SQL
