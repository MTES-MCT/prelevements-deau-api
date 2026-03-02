/*
  Warnings:

  - A unique constraint covering the columns `[sourceId]` on the table `Declarant` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Declarant_sourceId_key" ON "Declarant"("sourceId");
