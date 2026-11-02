# v1.9 source findings

1. Browser SDK previously sent SDP/ICE without `leaseToken` and `generation`, while server required both. Fixed in this audited copy.
2. Browser SDK previously did not stop media on `device_claimed` takeover. Added local cleanup upon notification; offline and lost-event cases remain unverified.
3. Lease refresh previously only emitted `lease_lost` while leaving the microphone active. Changed to cleanup before reporting.
4. The voice engine's README explicitly states that its v1.9 code is not production certified.
5. The actual Qorlla root is a different application architecture; no direct merge is safe without auth and persistence adapters.
