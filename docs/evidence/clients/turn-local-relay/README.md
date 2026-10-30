# Local relay evidence (coturn in a throwaway loopback container)

Scope: a LOCAL mechanism test. Both participants and the relay were on one PC. This is NOT cross-network, NAT, cellular or staging evidence. Release stays BLOCKED.

- `udp-relay-meeting.json`: PASSED. Both participants' nominated pair is relay/relay over UDP; audio and video counters grew both ways; 0 packets lost; RTT about 80 ms. Also: coturn refused a wrong password (401) and an expired, correctly signed credential (401); a valid credential got a relay candidate (control).
- `tcp-relay-attempt-NOT-PROVEN.json`: the credential checks with `transport=tcp` passed (a relay candidate was allocated over TCP), but the relay-only MEETING did not connect (relay pairs stayed in-progress with 0 bytes sent; coturn logged `udp send: Operation not permitted` on the relay-to-peer leg of the loopback Docker setup). TCP relay media is therefore NOT demonstrated and must be tested on the staging relay.

No secrets, credentials, meeting ids, participant ids or addresses are recorded.
