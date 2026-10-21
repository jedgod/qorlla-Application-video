# Zoom Workplace Clone

## Still limited
* **Admin access**: the server operator can still read the files unless you set `ENCRYPT_KEY` (32-byte hex). With the key set, data is encrypted at rest (AES-256-GCM). Without it, files are plain JSON.
* **Account recovery**: there is still no password reset or email verification (`POST /api/auth/reset` returns 501).
* **Mail delivery**: mail only reaches accounts on this server, not outside addresses.

## Other notes
* Chat polls every 3 seconds; each room keeps the last 500 messages.
* Meeting chats and `#general` are public.
* Only two apps are exposed.
* Session is header-based (not a Secure cookie). Use HTTPS beyond localhost. Lockout resets on server restart.

## Optional encryption
```bash
export ENCRYPT_KEY=$(openssl rand -hex 32)
node server.js
```

## Run
```bash
cd backend
npm install
node server.js
```
Open `frontend/index.html`. Register/sign in on Home for private features.

## Integrated version
All three limits from this folder are implemented in the main project: encryption at rest (`../store.js`,
`../scripts/encrypt-data.js`), email confirmation, password reset and recovery codes (`../auth.js`), and real outside
mail through SMTP (`../mailer.js`, `../workplace.js`). See `../README.md` for setup. This folder is kept for reference only.
