# Zoom Workplace Clone

## Configuration
1. Copy `backend/.env.example` to `backend/.env`.
2. For email (password reset + verification) set:
   - `SMTP_URL` (e.g. `smtp://user:pass@smtp.example.com:587`)
   - `SMTP_FROM`
   - `PUBLIC_URL` — required in production. Links in emails are built from this value and never from the request Host header.
3. Optional: `ENCRYPT_KEY` (32-byte hex) for AES-256-GCM encryption at rest.

## Existing accounts
Accounts created before this update have no recovery codes or verified email. Sign in and use **Settings → Generate recovery codes**.

## Lockouts
Sign-in, password-reset, and recovery-code attempt limits reset when the server restarts.

## Still limited
* Admin access: server operator can read files unless `ENCRYPT_KEY` is set.
* Mail delivery is internal only (no external SMTP delivery of user mail).
* Chat polls every 3 seconds; each room keeps the last 500 messages.
* Meeting chats and `#general` are public.
* Only two apps are exposed.

## Run
```bash
cd backend
cp .env.example .env
# edit .env
npm install
node server.js
```
Open `frontend/index.html` (or serve it). Register / sign in on Home. Use Settings to generate recovery codes.

## Integrated version
Everything this folder describes (the .env setup, recovery codes, email reset and verification, outside mail, persistent lockouts) is implemented in the main project, along with live chat updates, polls, reminders and chat privacy controls. See ../README.md. This folder is kept for reference only.
