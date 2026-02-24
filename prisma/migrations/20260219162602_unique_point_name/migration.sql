/*
  Warnings:

  - A unique constraint covering the columns `[name]` on the table `PointPrelevement` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Declaration" ALTER COLUMN "startMonth" DROP NOT NULL,
ALTER COLUMN "endMonth" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "PointPrelevement_name_key" ON "PointPrelevement"("name");
