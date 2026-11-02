# Qorlla Voice Engine v1.1 — Security and reliability patch

Apply **on top of v1.0**, not as an unrelated voice server. Compare this reference with your real Qorlla repo before merging.

## Changes
- `POST /v1/voice/ws-ticket` requires the existing bearer JWT, a permitted Origin, and an enabled voice identity. Returns a 45-second random ticket, never a JWT.
- WebSocket upgrade consumes the SHA-256-hashed ticket **atomically** in PostgreSQL, bound to browser Origin. Reuse and expiration fail.
- SDP/ICE forwarding only after the call is `active`; the callee must answer first.
- Ringing calls expire after 60 seconds via a DB-backed maintenance loop and emit missed-call state.
- Browser client obtains the ticket automatically and handles early offers after microphone preparation.
- Database migration `002_voice_security.sql` adds ticket store and timeout index.

## Deployment
1. Run the SQL migrations with a migration account. Set `VOICE_ALLOWED_ORIGIN` to exact HTTPS app origin(s).
2. Configure reverse proxy to forward Origin and WSS, disable query-string access logs for `/v1/voice/ws`, and set a strict HTTPS policy.
3. Restart the voice process; all existing WebSocket clients must reconnect using newly issued tickets.
4. Run `npm test` and complete two-device audio, disconnect, reconnect, race, and browser tests before any launch.
5. Multi-instance production needs coordinated socket delivery (e.g. Redis pub/sub), leader-elected maintenance, and stricter media-device ownership.

## Known blockers
- `VoiceClient.ts` still needs robust ICE candidate buffering, renegotiation, ICE restart, glare prevention, and reconnect handling.
- Current DB indexes do not prevent one account being a caller in one call and callee in another when different requests race; transaction advisory locks help only when all writers follow the service path. Add a participant-reservation table if any alternate write path exists.
- This is **internal VoIP only**: no PSTN, emergency calling, SIP carrier, public numbers, or meeting bridge.
- Production needs load tests, TURN credential rotation, authenticated origin/session policy, abuse controls, a real Qorlla identity adapter, and security review.
