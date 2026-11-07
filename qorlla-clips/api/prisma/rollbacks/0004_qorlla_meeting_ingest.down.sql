-- Reverses 0004_qorlla_meeting_ingest. Prisma has no "down" migrations, so this is run by hand, and ONLY with the old API version deployed.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f prisma/rollbacks/0004_qorlla_meeting_ingest.down.sql
--   npx prisma migrate resolve --rolled-back 0004_qorlla_meeting_ingest
-- Clips that came from Qorlla Meeting keep their rows and links; only the meeting id (used to de-duplicate repeat deliveries) is lost.
-- PostgreSQL cannot remove a value from an enum, so "QORLLA_MEETING" stays in the ClipSource type: it is unused by the old code and harmless.
DROP INDEX IF EXISTS "Clip_organizationId_externalId_key";
ALTER TABLE "Clip" DROP COLUMN IF EXISTS "externalId";
