-- AlterTable
ALTER TABLE "AvatarDraft" ADD COLUMN     "mimeType" TEXT,
ADD COLUMN     "script" TEXT,
ADD COLUMN     "sizeBytes" BIGINT,
ADD COLUMN     "storageKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AvatarDraft_storageKey_key" ON "AvatarDraft"("storageKey");

