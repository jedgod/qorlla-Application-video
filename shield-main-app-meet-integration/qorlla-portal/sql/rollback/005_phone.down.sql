-- Reverses sql/005_phone.sql. DESTROYS phone numbers, routes, call history, voicemails, appointments and receptionist profiles. Back up first.
BEGIN;
DELETE FROM portal.entitlements WHERE feature IN ('phone.minutes_per_month','ai.call_summaries_per_month','phone.numbers_max');
DELETE FROM portal.ai_usage_events WHERE feature IN ('call_summary','phone_minutes');
ALTER TABLE portal.ai_usage_events DROP CONSTRAINT IF EXISTS ai_usage_events_feature_check;
ALTER TABLE portal.ai_usage_events ADD CONSTRAINT ai_usage_events_feature_check CHECK (feature IN ('meeting_report','llm_input_tokens','llm_output_tokens'));
DROP TABLE IF EXISTS portal.phone_ai_jobs;
DROP TABLE IF EXISTS portal.telephony_events;
DROP TABLE IF EXISTS portal.appointments;
DROP TABLE IF EXISTS portal.voicemails;
DROP TABLE IF EXISTS portal.receptionist_calls;
DROP TABLE IF EXISTS portal.call_sessions;
DROP TABLE IF EXISTS portal.call_routes;
DROP TABLE IF EXISTS portal.phone_numbers;
DROP TABLE IF EXISTS portal.business_closures;
DROP TABLE IF EXISTS portal.business_hours;
DROP TABLE IF EXISTS portal.receptionist_profiles;
COMMIT;
