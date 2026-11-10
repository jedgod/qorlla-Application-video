-- Rolls back v4_29_phone_gateway_media_bridge.sql. The audio bridge then reads as not connected until it is reapplied.
ALTER TABLE phone_gateway_health DROP COLUMN IF EXISTS media_bridge;
