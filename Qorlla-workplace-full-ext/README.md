# Zoom Workplace Clone

## What's still limited
* Mail, notes, calendar, schedule and whiteboards are now **per-user** (require sign-in). Chat and meeting hosting also use accounts. Public rooms (#general, meeting chats) remain readable without auth.
* There's no password reset or email check. The session is passed via header (not a Secure cookie). Use HTTPS if you host this beyond localhost. The sign-in lockout resets when the server restarts.
* Chat updates arrive by checking every 3 seconds, and each chat keeps its last 500 messages.
* Meeting chats and #general are public, and there are only two apps (Whiteboard, Notes).

## Run
```bash
cd backend
npm install
node server.js
```
Open frontend/index.html (API base http://localhost:3000).

Register / sign in on the Home view to access Mail, Notes, Calendar, Schedule, and Whiteboard.

## Integrated version
The per-user idea from this folder now lives in the main project (`../workplace.js`, `../auth.js`,
`../qorlla.html`) with salted scrypt passwords, HttpOnly session cookies, validated input and mail
delivery between accounts. Run `npm start` in the parent folder and open http://localhost:5000.
This folder is kept for reference only. To move the old shared data into an account:
`node scripts/migrate-legacy.js <username>` (run from the parent folder).
