-- CreateEnum
CREATE TYPE "ChunkValueKind" AS ENUM ('DECLARED', 'COMPUTED');

-- AlterTable
ALTER TABLE "ChunkValue" ADD COLUMN "periodStart" DATE,
ADD COLUMN "periodEnd" DATE,
ADD COLUMN "valueKind" "ChunkValueKind" NOT NULL DEFAULT 'DECLARED';

-- CreateIndex
CREATE INDEX "ChunkValue_chunkId_valueKind_metricTypeCode_idx" ON "ChunkValue"("chunkId", "valueKind", "metricTypeCode");
