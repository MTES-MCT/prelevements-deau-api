CREATE TYPE "DeclarationProcessingStatus" AS ENUM (
  'CREATED',
  'UPLOADED',
  'QUEUED',
  'PROCESSING',
  'COMPLETED',
  'FAILED'
);

ALTER TABLE "Declaration"
  ADD COLUMN "processingStatus" "DeclarationProcessingStatus" NOT NULL DEFAULT 'CREATED',
  ADD COLUMN "processingJobId" TEXT,
  ADD COLUMN "processingAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "processingQueuedAt" TIMESTAMP(3),
  ADD COLUMN "processingStartedAt" TIMESTAMP(3),
  ADD COLUMN "processingCompletedAt" TIMESTAMP(3),
  ADD COLUMN "processingFailedAt" TIMESTAMP(3),
  ADD COLUMN "processingError" TEXT;

UPDATE "Declaration" d
SET
  "processingStatus" = CASE
    WHEN s.status = 'COMPLETED' THEN 'COMPLETED'::"DeclarationProcessingStatus"
    WHEN s.status = 'FAILED' THEN 'FAILED'::"DeclarationProcessingStatus"
    WHEN EXISTS (
      SELECT 1
      FROM "DeclarationFile" f
      WHERE f."declarationId" = d.id
    ) THEN 'UPLOADED'::"DeclarationProcessingStatus"
    ELSE 'CREATED'::"DeclarationProcessingStatus"
  END,
  "processingCompletedAt" = CASE WHEN s.status = 'COMPLETED' THEN COALESCE(s."updatedAt", d."updatedAt") ELSE NULL END,
  "processingFailedAt" = CASE WHEN s.status = 'FAILED' THEN COALESCE(s."updatedAt", d."updatedAt") ELSE NULL END
FROM "Source" s
WHERE s."declarationId" = d.id;

UPDATE "Declaration" d
SET "processingStatus" = 'UPLOADED'::"DeclarationProcessingStatus"
WHERE "processingStatus" = 'CREATED'
  AND EXISTS (
    SELECT 1
    FROM "DeclarationFile" f
    WHERE f."declarationId" = d.id
  );

CREATE INDEX "Declaration_processingStatus_idx" ON "Declaration"("processingStatus");
CREATE INDEX "Declaration_processingQueuedAt_idx" ON "Declaration"("processingQueuedAt");

CREATE TABLE "DeclarationProcessingEvent" (
  "id" UUID NOT NULL,
  "declarationId" UUID NOT NULL,
  "status" "DeclarationProcessingStatus" NOT NULL,
  "message" TEXT,
  "metadata" JSONB,
  "createdByUserId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DeclarationProcessingEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DeclarationProcessingEvent"
  ADD CONSTRAINT "DeclarationProcessingEvent_declarationId_fkey"
  FOREIGN KEY ("declarationId") REFERENCES "Declaration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "DeclarationProcessingEvent_declarationId_idx" ON "DeclarationProcessingEvent"("declarationId");
CREATE INDEX "DeclarationProcessingEvent_status_idx" ON "DeclarationProcessingEvent"("status");
CREATE INDEX "DeclarationProcessingEvent_createdAt_idx" ON "DeclarationProcessingEvent"("createdAt");

CREATE TABLE "ChunkValueReplacement" (
  "id" UUID NOT NULL,
  "replacedChunkValueId" UUID NOT NULL,
  "replacedChunkId" UUID NOT NULL,
  "replacedSourceId" UUID NOT NULL,
  "replacementChunkValueId" UUID,
  "replacementChunkId" UUID,
  "replacementSourceId" UUID,
  "pointPrelevementId" UUID,
  "metricTypeCode" TEXT NOT NULL,
  "unit" TEXT,
  "frequency" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "valueKind" "ChunkValueKind" NOT NULL,
  "value" DECIMAL(20,4) NOT NULL,
  "conflictPolicy" TEXT NOT NULL,
  "replaceComment" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ChunkValueReplacement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChunkValueReplacement_replacedChunkValueId_replacementChunk_key"
  ON "ChunkValueReplacement"("replacedChunkValueId", "replacementChunkValueId");

CREATE INDEX "ChunkValueReplacement_replacedChunkValueId_idx" ON "ChunkValueReplacement"("replacedChunkValueId");
CREATE INDEX "ChunkValueReplacement_replacedChunkId_idx" ON "ChunkValueReplacement"("replacedChunkId");
CREATE INDEX "ChunkValueReplacement_replacedSourceId_idx" ON "ChunkValueReplacement"("replacedSourceId");
CREATE INDEX "ChunkValueReplacement_replacementChunkId_idx" ON "ChunkValueReplacement"("replacementChunkId");
CREATE INDEX "ChunkValueReplacement_replacementSourceId_idx" ON "ChunkValueReplacement"("replacementSourceId");
CREATE INDEX "ChunkValueReplacement_pointPrelevementId_idx" ON "ChunkValueReplacement"("pointPrelevementId");
CREATE INDEX "ChunkValueReplacement_metricTypeCode_periodStart_periodEnd_idx"
  ON "ChunkValueReplacement"("metricTypeCode", "periodStart", "periodEnd");

ALTER TABLE "ChunkValue"
  ADD CONSTRAINT "ChunkValue_period_valid_check"
  CHECK ("periodEnd" > "periodStart") NOT VALID;
