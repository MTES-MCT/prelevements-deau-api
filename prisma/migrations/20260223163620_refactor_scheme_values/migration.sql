/*
  Warnings:

  - You are about to drop the column `endMonth` on the `Declaration` table. All the data in the column will be lost.
  - You are about to drop the column `startMonth` on the `Declaration` table. All the data in the column will be lost.
  - You are about to drop the column `end` on the `Source` table. All the data in the column will be lost.
  - You are about to drop the column `start` on the `Source` table. All the data in the column will be lost.
  - You are about to drop the `Metric` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `StageMetric` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "ChunkInstructionStatus" AS ENUM ('PENDING', 'REJECTED', 'VALIDATED', 'AUTOMATICALLY_VALIDATED');

-- DropForeignKey
ALTER TABLE "Metric" DROP CONSTRAINT "Metric_pointPrelevementId_fkey";

-- DropForeignKey
ALTER TABLE "Metric" DROP CONSTRAINT "Metric_sourceId_fkey";

-- DropForeignKey
ALTER TABLE "StageMetric" DROP CONSTRAINT "StageMetric_pointPrelevementId_fkey";

-- DropForeignKey
ALTER TABLE "StageMetric" DROP CONSTRAINT "StageMetric_sourceId_fkey";

-- AlterTable
ALTER TABLE "Declaration" DROP COLUMN "endMonth",
DROP COLUMN "startMonth";

-- AlterTable
ALTER TABLE "Source" DROP COLUMN "end",
DROP COLUMN "start";

-- DropTable
DROP TABLE "Metric";

-- DropTable
DROP TABLE "StageMetric";

-- DropEnum
DROP TYPE "MetricQuality";

-- CreateTable
CREATE TABLE "Chunk" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "pointPrelevementName" TEXT,
    "pointPrelevementId" UUID NOT NULL,
    "instructionStatus" "ChunkInstructionStatus" NOT NULL DEFAULT 'PENDING',
    "instructedAt" TIMESTAMP(3),
    "instructedByInstructorUserId" UUID,
    "instructionComment" TEXT,
    "startDate" DATE,
    "endDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChunkValue" (
    "id" UUID NOT NULL,
    "chunkId" UUID NOT NULL,
    "metricTypeCode" TEXT NOT NULL,
    "unit" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "value" DECIMAL(20,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChunkValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Chunk_instructionStatus_idx" ON "Chunk"("instructionStatus");

-- CreateIndex
CREATE INDEX "ChunkValue_metricTypeCode_idx" ON "ChunkValue"("metricTypeCode");

-- AddForeignKey
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_pointPrelevementId_fkey" FOREIGN KEY ("pointPrelevementId") REFERENCES "PointPrelevement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_instructedByInstructorUserId_fkey" FOREIGN KEY ("instructedByInstructorUserId") REFERENCES "Instructor"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChunkValue" ADD CONSTRAINT "ChunkValue_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "Chunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
