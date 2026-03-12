/*
  Warnings:

  - A unique constraint covering the columns `[sourceId]` on the table `Instructor` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Instructor" ADD COLUMN     "jobTitle" TEXT,
ADD COLUMN     "phoneNumber" TEXT,
ADD COLUMN     "sourceId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Instructor_sourceId_key" ON "Instructor"("sourceId");
