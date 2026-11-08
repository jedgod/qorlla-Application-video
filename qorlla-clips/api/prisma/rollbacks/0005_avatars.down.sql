-- Reverses 0005_avatars. Prisma has no "down" migrations, so this is run by hand, and ONLY with the old API version deployed.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f prisma/rollbacks/0005_avatars.down.sql
--   npx prisma migrate resolve --rolled-back 0005_avatars
-- Avatar drafts and the avatar catalog are deleted. Clips that were promoted from a draft are real clips and are NOT touched.
DROP TABLE IF EXISTS "AvatarDraft";
DROP TABLE IF EXISTS "InbuiltAvatar";
DROP TYPE IF EXISTS "AvatarTier";
