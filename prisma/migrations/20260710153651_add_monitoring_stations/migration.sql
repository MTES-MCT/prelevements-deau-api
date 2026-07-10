-- CreateEnum
CREATE TYPE "MonitoringStationType" AS ENUM ('PIEZOMETER', 'FLOW_STATION');

-- CreateEnum
CREATE TYPE "GroundwaterObservationKind" AS ENUM ('CHRONICLE', 'REALTIME');

-- CreateEnum
CREATE TYPE "RiverFlowObservationGranularity" AS ENUM ('REALTIME', 'DAILY', 'MONTHLY');

-- CreateTable
CREATE TABLE "MonitoringStation" (
    "id" UUID NOT NULL,
    "type" "MonitoringStationType" NOT NULL,
    "stationCode" TEXT NOT NULL,
    "siteCode" TEXT,
    "providerLabel" TEXT,
    "longitude" DOUBLE PRECISION,
    "latitude" DOUBLE PRECISION,
    "metadata" JSON NOT NULL DEFAULT '{}',
    "lastMetadataSyncAt" TIMESTAMP(3),
    "lastRealtimeSyncAt" TIMESTAMP(3),
    "lastHistoricalSyncAt" TIMESTAMP(3),
    "lastFullSyncAt" TIMESTAMP(3),
    "lastSyncAttemptAt" TIMESTAMP(3),
    "lastSyncSuccessAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitoringStation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoneMonitoringStation" (
    "id" UUID NOT NULL,
    "zoneId" UUID NOT NULL,
    "monitoringStationId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoneMonitoringStation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroundwaterObservation" (
    "id" UUID NOT NULL,
    "monitoringStationId" UUID NOT NULL,
    "kind" "GroundwaterObservationKind" NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL,
    "measurementDate" DATE NOT NULL,
    "levelNgf" DOUBLE PRECISION,
    "depth" DOUBLE PRECISION,
    "status" TEXT,
    "qualification" TEXT,
    "raw" JSON NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroundwaterObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiverFlowObservation" (
    "id" UUID NOT NULL,
    "monitoringStationId" UUID NOT NULL,
    "granularity" "RiverFlowObservationGranularity" NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL,
    "valueLitersPerSecond" DOUBLE PRECISION NOT NULL,
    "producedAt" TIMESTAMP(3),
    "statusCode" INTEGER,
    "status" TEXT,
    "methodCode" INTEGER,
    "method" TEXT,
    "qualificationCode" INTEGER,
    "qualification" TEXT,
    "raw" JSON NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiverFlowObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MonitoringStation_type_idx" ON "MonitoringStation"("type");

-- CreateIndex
CREATE INDEX "MonitoringStation_lastSyncSuccessAt_idx" ON "MonitoringStation"("lastSyncSuccessAt");

-- CreateIndex
CREATE UNIQUE INDEX "MonitoringStation_type_stationCode_key" ON "MonitoringStation"("type", "stationCode");

-- CreateIndex
CREATE INDEX "ZoneMonitoringStation_zoneId_enabled_idx" ON "ZoneMonitoringStation"("zoneId", "enabled");

-- CreateIndex
CREATE INDEX "ZoneMonitoringStation_monitoringStationId_idx" ON "ZoneMonitoringStation"("monitoringStationId");

-- CreateIndex
CREATE UNIQUE INDEX "ZoneMonitoringStation_zoneId_monitoringStationId_key" ON "ZoneMonitoringStation"("zoneId", "monitoringStationId");

-- CreateIndex
CREATE INDEX "GroundwaterObservation_monitoringStationId_measurementDate_idx" ON "GroundwaterObservation"("monitoringStationId", "measurementDate");

-- CreateIndex
CREATE INDEX "GroundwaterObservation_monitoringStationId_kind_measuredAt_idx" ON "GroundwaterObservation"("monitoringStationId", "kind", "measuredAt");

-- CreateIndex
CREATE UNIQUE INDEX "GroundwaterObservation_monitoringStationId_kind_measuredAt_key" ON "GroundwaterObservation"("monitoringStationId", "kind", "measuredAt");

-- CreateIndex
CREATE INDEX "RiverFlowObservation_monitoringStationId_granularity_measur_idx" ON "RiverFlowObservation"("monitoringStationId", "granularity", "measuredAt");

-- CreateIndex
CREATE UNIQUE INDEX "RiverFlowObservation_monitoringStationId_granularity_measur_key" ON "RiverFlowObservation"("monitoringStationId", "granularity", "measuredAt");

-- AddForeignKey
ALTER TABLE "ZoneMonitoringStation" ADD CONSTRAINT "ZoneMonitoringStation_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneMonitoringStation" ADD CONSTRAINT "ZoneMonitoringStation_monitoringStationId_fkey" FOREIGN KEY ("monitoringStationId") REFERENCES "MonitoringStation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroundwaterObservation" ADD CONSTRAINT "GroundwaterObservation_monitoringStationId_fkey" FOREIGN KEY ("monitoringStationId") REFERENCES "MonitoringStation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiverFlowObservation" ADD CONSTRAINT "RiverFlowObservation_monitoringStationId_fkey" FOREIGN KEY ("monitoringStationId") REFERENCES "MonitoringStation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
