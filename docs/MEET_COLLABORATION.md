# Qorlla Meet - notes, polls and More (v4.0.2 sidebar upgrade)

All of this is backed by PostgreSQL (`sql/v4_8_collab.sql`) and enforced on the server (`server/collab.mjs`). The browser only presents it.

## Notes
- Sections: Agenda (checklist), Notes (text), Key decisions, Action items (owner, due date, done). Decisions/tasks are stamped with the meeting time they were added.
- Autosave (about 1.2 s after typing) with a visible Saved / Saving / Offline state; offline edits are kept and retried.
- Saves apply only the sections the client changed, onto the current document, so two editors in different sections never overwrite each other. Two people editing the SAME section: last save wins (no character-level merging).
- Edit rights: the host, plus participants the host grants (`POST .../notes/editors`). Everyone else reads. After the meeting ends, participants can still read; nobody (even the host) can edit.
- Revisions (`meeting_notes_revisions`, append-only for the app role): a snapshot when an author saves more than 30 s after their last one, on templates, on "Save version" and on restore. The current notes are always the latest text. Restore is host-only and adds a new revision.
- Templates: agenda, minutes, brainstorming, lecture, project review. Export: Markdown, plain text, copy. **PDF and DOCX export are not implemented.** Search across notes and AI summaries are not implemented.

## Polls
- Types: single, multiple, yes/no, rating (3/5/10), ranking (Borda score). Options: anonymous, live results, quiz mode (correct answer, explanation), time limit (auto-closes), drafts.
- Server rules: only the host creates/launches/closes/publishes/exports/deletes; one ballot per participant (`poll_voters`); answers validated per type; results are hidden from participants until the host publishes (or live results are on); drafts are invisible to guests.
- Anonymous polls: `poll_ballots.participant_id` is NULL and ballots have no timestamp, so a ballot cannot be tied to a person; CSV export of an anonymous poll is aggregate only. Non-anonymous exports list names; spreadsheet formula characters are neutralised.
- Not implemented: a reusable poll library across meetings, PDF/report export, presenter role.

## More tab
Expandable groups. Whiteboard, breakout rooms, shared files, Q&A, AI summary/transcription/translation, attendance and meeting lock are shown as "Planned" and disabled; they are not faked.

## Rate limiting
In-meeting calls with a valid meeting token are limited per participant (`MEETING_RATE_LIMIT`, default 600/min) instead of per IP, so people sharing one address do not throttle each other. Requests without a valid token keep the 90/min per-IP limit.

## Operations
Apply `sql/v4_8_collab.sql` before `005_app_role.sql` (compose mounts it; `npm run dev:stack` applies it on start). Tests: `qorlla-portal/e2e/meet-collab.spec.js`.
