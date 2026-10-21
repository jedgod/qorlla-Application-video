# Zoom Chat Page

Matches the Zoom Chat interface from the screenshots:

- Left sidebar with Shared spaces, Starred, Chats & Channels
- Filter pills (All / @ / 💬 / ⋯)
- Blue + button → New menu (Message, Channel, Folder, Shared space, Invite, Join, Apps)
- Settings gear → Show unread only, Filter by, Sort by, Mark all as read
- ⋯ more menu with Channels, Meeting chats, Starred, etc.
- Empty state with blue bubble
- Embedded chat view when you click a conversation (sample messages + send)

Just open `index.html` in a browser. No backend required.

## Integrated version
This page now lives in the main project as `../chat.html` (served at http://localhost:5000/chat.html)
and is linked from the Chat item in the Qorlla sidebar. Conversations and messages are stored by the
backend (`/api/workplace/chat`). This folder is kept for reference only.
