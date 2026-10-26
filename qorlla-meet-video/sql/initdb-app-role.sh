#!/bin/sh
# docker-entrypoint-initdb.d hook: create the least-privilege Meet role after all migrations ran.
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v app_pw="$MEET_APP_DB_PASSWORD" -f /meet-sql/005_app_role.sql
