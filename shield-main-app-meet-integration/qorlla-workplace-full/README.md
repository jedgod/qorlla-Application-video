# Zoom Workplace Clone – Frontend + Backend

## Features
1. Mail
2. Whiteboard
3. Calendar
4. Schedule
5. My Notes

## Backend
Node.js + Express (simple REST APIs with in-memory / JSON file storage)

## Frontend
Single-page HTML/CSS/JS (vanilla) that talks to the backend.

## How to run
1. Backend:
   ```bash
   cd backend
   npm install
   node server.js
   ```
   Runs on http://localhost:3000

2. Open frontend/index.html in a browser (or serve it).
   Update API_BASE in frontend/app.js if needed.

## APIs
- Mail: /api/mail
- Whiteboard: /api/whiteboard
- Calendar: /api/calendar
- Schedule: /api/schedule
- Notes: /api/notes

## Integrated version
The Mail, Whiteboard, Calendar, Schedule and Notes services from this folder now live in the
main project: `../workplace.js` (API at `/api/workplace/*`, served by `../server.js` on port 5000)
and the UI in `../qorlla.html`. Run `npm start` in the parent folder and open http://localhost:5000.
This folder is kept for reference and is no longer needed to run the app.
