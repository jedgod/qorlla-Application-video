-- The gateway's heartbeat now also says whether its SIP/RTP media bridge is present, so "the audio bridge is installed" is stored, fresh evidence
-- and not the always-false default bridge object. Additive; existing rows read as "no media bridge reported" (fail closed).
ALTER TABLE phone_gateway_health ADD COLUMN IF NOT EXISTS media_bridge boolean NOT NULL DEFAULT false;
