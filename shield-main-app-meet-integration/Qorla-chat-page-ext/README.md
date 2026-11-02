# Zoom Chat Page

## Limits / Notes
- **Not built yet**: Folder, "Join a channel", and "Get apps" show a "not available yet" notice.
- Plain messages are **not** real direct messages between accounts. There is no sign-in. People are told apart by their name and a per-tab ID.
- **Unread counts**: Starter messages are pre-marked as read so a new browser/tab does not count them as unread. Unread state is stored in localStorage (per browser).
- **Docker**: Dockerfile and nginx.conf include chat.html. Not built or run here.

## Run
Open `index.html` in a browser, or:

```bash
docker compose up --build
# then visit http://localhost:8080 or http://localhost:8080/chat.html
```
