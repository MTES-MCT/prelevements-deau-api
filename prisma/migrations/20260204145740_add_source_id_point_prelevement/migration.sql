/*
  Warnings:

  - A unique constraint covering the columns `[sourceId]` on the table `PointPrelevement` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "PointPrelevement" ADD COLUMN     "sourceId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PointPrelevement_sourceId_key" ON "PointPrelevement"("sourceId");
