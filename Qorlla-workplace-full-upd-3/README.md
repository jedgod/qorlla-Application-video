# Zoom Workplace Clone

## What's still not ideal
* Messages beyond the cap (500) are archived to `data/archive/<room>.jsonl` rather than dropped. Live view still shows the latest 500; fetch `/api/chat/:room/archive` for older ones.
* Live updates use WebSockets. If a proxy blocks them, the frontend falls back to polling every 3 seconds.
* Lockouts are tracked per IP address. Behind a proxy the real client address must be passed (the bundled `deploy/nginx.conf` sets `X-Real-IP` and `X-Forwarded-For`). Lockouts reset when the server restarts.

## Configuration
Copy `backend/.env.example` to `backend/.env`.
- `SMTP_URL`, `SMTP_FROM`, `PUBLIC_URL` (required in production; links never use the request Host header)
- Optional `ENCRYPT_KEY` (32-byte hex) for encryption at rest

## Existing accounts
Accounts created before recovery-code support have none. Sign in → Settings → Generate recovery codes.

## Run
```bash
cd backend
cp .env.example .env   # edit
npm install
node server.js
```
Or with Docker:
```bash
cd deploy
docker compose up --build
```
Open http://localhost:8080

Frontend tries WebSocket first; falls back to polling if the connection fails.

## Integrated version
The archive of older chat messages, the proxy configuration (real client address and protocol) and the rest of this folder are
implemented in the main project: older messages move to an encrypted per-chat archive with a "Load earlier messages" button, and
`nginx.conf` forwards `X-Real-IP`, `X-Forwarded-For` and `X-Forwarded-Proto`. See `../README.md`. This folder is kept for reference only.
