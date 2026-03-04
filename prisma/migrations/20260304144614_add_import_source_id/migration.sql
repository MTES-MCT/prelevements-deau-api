/*
  Warnings:

  - A unique constraint covering the columns `[importSourceId]` on the table `Declaration` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Declaration" ADD COLUMN     "importSourceId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Declaration_importSourceId_key" ON "Declaration"("importSourceId");
