-- Qorlla Meet shared room events (v4.32): a PostgreSQL transactional event log + outbox so several Meet instances stay consistent about breakout rooms. Idempotent.
-- Run as the database owner BEFORE sql/005_app_role.sql, AFTER sql/v4_31_breakout_classroom.sql.
-- Rollback: DROP TABLE more_room_outbox, more_room_inbox, more_room_events;
-- PostgreSQL is the source of truth. The bus (LISTEN/NOTIFY, or Redis Streams when configured) only says "event N exists"; every instance reads the event itself from this table, so a lost or duplicated
-- bus message can never change what happened. Events carry NO chat text, notes or answers: only what is needed to route a notification and to tell a page to reload.
BEGIN;
CREATE TABLE IF NOT EXISTS more_room_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  origin     text NOT NULL,                                   -- the instance that produced it (it already delivered to its own sockets)
  audience   jsonb NOT NULL,                                  -- {scope: roomId|null|"*", hosts: bool, only: participantId|null, except: participantId|null}
  type       text NOT NULL CHECK (length(type) BETWEEN 1 AND 64),
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(payload) <= 8192),
  replay     boolean NOT NULL DEFAULT false,                  -- may a reconnecting page be shown it again (a state notification), or is it only ever live
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS more_room_events_meeting ON more_room_events (meeting_id, id);
CREATE INDEX IF NOT EXISTS more_room_events_age ON more_room_events (created_at);
CREATE TABLE IF NOT EXISTS more_room_outbox (
  event_id     bigint PRIMARY KEY REFERENCES more_room_events(id) ON DELETE CASCADE,
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','published','dead')),
  attempts     integer NOT NULL DEFAULT 0,
  next_attempt timestamptz NOT NULL DEFAULT now(),
  lease_owner  text,
  lease_token  uuid,
  leased_until timestamptz,
  last_error   text,
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS more_room_outbox_ready ON more_room_outbox (next_attempt) WHERE state IN ('pending','leased');
-- idempotent consumption: an instance handles an event once, even if the bus delivers it twice or two workers race
CREATE TABLE IF NOT EXISTS more_room_inbox (
  consumer   text NOT NULL,
  event_id   bigint NOT NULL REFERENCES more_room_events(id) ON DELETE CASCADE,
  handled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
COMMIT;
