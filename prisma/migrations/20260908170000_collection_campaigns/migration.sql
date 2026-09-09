-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "CampaignResponseKind" AS ENUM ('INDEX', 'NEEDS');

-- CreateEnum
CREATE TYPE "CampaignResponseStatus" AS ENUM ('DRAFT', 'SUBMITTED');

-- CreateEnum
CREATE TYPE "CampaignManagerRole" AS ENUM ('MANAGER', 'READER');

-- CreateEnum
CREATE TYPE "CampaignNotificationKind" AS ENUM ('OPENING', 'REMINDER', 'RECEIPT');

-- CreateEnum
CREATE TYPE "CampaignNotificationStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "PointCollectionMode" AS ENUM ('MANUAL', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "ChunkCalculationStrategy" AS ENUM ('GENERIC', 'CAMPAIGN');

-- AlterTable
ALTER TABLE "PointPrelevement" ADD COLUMN     "collectionMode" "PointCollectionMode";

-- AlterTable
ALTER TABLE "Chunk" ADD COLUMN     "calculationStrategy" "ChunkCalculationStrategy" NOT NULL DEFAULT 'GENERIC',
ADD COLUMN     "compteurId" UUID;

-- AlterTable
ALTER TABLE "ChunkValue" ADD COLUMN     "readingDate" DATE;

-- CreateTable
CREATE TABLE "Campaign" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "ownerCollecteurUserId" UUID NOT NULL,
    "zoneId" UUID NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "indexDates" JSONB NOT NULL,
    "opensAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Paris',
    "reminderDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "openingMessage" TEXT,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignPeriod" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "kind" "CampaignResponseKind" NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "startReadingDate" DATE,
    "endReadingDate" DATE,

    CONSTRAINT "CampaignPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignTarget" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "exploitationId" UUID NOT NULL,
    "pointPrelevementId" UUID NOT NULL,
    "preleveurUserId" UUID NOT NULL,
    "eligibilityConfirmed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CampaignTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignTargetMeter" (
    "id" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "associationId" UUID NOT NULL,
    "compteurId" UUID NOT NULL,
    "startDate" DATE,
    "endDate" DATE,

    CONSTRAINT "CampaignTargetMeter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignManager" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "CampaignManagerRole" NOT NULL,

    CONSTRAINT "CampaignManager_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignResponse" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "preleveurUserId" UUID NOT NULL,
    "kind" "CampaignResponseKind" NOT NULL,
    "status" "CampaignResponseStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "draft" JSONB NOT NULL DEFAULT '{}',
    "latestSubmissionId" UUID,
    "reopenedAt" TIMESTAMP(3),
    "reopenUntil" TIMESTAMP(3),
    "reopenedByUserId" UUID,
    "reopenReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignSubmission" (
    "id" UUID NOT NULL,
    "responseId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "publication" JSONB,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignNeedLine" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "periodId" UUID NOT NULL,
    "requestedFlow" DECIMAL(20,4) NOT NULL,
    "requestedVolume" DECIMAL(20,4) NOT NULL,

    CONSTRAINT "CampaignNeedLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignCoverage" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "pointPrelevementId" UUID NOT NULL,
    "preleveurUserId" UUID NOT NULL,
    "periodId" UUID NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sourceId" UUID NOT NULL,
    "chunkValueId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "CampaignCoverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignNotification" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "submissionId" UUID,
    "preleveurUserId" UUID NOT NULL,
    "kind" "CampaignNotificationKind" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "CampaignNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),

    CONSTRAINT "CampaignNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignExport" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "targetIds" JSONB NOT NULL,
    "status" "DataExportStatus" NOT NULL DEFAULT 'PENDING',
    "storageKey" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),

    CONSTRAINT "CampaignExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campaign_ownerCollecteurUserId_status_idx" ON "Campaign"("ownerCollecteurUserId", "status");

-- CreateIndex
CREATE INDEX "Campaign_zoneId_status_idx" ON "Campaign"("zoneId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignPeriod_campaignId_kind_position_key" ON "CampaignPeriod"("campaignId", "kind", "position");

-- CreateIndex
CREATE INDEX "CampaignTarget_preleveurUserId_idx" ON "CampaignTarget"("preleveurUserId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignTarget_campaignId_exploitationId_key" ON "CampaignTarget"("campaignId", "exploitationId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignTarget_campaignId_pointPrelevementId_key" ON "CampaignTarget"("campaignId", "pointPrelevementId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignTargetMeter_targetId_associationId_key" ON "CampaignTargetMeter"("targetId", "associationId");

-- CreateIndex
CREATE INDEX "CampaignManager_userId_idx" ON "CampaignManager"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignManager_campaignId_userId_key" ON "CampaignManager"("campaignId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignResponse_latestSubmissionId_key" ON "CampaignResponse"("latestSubmissionId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignResponse_campaignId_preleveurUserId_kind_key" ON "CampaignResponse"("campaignId", "preleveurUserId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignSubmission_responseId_version_key" ON "CampaignSubmission"("responseId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignSubmission_responseId_idempotencyKey_key" ON "CampaignSubmission"("responseId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignNeedLine_submissionId_targetId_periodId_key" ON "CampaignNeedLine"("submissionId", "targetId", "periodId");

-- CreateIndex
CREATE INDEX "CampaignCoverage_scope_idx" ON "CampaignCoverage"("pointPrelevementId", "preleveurUserId", "active", "periodStart", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignCoverage_submissionId_targetId_periodId_key" ON "CampaignCoverage"("submissionId", "targetId", "periodId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignNotification_dedupeKey_key" ON "CampaignNotification"("dedupeKey");

-- CreateIndex
CREATE INDEX "CampaignNotification_status_leaseUntil_idx" ON "CampaignNotification"("status", "leaseUntil");

-- CreateIndex
CREATE INDEX "CampaignNotification_campaignId_createdAt_idx" ON "CampaignNotification"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignExport_campaignId_createdAt_idx" ON "CampaignExport"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignExport_status_idx" ON "CampaignExport"("status");

-- CreateIndex
CREATE INDEX "Chunk_pointPrelevementId_compteurId_calculationStrategy_idx" ON "Chunk"("pointPrelevementId", "compteurId", "calculationStrategy");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_ownerCollecteurUserId_fkey" FOREIGN KEY ("ownerCollecteurUserId") REFERENCES "Declarant"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignPeriod" ADD CONSTRAINT "CampaignPeriod_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTarget" ADD CONSTRAINT "CampaignTarget_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTarget" ADD CONSTRAINT "CampaignTarget_exploitationId_fkey" FOREIGN KEY ("exploitationId") REFERENCES "DeclarantPointPrelevement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTarget" ADD CONSTRAINT "CampaignTarget_pointPrelevementId_fkey" FOREIGN KEY ("pointPrelevementId") REFERENCES "PointPrelevement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTarget" ADD CONSTRAINT "CampaignTarget_preleveurUserId_fkey" FOREIGN KEY ("preleveurUserId") REFERENCES "Declarant"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTargetMeter" ADD CONSTRAINT "CampaignTargetMeter_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "CampaignTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTargetMeter" ADD CONSTRAINT "CampaignTargetMeter_associationId_fkey" FOREIGN KEY ("associationId") REFERENCES "CompteurPointPrelevement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTargetMeter" ADD CONSTRAINT "CampaignTargetMeter_compteurId_fkey" FOREIGN KEY ("compteurId") REFERENCES "Compteur"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignManager" ADD CONSTRAINT "CampaignManager_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignManager" ADD CONSTRAINT "CampaignManager_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignResponse" ADD CONSTRAINT "CampaignResponse_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignResponse" ADD CONSTRAINT "CampaignResponse_preleveurUserId_fkey" FOREIGN KEY ("preleveurUserId") REFERENCES "Declarant"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignResponse" ADD CONSTRAINT "CampaignResponse_latestSubmissionId_fkey" FOREIGN KEY ("latestSubmissionId") REFERENCES "CampaignSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSubmission" ADD CONSTRAINT "CampaignSubmission_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "CampaignResponse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSubmission" ADD CONSTRAINT "CampaignSubmission_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignNeedLine" ADD CONSTRAINT "CampaignNeedLine_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "CampaignSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignNeedLine" ADD CONSTRAINT "CampaignNeedLine_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "CampaignTarget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignNeedLine" ADD CONSTRAINT "CampaignNeedLine_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "CampaignPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignCoverage" ADD CONSTRAINT "CampaignCoverage_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "CampaignSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignCoverage" ADD CONSTRAINT "CampaignCoverage_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "CampaignTarget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignCoverage" ADD CONSTRAINT "CampaignCoverage_pointPrelevementId_fkey" FOREIGN KEY ("pointPrelevementId") REFERENCES "PointPrelevement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignCoverage" ADD CONSTRAINT "CampaignCoverage_preleveurUserId_fkey" FOREIGN KEY ("preleveurUserId") REFERENCES "Declarant"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignCoverage" ADD CONSTRAINT "CampaignCoverage_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "CampaignPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignCoverage" ADD CONSTRAINT "CampaignCoverage_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignCoverage" ADD CONSTRAINT "CampaignCoverage_chunkValueId_fkey" FOREIGN KEY ("chunkValueId") REFERENCES "ChunkValue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignNotification" ADD CONSTRAINT "CampaignNotification_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignNotification" ADD CONSTRAINT "CampaignNotification_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "CampaignSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignNotification" ADD CONSTRAINT "CampaignNotification_preleveurUserId_fkey" FOREIGN KEY ("preleveurUserId") REFERENCES "Declarant"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignExport" ADD CONSTRAINT "CampaignExport_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignExport" ADD CONSTRAINT "CampaignExport_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_compteurId_fkey" FOREIGN KEY ("compteurId") REFERENCES "Compteur"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Domain guards independent of the HTTP validation.
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_window_check" CHECK ("closesAt" IS NULL OR "opensAt" IS NULL OR "closesAt" > "opensAt");
ALTER TABLE "CampaignPeriod" ADD CONSTRAINT "CampaignPeriod_bounds_check" CHECK ("endDate" > "startDate");
ALTER TABLE "CampaignPeriod" ADD CONSTRAINT "CampaignPeriod_reading_bounds_check" CHECK ("kind" <> 'INDEX' OR ("startReadingDate" IS NOT NULL AND "endReadingDate" IS NOT NULL AND "endReadingDate" > "startReadingDate"));
ALTER TABLE "CampaignNeedLine" ADD CONSTRAINT "CampaignNeedLine_nonnegative_check" CHECK ("requestedFlow" >= 0 AND "requestedVolume" >= 0);
ALTER TABLE "CampaignCoverage" ADD CONSTRAINT "CampaignCoverage_bounds_check" CHECK ("periodEnd" > "periodStart");
ALTER TABLE "CampaignTargetMeter" ADD CONSTRAINT "CampaignTargetMeter_bounds_check" CHECK ("endDate" IS NULL OR "startDate" IS NULL OR "endDate" >= "startDate");

-- A submission snapshot is append-only. Its publication can be set once by
-- the submitting transaction; subsequent corrections create another revision.
CREATE FUNCTION "protectCampaignSubmission"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."publication" IS NULL AND NEW."publication" IS NOT NULL
    AND (to_jsonb(NEW) - 'publication') = (to_jsonb(OLD) - 'publication') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Campaign submissions are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "CampaignSubmission_immutable" BEFORE UPDATE OR DELETE ON "CampaignSubmission"
FOR EACH ROW EXECUTE FUNCTION "protectCampaignSubmission"();

-- Protect every writer, including legacy connector inserts performed after
-- their application-level conflict check has released its transaction lock.
CREATE FUNCTION "protectCampaignVolumeValue"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_point_id UUID;
  v_preleveur_id UUID;
  v_strategy "ChunkCalculationStrategy";
BEGIN
  IF NEW."metricTypeCode" NOT IN ('volume', 'volume prélevé', 'volume rejeté') THEN
    RETURN NEW;
  END IF;
  SELECT c."pointPrelevementId", c."preleveurUserId", c."calculationStrategy"
    INTO v_point_id, v_preleveur_id, v_strategy
    FROM "Chunk" c WHERE c.id = NEW."chunkId";
  IF v_point_id IS NULL OR v_strategy <> 'GENERIC' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('volumes-from-index'), hashtext(v_point_id::text));
  IF EXISTS (
    SELECT 1 FROM "CampaignCoverage" coverage
    WHERE coverage.active
      AND coverage."pointPrelevementId" = v_point_id
      AND (coverage."preleveurUserId" = v_preleveur_id OR v_preleveur_id IS NULL)
      AND coverage."periodStart" < NEW."periodEnd"
      AND coverage."periodEnd" > NEW."periodStart"
  ) THEN
    RAISE EXCEPTION 'A campaign protects this volume interval' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChunkValue_campaign_coverage_guard"
BEFORE INSERT OR UPDATE OF "chunkId", "metricTypeCode", "periodStart", "periodEnd", "valueKind", "value"
ON "ChunkValue" FOR EACH ROW EXECUTE FUNCTION "protectCampaignVolumeValue"();

-- Reconciliation or late instruction must not move an old generic series
-- back into a period that has already been superseded by a campaign.
CREATE FUNCTION "protectCampaignChunkScope"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."pointPrelevementId" IS NULL OR NEW."calculationStrategy" <> 'GENERIC'
    OR NEW."instructionStatus" = 'REJECTED' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('volumes-from-index'), hashtext(NEW."pointPrelevementId"::text));
  IF EXISTS (
    SELECT 1 FROM "ChunkValue" cv JOIN "CampaignCoverage" coverage
      ON coverage.active
      AND coverage."pointPrelevementId" = NEW."pointPrelevementId"
      AND (coverage."preleveurUserId" = NEW."preleveurUserId" OR NEW."preleveurUserId" IS NULL)
      AND coverage."periodStart" < cv."periodEnd"
      AND coverage."periodEnd" > cv."periodStart"
    WHERE cv."chunkId" = NEW.id
      AND cv."metricTypeCode" IN ('volume', 'volume prélevé', 'volume rejeté')
  ) THEN
    RAISE EXCEPTION 'A campaign protects this reconciled volume interval' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Chunk_campaign_scope_guard"
BEFORE UPDATE OF "pointPrelevementId", "preleveurUserId", "calculationStrategy", "instructionStatus"
ON "Chunk" FOR EACH ROW
WHEN (OLD."pointPrelevementId" IS DISTINCT FROM NEW."pointPrelevementId"
  OR OLD."preleveurUserId" IS DISTINCT FROM NEW."preleveurUserId"
  OR OLD."calculationStrategy" IS DISTINCT FROM NEW."calculationStrategy"
  OR (OLD."instructionStatus" = 'REJECTED' AND NEW."instructionStatus" <> 'REJECTED'))
EXECUTE FUNCTION "protectCampaignChunkScope"();

CREATE FUNCTION "protectCampaignSourceCompletion"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_point_id UUID;
BEGIN
  FOR v_point_id IN
    SELECT DISTINCT c."pointPrelevementId"
    FROM "Chunk" c JOIN "ChunkValue" cv ON cv."chunkId" = c.id
    WHERE c."sourceId" = NEW.id AND c."pointPrelevementId" IS NOT NULL
      AND c."calculationStrategy" = 'GENERIC' AND c."instructionStatus" <> 'REJECTED'
      AND cv."metricTypeCode" IN ('volume', 'volume prélevé', 'volume rejeté')
    ORDER BY c."pointPrelevementId"
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext('volumes-from-index'), hashtext(v_point_id::text));
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM "Chunk" c JOIN "ChunkValue" cv ON cv."chunkId" = c.id
    JOIN "CampaignCoverage" coverage ON coverage.active
      AND coverage."pointPrelevementId" = c."pointPrelevementId"
      AND (coverage."preleveurUserId" = c."preleveurUserId" OR c."preleveurUserId" IS NULL)
      AND coverage."periodStart" < cv."periodEnd" AND coverage."periodEnd" > cv."periodStart"
    WHERE c."sourceId" = NEW.id AND c."calculationStrategy" = 'GENERIC'
      AND c."instructionStatus" <> 'REJECTED'
      AND cv."metricTypeCode" IN ('volume', 'volume prélevé', 'volume rejeté')
  ) THEN
    RAISE EXCEPTION 'A campaign protects this completed source volume interval' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Source_campaign_completion_guard" BEFORE UPDATE OF "status" ON "Source"
FOR EACH ROW WHEN (OLD."status" <> 'COMPLETED' AND NEW."status" = 'COMPLETED')
EXECUTE FUNCTION "protectCampaignSourceCompletion"();
