-- Least-privilege application role for Meet. Run AFTER every other migration, as the database owner (psql, not a GUI):
--   psql -v app_pw="$MEET_APP_DB_PASSWORD" -f sql/005_app_role.sql
-- Safe to re-run after later migrations (the role is created once; grants are re-applied).
SELECT format('CREATE ROLE qorlla_meet_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'app_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qorlla_meet_app') \gexec
GRANT CONNECT ON DATABASE qorlla_meet TO qorlla_meet_app;
GRANT USAGE ON SCHEMA public TO qorlla_meet_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO qorlla_meet_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO qorlla_meet_app;
