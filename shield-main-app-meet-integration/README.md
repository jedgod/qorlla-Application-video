# Qorlla Workplace

Video meetings, chat, mail, whiteboards, calendar, scheduling and notes on one Node server.

```bash
npm install
cp .env.example .env     # optional: set PORT, SMTP_*, PUBLIC_URL, ENCRYPT_KEY ...
npm start                # http://localhost:5000
```

Settings come from a `.env` file next to `server.js` (read by `npm start` and by the scripts in `scripts/`). Real
environment variables always take priority over the file, so a deployment can override anything without editing it.
`.env` is git-ignored. See `.env.example` for every option.

Docker: `docker compose up --build` (site on http://localhost:8080, API proxied to the backend). Compose reads the same `.env`.

## Accounts and privacy

- Mail, notes, calendar, schedule and whiteboards are **private to each account**. Chat is shared by its members.
- Passwords are scrypt-hashed. Sessions are random tokens in an HttpOnly cookie, stored only as hashes.
- Mail between accounts is delivered by username (`ann` or `ann@qorlla.local`).

### Getting back into an account

| Situation | What to do |
|---|---|
| Email is set up and the account has a **confirmed** email | "Forgot password?" on the sign-in page emails a one-hour, single-use reset link |
| Any server, with or without email | Use one of the 10 single-use **recovery codes** shown at sign-up (regenerate in Settings) |
| Neither | An operator can create a new account; there is no back door into an existing one |

Resetting a password signs the account out everywhere. Changing it in Settings signs out other devices.

## Chat

- **Instant updates:** the server pushes a tiny "something changed" nudge over a WebSocket and the page re-fetches. No message
  content travels over the socket. If the socket drops, pages fall back to checking every 3 seconds (a green dot by "Chat" shows live mode).
- **Privacy:** direct messages are only visible to the two people. Channels and shared spaces can be public (anyone can find and
  join) or private (invite only). The **creator** can flip that at any time (chat menu, Make private / Make public) and can remove people.
  `#general` and the meeting chats are public by design and cannot be made private by users.
- **Apps** (Chat, + , Get apps; each person installs their own): `/meet` starts a video room, `/roll 2d6` rolls dice,
  `/poll Question | A | B` starts a poll (one vote each, changeable, the creator can close it, nobody sees who voted for what),
  `/remind 10m take a break` posts a reminder that mentions you when it is due. Reminders survive restarts.
- **History:** each chat keeps its newest `CHAT_MAX_MESSAGES` messages (default 500, range 50-5000) in the live file. Older
  ones are moved, in small batches, to a per-chat archive (`data/workplace/chatarchive/<chatId>.json`, encrypted like everything
  else) rather than deleted. The page shows the latest 200 and a **Load earlier messages** button pages back through the rest
  (`GET /api/workplace/chat/:id/messages?before=<messageId>&limit=50`, members only). Archived polls are read-only. Deleting a chat,
  or the last member leaving, removes its archive.

## Encryption at rest (optional)

Set `ENCRYPT_KEY` (64 hex characters) and every data file is written as AES-256-GCM ciphertext. The file name is bound
to each file, so files cannot be swapped between users, and tampering is detected.

```bash
openssl rand -hex 32                      # generate a key and store it somewhere safe, OUTSIDE the data folder
export ENCRYPT_KEY=<key>
# stop the server, back up ./data, then encrypt what already exists:
node scripts/encrypt-data.js encrypt --dry-run
node scripts/encrypt-data.js encrypt
npm start
```

- **Lose the key and the data is gone.** The server refuses to start if stored data cannot be read with the configured key,
  rather than starting empty and overwriting it.
- **Rotate:** set the new key in `ENCRYPT_KEY` and the old one in `ENCRYPT_KEY_OLD`, run `node scripts/encrypt-data.js rotate`, then remove the old key.
- **Turn it off:** `node scripts/encrypt-data.js decrypt` (with the key set), then unset `ENCRYPT_KEY`.
- **What it protects:** disks, backups and volume snapshots. It does **not** hide data from someone who can read the running
  server's environment, because the key lives there.

## Email (optional)

Needed for password-reset links, email confirmation, and sending mail to addresses outside Qorlla.

| Variable | Meaning |
|---|---|
| `SMTP_URL` | e.g. `smtps://user:pass@smtp.example.com:465` or `smtp://host:587` |
| `SMTP_FROM` | sender, e.g. `"Qorlla <no-reply@example.com>"` |
| `PUBLIC_URL` | the site's public address; links in emails are built from this, never from the request. **Required in production.** Use `https://` so cookies are also marked `Secure` |
| `MAIL_DAILY_LIMIT` | outside emails per account per day (default 20) |

Rules for outside mail: the sender needs a **confirmed email address**; replies go to that address (`Reply-To`); the server
can send but **cannot receive** mail, so replies never come back into Qorlla. Without SMTP configured nothing is sent
and the app says so. For development only, `MAIL_OUTBOX=1` saves account emails to `data/auth/outbox.json`.

The startup log shows the state of both features (`[Config] ...`), and Settings shows it too.

## Other operations

- Move old shared (pre-account) data into an account: `node scripts/migrate-legacy.js <username>`
- Health check: `GET /api/health` (used by the container health check)
- Run `npm audit` before deploying; some older dependencies (e.g. `multer` 1.x) have known advisories.

## Known limits

- Sign-in, reset and recovery lockouts are saved to disk and survive restarts. They are tracked per IP address, so behind a
  reverse proxy make sure it forwards the real client address (the bundled nginx config does).
- The archive grows without limit (it is only ever appended to and removed with its chat); trim or back up `data/` as needed.
- Session cookies are marked `Secure` when `PUBLIC_URL` starts with `https://` or when the request arrives over https through a
  proxy that sets `X-Forwarded-Proto` (the bundled nginx config overwrites that header, so clients cannot fake it).
- Live updates need WebSockets; if your proxy blocks them, pages fall back to 3-second polling.
- The server stores data as JSON files, which suits a small team, not a large deployment.
- HTTPS is not terminated by this app; put it behind a reverse proxy or load balancer that does.

## Internationalization

The web pages share `i18n.js` and translation catalogs in `locales/`: Spanish
(`es.js`), French (`fr.js`), and European Portuguese (`pt-PT.js`).
The Language selector offers English, Spanish, French, and Portuguese (Portugal)
and saves the choice in
`localStorage` (`qorlla.locale`). The initial language follows the browser's
supported language, with English as the fallback. French regional browser preferences resolve to
French; `pt` and `pt-PT` resolve to European Portuguese. Other Portuguese
regions retain the fallback unless another supported browser preference exists. Changing languages reloads
the page to update dynamically rendered controls and date labels.

Use `I18n.t('English source text', { name: value })` for JavaScript UI copy
and `data-i18n="English source text"` for static HTML. Attribute translations
use `data-i18n-placeholder`, `data-i18n-title`, or `data-i18n-aria-label`.
Catalog values may contain `{name}` parameters. `I18n.date` and `I18n.number`
format values with the selected locale. Missing translations remain in English.
Only explicitly marked UI text is translated; account names, messages, notes,
and other user content retain their original text. Server error messages and
some longer help text currently retain their English fallback. The separate
mobile app and archived frontend copies are outside this web integration.

Run the language checks with `npx playwright test tests/i18n.spec.js`.

## Web product assets

The main web pages use a shared Qorlla design in `assets/product.css`, with
small keyboard and focus enhancements in `assets/product.js`. New product
copy is included in all three translation catalogs. The meeting stylesheet
is bundled as `assets/meeting.css`; no Tailwind runtime CDN or remote fonts
are required. After installing development dependencies, rebuild it when
meeting utility classes change:

```bash
npm run build:css
```

Web pages use the current HTTP(S) origin for API calls, including custom
ports and HTTPS reverse proxies. Opening a standalone HTML file retains the
local development fallback at `http://localhost:5000`.

Meeting file sharing still records metadata only; file binaries and downloads
are not implemented by the current docs service. The standalone meeting slot
scheduler is a preview tied to its demo host, with bookings held in memory.
These features need durable storage and account-aware scheduling before a
public release. The account calendar and scheduling views use the separate
persistent workplace service.

Browser tests run on an isolated server at port 5100 with temporary account
and meeting data, so `npm test` does not use or alter an existing server.
Set `PLAYWRIGHT_PORT` to choose another test port.
