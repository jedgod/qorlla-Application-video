-- Rolls back 001_phone_join.sql. Destroys the call ledger and its history: export them first if they are needed.
DROP TABLE IF EXISTS phone_join_replay;
DROP TRIGGER IF EXISTS phone_join_events_no_change ON phone_join_call_events;
DROP TABLE IF EXISTS phone_join_call_events;
DROP FUNCTION IF EXISTS phone_join_events_immutable();
DROP TABLE IF EXISTS phone_join_calls;
