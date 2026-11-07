-- AlterEnum
ALTER TYPE "ClipSource" ADD VALUE 'QORLLA_MEETING';

-- AlterTable
ALTER TABLE "Clip" ADD COLUMN     "externalId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Clip_organizationId_externalId_key" ON "Clip"("organizationId", "externalId");

