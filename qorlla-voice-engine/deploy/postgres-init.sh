#!/bin/sh
# Runs once, as the database superuser, when the staging database is first created: two roles and a database owned by the migration role (see deploy/roles.sql).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE qorlla_voice_migrator LOGIN PASSWORD '$MIGRATOR_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE qorlla_voice_app LOGIN PASSWORD '$APP_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE qorlla_voice OWNER qorlla_voice_migrator;
SQL
