-- CreateEnum
CREATE TYPE "AvatarTier" AS ENUM ('BASIC', 'MODERATE', 'ELITE');

-- CreateTable
CREATE TABLE "InbuiltAvatar" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "modelKey" TEXT NOT NULL,
    "tier" "AvatarTier" NOT NULL DEFAULT 'BASIC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InbuiltAvatar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvatarDraft" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "avatarId" TEXT NOT NULL,
    "status" "ClipStatus" NOT NULL DEFAULT 'PROCESSING',
    "videoUrl" TEXT,
    "isPromoted" BOOLEAN NOT NULL DEFAULT false,
    "promotedClipId" TEXT,
    "ownerId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AvatarDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InbuiltAvatar_slug_key" ON "InbuiltAvatar"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "AvatarDraft_promotedClipId_key" ON "AvatarDraft"("promotedClipId");

-- CreateIndex
CREATE INDEX "AvatarDraft_ownerId_organizationId_isPromoted_idx" ON "AvatarDraft"("ownerId", "organizationId", "isPromoted");

-- AddForeignKey
ALTER TABLE "AvatarDraft" ADD CONSTRAINT "AvatarDraft_avatarId_fkey" FOREIGN KEY ("avatarId") REFERENCES "InbuiltAvatar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvatarDraft" ADD CONSTRAINT "AvatarDraft_promotedClipId_fkey" FOREIGN KEY ("promotedClipId") REFERENCES "Clip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvatarDraft" ADD CONSTRAINT "AvatarDraft_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvatarDraft" ADD CONSTRAINT "AvatarDraft_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
