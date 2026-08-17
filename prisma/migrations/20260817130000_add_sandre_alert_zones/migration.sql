CREATE TYPE "SandreAlertZoneType" AS ENUM ('SUP', 'SOU');
CREATE TYPE "SandreAlertZoneStatus" AS ENUM ('VALIDATED', 'FROZEN');

CREATE TABLE "SandreAlertZone" (
    "id" UUID NOT NULL,
    "codeSandre" TEXT NOT NULL,
    "gid" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "type" "SandreAlertZoneType" NOT NULL,
    "status" "SandreAlertZoneStatus" NOT NULL,
    "departmentCode" TEXT NOT NULL,
    "basinCode" INTEGER NOT NULL,
    "version" INTEGER,
    "influencedResource" BOOLEAN NOT NULL,
    "alternateCodes" JSONB NOT NULL DEFAULT '[]',
    "preferredAlternateCode" TEXT,
    "sourceUpdatedAt" DATE NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "coordinates" geometry(MultiPolygon,4326),
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SandreAlertZone_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SandreAlertZone_status_active_check" CHECK (
      ("status" = 'VALIDATED' AND "active" = true AND "coordinates" IS NOT NULL)
      OR ("status" = 'FROZEN' AND "active" = false)
    )
);

CREATE TABLE "SandreAlertZoneSyncState" (
    "departmentCode" TEXT NOT NULL,
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "featureCount" INTEGER,
    "snapshotHash" TEXT,
    "sourceUpdatedAt" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SandreAlertZoneSyncState_pkey" PRIMARY KEY ("departmentCode")
);

CREATE UNIQUE INDEX "SandreAlertZone_codeSandre_key" ON "SandreAlertZone"("codeSandre");
CREATE INDEX "SandreAlertZone_departmentCode_idx" ON "SandreAlertZone"("departmentCode");
CREATE INDEX "SandreAlertZone_type_active_idx" ON "SandreAlertZone"("type", "active");
CREATE INDEX "SandreAlertZone_status_idx" ON "SandreAlertZone"("status");
CREATE INDEX "SandreAlertZone_gid_idx" ON "SandreAlertZone"("gid");
CREATE INDEX "SandreAlertZone_coordinates_idx" ON "SandreAlertZone" USING GIST ("coordinates");
