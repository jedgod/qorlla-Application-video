-- Qorlla Workplace v4.3 - AI Receptionist and Phone. Reverse with sql/rollback/005_phone.down.sql (drops call history and voicemails: back up first).
-- Nothing here places or answers a call by itself: telephony stays OFF until a provider is configured AND the compliance acknowledgement is set.
BEGIN;

CREATE TABLE IF NOT EXISTS portal.receptionist_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  enabled boolean NOT NULL DEFAULT false,
  timezone text NOT NULL DEFAULT 'UTC',
  greeting_text text NOT NULL DEFAULT 'Thank you for calling. How can we help you?',
  closed_greeting_text text NOT NULL DEFAULT 'Our office is closed right now.',
  voicemail_prompt text NOT NULL DEFAULT 'Please leave a message after the tone.',
  recording_notice text NOT NULL DEFAULT 'Please note that your voicemail message will be recorded.',
  voicemail_enabled boolean NOT NULL DEFAULT true,
  escalation_numbers text[] NOT NULL DEFAULT '{}' CHECK (cardinality(escalation_numbers) <= 5),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
CREATE TABLE IF NOT EXISTS portal.business_hours (
  profile_id uuid NOT NULL REFERENCES portal.receptionist_profiles(id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),            -- 0 = Sunday
  opens time NOT NULL, closes time NOT NULL CHECK (closes > opens),
  PRIMARY KEY (profile_id, weekday, opens)
);
CREATE TABLE IF NOT EXISTS portal.business_closures (
  profile_id uuid NOT NULL REFERENCES portal.receptionist_profiles(id) ON DELETE CASCADE,
  on_date date NOT NULL, reason text, PRIMARY KEY (profile_id, on_date)
);
CREATE TABLE IF NOT EXISTS portal.phone_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  e164 text NOT NULL CHECK (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  label text, provider text NOT NULL DEFAULT 'twilio', provider_sid text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
  profile_id uuid REFERENCES portal.receptionist_profiles(id) ON DELETE SET NULL,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (e164)
);
CREATE TABLE IF NOT EXISTS portal.call_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  profile_id uuid NOT NULL REFERENCES portal.receptionist_profiles(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 50),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  hours text NOT NULL DEFAULT 'any' CHECK (hours IN ('open','closed','any')),
  digit text CHECK (digit ~ '^[0-9*#]$'),                                  -- menu key that selects this rule
  caller_prefix text CHECK (caller_prefix ~ '^\+[0-9]{1,15}$'),
  action text NOT NULL CHECK (action IN ('forward','voicemail','message','escalate','hangup')),
  destination text CHECK (destination ~ '^\+[1-9][0-9]{6,14}$'),
  message text CHECK (length(message) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, position),
  CHECK (action <> 'forward' OR destination IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS portal.call_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_e164 text, to_e164 text, number_id uuid REFERENCES portal.phone_numbers(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated','ringing','in_progress','completed','busy','no_answer','failed','canceled')),
  provider text NOT NULL DEFAULT 'twilio', provider_call_sid text,
  initiated_by uuid, started_at timestamptz NOT NULL DEFAULT now(), answered_at timestamptz, ended_at timestamptz, duration_seconds integer,
  recording_basis text NOT NULL DEFAULT 'none' CHECK (recording_basis IN ('none','notice_played')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_call_sid)
);
CREATE INDEX IF NOT EXISTS call_sessions_ws_idx ON portal.call_sessions(workspace_id, started_at DESC);
CREATE TABLE IF NOT EXISTS portal.receptionist_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  call_session_id uuid NOT NULL UNIQUE REFERENCES portal.call_sessions(id) ON DELETE CASCADE,
  profile_id uuid REFERENCES portal.receptionist_profiles(id) ON DELETE SET NULL,
  route_id uuid REFERENCES portal.call_routes(id) ON DELETE SET NULL,
  hours_state text CHECK (hours_state IN ('open','closed')),
  outcome text NOT NULL DEFAULT 'greeted' CHECK (outcome IN ('greeted','forwarded','voicemail','escalated','message_played','hung_up','appointment_booked')),
  digits text, escalated_at timestamptz, escalation_acknowledged_by uuid, escalation_acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS portal.voicemails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  call_session_id uuid REFERENCES portal.call_sessions(id) ON DELETE SET NULL,
  profile_id uuid REFERENCES portal.receptionist_profiles(id) ON DELETE SET NULL,
  from_e164 text, provider_recording_sid text NOT NULL, recording_url text NOT NULL, duration_seconds integer,
  transcript text, transcript_status text NOT NULL DEFAULT 'none' CHECK (transcript_status IN ('none','received')),
  ai_summary text, summary_status text NOT NULL DEFAULT 'none' CHECK (summary_status IN ('none','queued','done','failed','blocked')),
  listened_by uuid, listened_at timestamptz, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_recording_sid)
);
CREATE INDEX IF NOT EXISTS voicemails_ws_idx ON portal.voicemails(workspace_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS portal.appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  profile_id uuid REFERENCES portal.receptionist_profiles(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  attendee_name text NOT NULL CHECK (length(attendee_name) BETWEEN 1 AND 120), attendee_phone text CHECK (attendee_phone ~ '^\+[1-9][0-9]{6,14}$'), attendee_email text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','phone')), call_session_id uuid REFERENCES portal.call_sessions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled')),
  idempotency_key text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS appointments_slot_idx ON portal.appointments(workspace_id, profile_id, starts_at) WHERE status = 'booked';
-- every provider callback exactly once (replay protection / idempotency)
CREATE TABLE IF NOT EXISTS portal.telephony_events (
  provider text NOT NULL, event_id text NOT NULL, kind text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL,
  PRIMARY KEY (provider, event_id)
);
-- AI summaries of calls/voicemails use the same leased queue pattern as meeting reports
CREATE TABLE IF NOT EXISTS portal.phone_ai_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  voicemail_id uuid NOT NULL REFERENCES portal.voicemails(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','blocked','cancelled')),
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_token uuid,
  error_code text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE (voicemail_id)
);

-- usage meters (reuse the AI usage ledger) and plan entitlements
ALTER TABLE portal.ai_usage_events DROP CONSTRAINT IF EXISTS ai_usage_events_feature_check;
ALTER TABLE portal.ai_usage_events ADD CONSTRAINT ai_usage_events_feature_check CHECK (feature IN ('meeting_report','llm_input_tokens','llm_output_tokens','call_summary','phone_minutes'));
INSERT INTO portal.entitlements(plan_slug, feature, quota, description) VALUES
  ('basic','phone.minutes_per_month',60,'Phone minutes per month'), ('pro','phone.minutes_per_month',1500,'Phone minutes per month'),
  ('business','phone.minutes_per_month',6000,'Phone minutes per month'), ('enterprise','phone.minutes_per_month',NULL,'Phone minutes per month'),
  ('basic','ai.call_summaries_per_month',5,'AI call summaries per month'), ('pro','ai.call_summaries_per_month',300,'AI call summaries per month'),
  ('business','ai.call_summaries_per_month',3000,'AI call summaries per month'), ('enterprise','ai.call_summaries_per_month',NULL,'AI call summaries per month'),
  ('basic','phone.numbers_max',1,'Phone numbers'), ('pro','phone.numbers_max',5,'Phone numbers'), ('business','phone.numbers_max',25,'Phone numbers'), ('enterprise','phone.numbers_max',NULL,'Phone numbers')
ON CONFLICT (plan_slug, feature) DO NOTHING;
COMMIT;
