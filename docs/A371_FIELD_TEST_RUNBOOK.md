# A3.7.1 field test runbook: cross-network TURN on physical devices

**Status: NOT EXECUTED. These tests need two physical devices on two independent networks and a TURN server reachable from the public internet. They cannot be run from the development machine, so every gate below is BLOCKED until someone fills in the evidence table with real results.** Nothing here may be marked passed from the automated suite.

## Setup
1. Deploy coturn as `scripts/a371-turn-up.sh` does (`--lt-cred-mech`, `--redis-userdb`, `--cli`; WITHOUT `--lt-cred-mech` coturn accepts anonymous allocations). Use TLS (`turns:` on 443) for the test, a public IP or `--external-ip`, and firewall the CLI port to the engine only.
2. Engine: `TURN_AUTH_MODE=userdb`, `TURN_URLS`, `TURN_USERDB_REDIS_URL`, `TURN_REALM`, `TURN_CREDENTIAL_SECRET` (32+ chars), `TURN_CLI_HOST/PORT/PASSWORD`, `VOICE_RELAY_ONLY=true`. Keep `VOICE_COUNTRY_ALIAS_ENABLED=false`, `VOICE_PSTN_ENABLED=false`, `VOICE_A38_ENABLED=false`.
3. Device A on home Wi-Fi, device B on a cellular network (or a different ISP). Record: build (`git rev-parse HEAD` of the engine and the web app), browsers and versions, TURN server address.

## Tests and the evidence each needs
| # | Test | How | Evidence to attach |
|---|------|-----|--------------------|
| F1 | Relay-only call across networks | Place a call A to B with `iceTransportPolicy=relay`. Open `chrome://webrtc-internals` on both. | selected candidate pair is `relay` on both sides; `bytesSent/bytesReceived` growing; screenshot or exported dump |
| F2 | Packet flow at the relay | During F1 run `ps <username>` via the coturn CLI. | CLI output showing rp/rb/sp/sb counters increasing (sanitized: usernames shortened) |
| F3 | Credential expiry | Set `TURN_CREDENTIAL_TTL_SECONDS=60`; hold a call past expiry. | what happened to media at and after expiry; refresh behaviour in the coturn log |
| F4 | ICE restart | Trigger `restartIce()` (toggle airplane mode on A for 5 s). | webrtc-internals before/after, time to recover |
| F5 | Network switching | Move A from Wi-Fi to cellular mid-call. | recovery time, candidate pair after switch |
| F6 | Suspension during a live call | Suspend A's principal while F1 is running. | time from the suspend request to the last media packet (webrtc-internals `bytesReceived` flat on B); the security budget is 3 s |
| F7 | Old credentials after suspension | On A, reconnect with the pre-suspension credentials. | allocation refused (401 in coturn log); A cannot resume the call |
| F8 | Restart | Repeat F6 after restarting the engine, and with two engine instances behind a load balancer. | same as F6 |

Sanitize before sharing: strip IP addresses of real people, tokens, TURN credentials, SDP fingerprints. Keep timestamps and counters.

## Result table (fill in; leave BLOCKED until real evidence exists)
| # | Result | Date | Operator | Commit SHA | Evidence file |
|---|--------|------|----------|------------|---------------|
| F1 | BLOCKED | | | | |
| F2 | BLOCKED | | | | |
| F3 | BLOCKED | | | | |
| F4 | BLOCKED | | | | |
| F5 | BLOCKED | | | | |
| F6 | BLOCKED | | | | |
| F7 | BLOCKED | | | | |
| F8 | BLOCKED | | | | |
