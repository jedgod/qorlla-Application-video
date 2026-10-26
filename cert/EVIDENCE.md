# Certification evidence

- Started: 2026-10-26T19:30:39.563Z
- Finished: 2026-10-26T19:31:39.285Z
- Git HEAD: `6099dab83a2111c5a4b931435aa023ba002ebe1c` (working tree DIRTY: 18 changed/untracked paths — commit before treating this SHA as the tested build)
- Tested-file fingerprints (sha256/16): workplace.js:de23499937889b83, qorlla.html:681d3df95d85e6d5, Dockerfile:1563dfe34338afd4, docker-compose.yml:b48146846c3c7e34, meet-sync/src/worker.mjs:16fbabb5c760393a, meet-sync/src/store.mjs:5cc42fe5f6f5fb17, qorlla-meet-video/server/index.js:35e80ec30484577a, qorlla-meet-video/server/recovery-service.mjs:d55003d9abb539f4
- Result: **5 passed, 1 failed, 0 not run**

| ID | Result | Check | Detail |
|---|---|---|---|
| C01 | PASS | New schedule creates a Meet mapping (pending_sync -> synced, DB rows) | source=fecd1e63-2ad6-4322-86bc-73193df31ae1 code=357727266135 uuid=439963cb-f225-4774-a660-f16b2dc5f66a |
| C12 | PASS | Leave returns to the originating MAIN page on the same host (independent session) | returned to http://localhost:5000/#home |
| C13 | PASS | Camera/mic preferences from MAIN dialog are honoured in Meet | left Meet and landed at localhost:5000 |
| C14 | FAIL | Browser: scheduled meeting with passcode prompts in the Meet lobby (wrong -> error, right -> enters) | locator.click: Timeout 30000ms exceeded. Call log: [2m  - waiting for locator('.card.ev').filter({ hasText: 'Cert primary EDITED' }).first().locator('button').filter({ hasText: 'Join' })[22m  |
| C14a | PASS | Passcode enforced server-side (wrong/missing -> 403, correct -> 200) |  |
| C16 | PASS | Two browsers: real (fake-device) media between peers, chat, and recovery after network disruption | video tiles flowing on host after disruption: 2 |
