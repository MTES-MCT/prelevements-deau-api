/*
  Warnings:

  - A unique constraint covering the columns `[declarationId]` on the table `Source` will be added. If there are existing duplicate values, this will fail.
  - Made the column `declarationId` on table `Source` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "Source" ALTER COLUMN "declarationId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Source_declarationId_key" ON "Source"("declarationId");
