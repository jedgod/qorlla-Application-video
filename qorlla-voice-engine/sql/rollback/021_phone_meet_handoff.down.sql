-- Manual rollback of 021_phone_meet_handoff.sql. Not run by db:migrate. Take a pg_dump first. Idempotent.
DROP TABLE IF EXISTS voice_handoffs;
