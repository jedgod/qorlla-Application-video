-- AlterEnum
ALTER TYPE "ClipStatus" ADD VALUE 'UPLOADING';

-- AlterTable
ALTER TABLE "Clip" ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "mimeType" TEXT,
ADD COLUMN     "partSize" INTEGER,
ADD COLUMN     "sizeBytes" BIGINT,
ADD COLUMN     "storageKey" TEXT,
ADD COLUMN     "uploadId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Clip_storageKey_key" ON "Clip"("storageKey");

