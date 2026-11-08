-- Reverses 0008_avatar_draft_duration. Run by hand, and ONLY with the previous API version deployed:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f prisma/rollbacks/0008_avatar_draft_duration.down.sql
--   npx prisma migrate resolve --rolled-back 0008_avatar_draft_duration
-- Drafts lose their recorded length. Clips that were already saved keep theirs (Clip.durationMs).
ALTER TABLE "AvatarDraft" DROP COLUMN "durationMs";
