/*
  Warnings:

  - A unique constraint covering the columns `[bssId]` on the table `MonitoringStation` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "MonitoringStation" ADD COLUMN     "bssId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "MonitoringStation_bssId_key" ON "MonitoringStation"("bssId");
