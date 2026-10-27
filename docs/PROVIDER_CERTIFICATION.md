# v4.6 provider and production certification - how to run each gate

All runners live in `cert/provider/` and write evidence next to themselves. Each one **refuses to run** (status BLOCKED, exit 2) unless every input exists, never writes secrets into evidence, and the Stripe runner also refuses anything but `sk_test_` keys. `node cert/build-v46-report.mjs` turns the evidence into `cert/WORKPLACE_V4_6_REPORT.md`, `..._GATE_MATRIX.json` and `..._PROVIDER_EVIDENCE.json`.

| Gate | Command | Needs |
|---|---|---|
| P1 AI | `node cert/provider/run-ai-cert.mjs` (`--self-test` checks only the scorer) | `AI_LLM_API_KEY`, `AI_LLM_MODEL`, `AI_PRICE_IN_PER_MTOK`, `AI_PRICE_OUT_PER_MTOK`, `AI_DPA_APPROVED=yes` (a data-processing agreement exists). Only the synthetic dataset in the file is ever sent. Thresholds are in `THRESHOLDS` and were fixed before any real run. |
| P2 Twilio | `node cert/provider/run-twilio-cert.mjs` | Twilio credentials, a provisioned number registered in the portal, an authorised callee phone with a tester present, a public HTTPS portal with telephony enabled, owner session, DB read access. Recording/transcription are exercised only if the operator had already approved and configured `TELEPHONY_COMPLIANCE_ACK`. |
| P3 Stripe | `node cert/provider/run-stripe-cert.mjs` | Stripe TEST secret key + webhook endpoint secret, public HTTPS portal in billing test mode, owner and platform-admin sessions of a fresh Basic test workspace, DB access. Live keys and `BILLING_LIVE_AUTHORIZED` abort the run. |
| P4a/b | `cert/stack-up.ps1`, then `node cert/run-load.mjs <env>` or `node cert/run-backup-restore.mjs <env>`, each on a **fresh** stack (the backup drill fails when run straight after the load drill) | Docker. Load results are only meaningful on an idle, production-like host. |
| P4c-f | copy `ops-approvals.example.json` to `ops-approvals.json` | Real, signed results: portal DB restore + key recovery test, approved RPO/RTO + backup monitoring, >= 3 physical devices, an independent signed security review. |
