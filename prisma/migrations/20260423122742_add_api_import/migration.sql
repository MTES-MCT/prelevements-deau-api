/*
  Warnings:

  - A unique constraint covering the columns `[apiImportId]` on the table `Source` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ApiImportStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "Source" ADD COLUMN     "apiImportId" UUID,
ALTER COLUMN "declarationId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ApiImport" (
    "id" UUID NOT NULL,
    "declarantUserId" UUID NOT NULL,
    "rawPayload" JSONB,
    "status" "ApiImportStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiImport_declarantUserId_idx" ON "ApiImport"("declarantUserId");

-- CreateIndex
CREATE INDEX "ApiImport_status_idx" ON "ApiImport"("status");

-- CreateIndex
CREATE INDEX "ApiImport_createdAt_idx" ON "ApiImport"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Source_apiImportId_key" ON "Source"("apiImportId");

-- CreateIndex
CREATE INDEX "Source_apiImportId_idx" ON "Source"("apiImportId");

-- AddForeignKey
ALTER TABLE "ApiImport" ADD CONSTRAINT "ApiImport_declarantUserId_fkey" FOREIGN KEY ("declarantUserId") REFERENCES "Declarant"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_apiImportId_fkey" FOREIGN KEY ("apiImportId") REFERENCES "ApiImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
