# Qorlla Installable Clients — development package

This is a buildable **client foundation**, not certified production installers. No installer binaries are included. The existing Qorlla backend must be deployed and tested before distribution.

## Desktop
`cd apps/desktop && npm install && npm run dev` (set `QORLLA_APP_URL=https://your-verified-qorlla-host.example` first). `npm run dist` produces installers on a supported build host with signing configured. Desktop loads the existing web client from a configured HTTPS origin, without introducing a second login implementation.

## Mobile
`cd apps/mobile && npm install && npx expo start`. The mobile client offers a native home and deep links to the existing HTTPS meeting and sign-in pages. **Native audio/video, push, callkit and offline messaging are not yet integrated.** Do not market it as a completed calling app.

## Security and release blockers
- Set the production web origin and Android/iOS app IDs, domain association, Apple team, signing keys, privacy policy and support URL.
- Validate JWT/CSRF/session behavior on desktop; verify permission prompts and camera/mic/screen sharing on each OS.
- Build Android AAB and iOS IPA with Expo EAS after configuring EAS and store credentials.
- Set up code signing/notarization, update channel, reproducible CI builds, SBOM and release checksums.
- Keep PSTN and number alias features disabled until Qorlla certification gates pass.
- Never embed API secrets, signing keys or privileged service tokens in either app.
