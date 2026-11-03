# Telephone call lifecycle (Meet v4.24)

A telephone caller is **connected** only when verified, encrypted, two-way audio exists. A correct PIN, an acknowledged webhook, a host's approval and a Security Shield "allow" move a call toward `APPROVED`; none of them connect it.

```
REQUESTED -> VERIFIED -> AWAITING_HOST -> APPROVED -> MEDIA_CONNECTING -> MEDIA_CONNECTED -> TERMINATED
                                 REFUSED | TIMED_OUT | CANCELLED | ORPHANED (media for a call Meet refused, ended or timed out)
```

* `phone_calls.status` is derived: `connected` only in `MEDIA_CONNECTED` (database CHECK constraints; `MEDIA_CONNECTED` also requires `media_verified_at`). Every change is a row in the append-only `phone_call_events`.
* Meet judges the gateway's media report itself (`server/phone-lifecycle.mjs audioVerified`): state `audio_flowing`, >= 25 packets each way, >= 500 ms, encrypted, codec in opus/PCMU/PCMA, fresh, plus the one-time media token. Synthetic evidence is accepted only for the test double.
* Timeouts (all computed by the database): `PHONE_APPROVAL_TIMEOUT_MS` (120 s), `PHONE_MEDIA_TIMEOUT_MS` (30 s), `PHONE_MEDIA_STALE_MS` (45 s without a passing report ends a connected call), `PHONE_HANGUP_CONFIRM_MS` (60 s) and `PHONE_ORPHAN_AFTER_MS` (5 min) for unconfirmed hang-ups. `PHONE_SWEEP_MS` (5 s) runs the sweeper on every replica.
* Security Shield: asked before `APPROVED`, before `MEDIA_CONNECTED`, and on the Shield re-check interval for every open call. Any failure to get an answer is a refusal. Mandatory in gateway mode.
* Gateway mode (`PHONE_GATEWAY_KEYS_JSON`, `PHONE_GATEWAY_SUBJECTS_JSON` and `PHONE_GATEWAY_ENABLED=true`; **all off by default**): only the gateway's own ES256 identity (audience `qorlla-phone-gateway`, scopes per subject, kid rotation, one-use jti and request budget in PostgreSQL, body hash, mTLS binding unless `PHONE_GATEWAY_REQUIRE_MTLS=false`), and admission needs all six readiness conditions (`/api/phone/ivr/readiness`).
* Routes: `POST /api/phone/ivr/{verify,media,disconnect,status,consent,gateway-health}`, `GET /api/phone/ivr/calls/:ref/decision`, `GET /api/phone/ivr/readiness`, `GET /api/integrations/phone/meetings/:number` (bridge secret), `GET /api/integrations/telephony/phone-readiness` (bridge secret).
* Tests: `qorlla-meet-video/tests/phone-lifecycle.pg.test.mjs` and `phone-server.pg.test.mjs` (`PHONE_TEST_DATABASE_URL`).

Telephone dial-in remains BLOCKED: there is no carrier and no media gateway. Nothing here is certification evidence.
