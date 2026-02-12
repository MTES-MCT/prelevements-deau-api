-- CreateEnum
CREATE TYPE "MetricQuality" AS ENUM ('SUSPECT', 'ANOMALY');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('DECLARATION', 'BATCH', 'API');

-- CreateEnum
CREATE TYPE "SourceStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "Metric" (
    "id" UUID NOT NULL,
    "pointPrelevementId" UUID,
    "pointPrelevementName" TEXT,
    "meterId" UUID,
    "metricTypeCode" TEXT NOT NULL,
    "unit" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "value" DECIMAL(20,4) NOT NULL,
    "sourceId" UUID NOT NULL,
    "quality" "MetricQuality",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Metric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StageMetric" (
    "id" UUID NOT NULL,
    "pointPrelevementId" UUID,
    "pointPrelevementName" TEXT,
    "metricTypeCode" TEXT NOT NULL,
    "unit" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "value" DECIMAL(20,4) NOT NULL,
    "sourceId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StageMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Source" (
    "id" UUID NOT NULL,
    "type" "SourceType" NOT NULL,
    "status" "SourceStatus" NOT NULL DEFAULT 'PENDING',
    "metadata" JSONB,
    "start" DATE,
    "end" DATE,
    "declarationId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Metric_pointPrelevementId_idx" ON "Metric"("pointPrelevementId");

-- CreateIndex
CREATE INDEX "Metric_sourceId_idx" ON "Metric"("sourceId");

-- CreateIndex
CREATE INDEX "Metric_startDate_idx" ON "Metric"("startDate");

-- CreateIndex
CREATE INDEX "Metric_endDate_idx" ON "Metric"("endDate");

-- CreateIndex
CREATE INDEX "Metric_metricTypeCode_idx" ON "Metric"("metricTypeCode");

-- CreateIndex
CREATE INDEX "StageMetric_sourceId_idx" ON "StageMetric"("sourceId");

-- CreateIndex
CREATE INDEX "StageMetric_pointPrelevementId_idx" ON "StageMetric"("pointPrelevementId");

-- CreateIndex
CREATE INDEX "StageMetric_startDate_idx" ON "StageMetric"("startDate");

-- CreateIndex
CREATE INDEX "StageMetric_endDate_idx" ON "StageMetric"("endDate");

-- CreateIndex
CREATE UNIQUE INDEX "Source_declarationId_key" ON "Source"("declarationId");

-- CreateIndex
CREATE INDEX "Source_type_idx" ON "Source"("type");

-- CreateIndex
CREATE INDEX "Source_status_idx" ON "Source"("status");

-- CreateIndex
CREATE INDEX "Source_declarationId_idx" ON "Source"("declarationId");
