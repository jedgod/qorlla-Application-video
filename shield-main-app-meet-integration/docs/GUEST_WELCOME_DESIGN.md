# Guest Welcome design integration

Route `/guest/welcome` (plus the join, pre-join, explore and help views) now follows the supplied design, built in `guest.html` / `guest.js` with plain HTML, CSS and JS. No new backend, no React, no second auth path.

* **Routes**: Join Meeting `/guest/join-meeting`; Use meeting link `?mode=link`; Enter meeting ID `?mode=id` (only changes the prompt, validation is unchanged); Explore `/guest/explore`; Help `/guest/help` (`#guide`, `#videos`, `#faq`); Create Account `/auth/register` (`?type=organization|individual` is carried but not yet used by sign-up); Sign in `/auth/login`. Chat/Phone/Docs/Whiteboards/Clips in the rail and the Explore card are **preview anchors on `/guest/explore`**; they never open a workspace module.
* **Preserved**: pre-join validation (server `resolve`), camera/microphone test, session issuance at pre-join, return-to-meeting after sign-in, localization (es/fr/pt-PT).
* **Assets**: `assets/guest-globe.webp` (31 KB) is cropped and compressed from the supplied reference art; icons are an inline SVG sprite (the repository has no icon set, only the favicon). Logo is the existing `Qorlla-Logo.jpg`.
* **Responsive**: rail 128 px (desktop), 92 px (<=1100), bottom tab bar (<=700, Whiteboards and Settings dropped from the bar; reachable from More/Explore and Help).
* **Evidence**: `docs/evidence/guest-welcome/` (1536x1024, 820x1180, 390x844 and a side-by-side with the reference). Tests: `tests/guest-welcome.spec.js`.

## Remaining visual differences from the reference
1. The simulated desktop-window chrome (minimise/maximise/close) is omitted: it would be inert, misleading controls in a browser. The language selector sits top-right as in the design but uses the app's shared control.
2. Header logo is the existing JPG wordmark, not a freshly drawn Q mark.
3. Icons are simplified line icons, not the reference's multi-colour glyphs; tile icon plates use gradients close to the reference.
4. The globe is a crop of the reference art, so framing/glow differ slightly; the benefit sub-lines are single-line at desktop width.
5. Tile description wrapping differs by a line in Join Meeting / Explore because font metrics differ from the render.
6. Accessibility: automated axe scanning is not installed in this repository; checks are scripted assertions (landmarks, accessible names, alt text, keyboard path, visible focus). Colour contrast was not machine-verified.
7. Security remains governed by `docs/V4_6_1_GUEST_SECURITY.md`; this change grants no access by itself.
