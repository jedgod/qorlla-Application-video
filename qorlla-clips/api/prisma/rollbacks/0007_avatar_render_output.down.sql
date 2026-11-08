-- Reverses 0007_avatar_render_output. Run by hand, and ONLY with the previous API version deployed:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f prisma/rollbacks/0007_avatar_render_output.down.sql
--   npx prisma migrate resolve --rolled-back 0007_avatar_render_output
-- Drafts lose their script and the pointer to their render. The rendered files stay in object storage (delete them there if wanted);
-- a draft that was already saved to My clips keeps working because its Clip holds the same storage key.
DROP INDEX "AvatarDraft_storageKey_key";
ALTER TABLE "AvatarDraft" DROP COLUMN "mimeType", DROP COLUMN "script", DROP COLUMN "sizeBytes", DROP COLUMN "storageKey";
