-- Avatar tiers now carry the plan names: BASIC, PRO, BUSINESS, ENTERPRISE (were BASIC, MODERATE, ELITE).
-- Existing rows keep their meaning: MODERATE becomes PRO and ELITE becomes ENTERPRISE. BUSINESS is new and sits between them.
ALTER TYPE "AvatarTier" RENAME VALUE 'MODERATE' TO 'PRO';
ALTER TYPE "AvatarTier" RENAME VALUE 'ELITE' TO 'ENTERPRISE';
ALTER TYPE "AvatarTier" ADD VALUE 'BUSINESS' BEFORE 'ENTERPRISE';
