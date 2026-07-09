CREATE TYPE "DataExportStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE "DataExport" (
  "id" UUID NOT NULL,
  "requestedByUserId" UUID NOT NULL,
  "requestedByRole" "UserRole" NOT NULL,
  "status" "DataExportStatus" NOT NULL DEFAULT 'PENDING',
  "filters" JSON NOT NULL DEFAULT '{}',
  "fileName" TEXT,
  "storageKey" TEXT,
  "rowCount" INTEGER,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DataExport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DataExport_requestedByUserId_idx" ON "DataExport"("requestedByUserId");
CREATE INDEX "DataExport_status_idx" ON "DataExport"("status");
CREATE INDEX "DataExport_createdAt_idx" ON "DataExport"("createdAt");

ALTER TABLE "DataExport"
  ADD CONSTRAINT "DataExport_requestedByUserId_fkey"
  FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
