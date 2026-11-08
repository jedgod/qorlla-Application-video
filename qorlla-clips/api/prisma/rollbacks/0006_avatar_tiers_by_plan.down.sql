-- Reverses 0006_avatar_tiers_by_plan. Run by hand, and ONLY with the previous API version deployed:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollbacks/0006_avatar_tiers_by_plan.down.sql
--   npx prisma migrate resolve --rolled-back 0006_avatar_tiers_by_plan
-- PostgreSQL cannot remove an enum value, so "BUSINESS" stays in the type. Avatars on it are moved to the old middle tier first (a
-- separate transaction from the renames, because a value added in 0006 cannot be used in the transaction that added it).
UPDATE "InbuiltAvatar" SET "tier" = 'PRO' WHERE "tier" = 'BUSINESS';
ALTER TYPE "AvatarTier" RENAME VALUE 'PRO' TO 'MODERATE';
ALTER TYPE "AvatarTier" RENAME VALUE 'ENTERPRISE' TO 'ELITE';
