ALTER TABLE "Declarant" ADD COLUMN "pointManagementEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "CollectorPointManagementZone" (
  "collecteurUserId" UUID NOT NULL,
  "zoneId" UUID NOT NULL,
  CONSTRAINT "CollectorPointManagementZone_pkey" PRIMARY KEY ("collecteurUserId", "zoneId"),
  CONSTRAINT "CollectorPointManagementZone_collecteurUserId_fkey" FOREIGN KEY ("collecteurUserId") REFERENCES "Declarant"("userId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CollectorPointManagementZone_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CollectorPointManagementZone_zoneId_idx" ON "CollectorPointManagementZone"("zoneId");

CREATE TABLE "CollectorPointCreationRequest" (
  "collecteurUserId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notificationStatus" TEXT NOT NULL DEFAULT 'not_requested',
  CONSTRAINT "CollectorPointCreationRequest_pkey" PRIMARY KEY ("collecteurUserId", "requestId"),
  CONSTRAINT "CollectorPointCreationRequest_collecteurUserId_fkey" FOREIGN KEY ("collecteurUserId") REFERENCES "Declarant"("userId") ON DELETE CASCADE ON UPDATE CASCADE
);
