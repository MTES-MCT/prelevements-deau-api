-- CreateEnum
CREATE TYPE "MeterIngestionMode" AS ENUM ('LIVE', 'OFFLINE');

-- AlterEnum
ALTER TYPE "ChunkCalculationStrategy" ADD VALUE 'METER';

-- CreateTable
CREATE TABLE "ExternalReference" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "pointPrelevementId" UUID,
    "declarantUserId" UUID,
    "compteurId" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeterStream" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "compteurId" UUID NOT NULL,
    "serviceAccountId" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "supersedeSameMeter" BOOLEAN NOT NULL DEFAULT false,
    "activatedAt" TIMESTAMPTZ(3),
    "allocationSnapshot" JSONB NOT NULL DEFAULT '[]',
    "allocationSnapshotValidated" BOOLEAN NOT NULL DEFAULT false,
    "lastSuccessAt" TIMESTAMPTZ(3),
    "lastReadingAt" TIMESTAMPTZ(3),
    "checkpoint" TIMESTAMPTZ(3),
    "lastIssue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeterStream_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeterAllocation" (
    "id" UUID NOT NULL,
    "sourceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "compteurId" UUID NOT NULL,
    "exploitationId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeterAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeterAllocationVersion" (
    "id" UUID NOT NULL,
    "allocationId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "percentage" DECIMAL(7,4),
    "startDate" TIMESTAMPTZ(3),
    "endDate" TIMESTAMPTZ(3),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "additive" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeterAllocationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeterIngestion" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "serviceAccountId" UUID,
    "actorUserId" UUID,
    "mode" "MeterIngestionMode" NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "result" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeterIngestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeterReading" (
    "id" UUID NOT NULL,
    "compteurId" UUID NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "currentRevisionId" UUID,
    "lastFetchedAt" TIMESTAMPTZ(3) NOT NULL,
    "currentMode" "MeterIngestionMode" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeterReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeterReadingRevision" (
    "id" UUID NOT NULL,
    "readingId" UUID NOT NULL,
    "streamId" UUID NOT NULL,
    "ingestionId" UUID NOT NULL,
    "mode" "MeterIngestionMode" NOT NULL,
    "index" DECIMAL(20,4),
    "quality" TEXT,
    "origin" TEXT,
    "admissible" BOOLEAN NOT NULL,
    "reason" TEXT,
    "payloadHash" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeterReadingRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeterPublication" (
    "id" UUID NOT NULL,
    "publicationKey" TEXT NOT NULL,
    "streamId" UUID NOT NULL,
    "compteurId" UUID NOT NULL,
    "startRevisionId" UUID NOT NULL,
    "endRevisionId" UUID NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "periodEnd" TIMESTAMPTZ(3) NOT NULL,
    "physicalVolume" DECIMAL(20,4) NOT NULL,
    "inScopeVolume" DECIMAL(20,4) NOT NULL,
    "outOfScopeVolume" DECIMAL(20,4) NOT NULL,
    "allocationSnapshot" JSONB NOT NULL,
    "sourceId" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "supersededAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeterPublication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeterVolumeContribution" (
    "id" UUID NOT NULL,
    "publicationId" UUID NOT NULL,
    "allocationVersionId" UUID NOT NULL,
    "chunkValueId" UUID NOT NULL,
    "volume" DECIMAL(20,4) NOT NULL,

    CONSTRAINT "MeterVolumeContribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalReference_pointPrelevementId_idx" ON "ExternalReference"("pointPrelevementId");

-- CreateIndex
CREATE INDEX "ExternalReference_declarantUserId_idx" ON "ExternalReference"("declarantUserId");

-- CreateIndex
CREATE INDEX "ExternalReference_compteurId_idx" ON "ExternalReference"("compteurId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalReference_provider_scope_kind_externalId_key" ON "ExternalReference"("provider", "scope", "kind", "externalId");

-- CreateIndex
CREATE INDEX "MeterStream_compteurId_idx" ON "MeterStream"("compteurId");

-- CreateIndex
CREATE INDEX "MeterStream_serviceAccountId_enabled_idx" ON "MeterStream"("serviceAccountId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "MeterStream_provider_scope_externalId_key" ON "MeterStream"("provider", "scope", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "MeterAllocation_sourceId_key" ON "MeterAllocation"("sourceId");

-- CreateIndex
CREATE INDEX "MeterAllocation_compteurId_idx" ON "MeterAllocation"("compteurId");

-- CreateIndex
CREATE INDEX "MeterAllocation_exploitationId_idx" ON "MeterAllocation"("exploitationId");

-- CreateIndex
CREATE INDEX "MeterAllocationVersion_allocationId_startDate_endDate_idx" ON "MeterAllocationVersion"("allocationId", "startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "MeterAllocationVersion_allocationId_version_key" ON "MeterAllocationVersion"("allocationId", "version");

-- CreateIndex
CREATE INDEX "MeterIngestion_createdAt_idx" ON "MeterIngestion"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MeterIngestion_provider_scope_batchId_key" ON "MeterIngestion"("provider", "scope", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "MeterReading_currentRevisionId_key" ON "MeterReading"("currentRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "MeterReading_compteurId_observedAt_key" ON "MeterReading"("compteurId", "observedAt");

-- CreateIndex
CREATE INDEX "MeterReadingRevision_ingestionId_idx" ON "MeterReadingRevision"("ingestionId");

-- CreateIndex
CREATE UNIQUE INDEX "MeterReadingRevision_readingId_streamId_mode_payloadHash_key" ON "MeterReadingRevision"("readingId", "streamId", "mode", "payloadHash");

-- CreateIndex
CREATE UNIQUE INDEX "MeterPublication_publicationKey_key" ON "MeterPublication"("publicationKey");

-- CreateIndex
CREATE UNIQUE INDEX "MeterPublication_sourceId_key" ON "MeterPublication"("sourceId");

-- CreateIndex
CREATE INDEX "MeterPublication_compteurId_active_periodStart_periodEnd_idx" ON "MeterPublication"("compteurId", "active", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "MeterVolumeContribution_chunkValueId_idx" ON "MeterVolumeContribution"("chunkValueId");

-- CreateIndex
CREATE UNIQUE INDEX "MeterVolumeContribution_publicationId_allocationVersionId_key" ON "MeterVolumeContribution"("publicationId", "allocationVersionId");

-- AddForeignKey
ALTER TABLE "ExternalReference" ADD CONSTRAINT "ExternalReference_pointPrelevementId_fkey" FOREIGN KEY ("pointPrelevementId") REFERENCES "PointPrelevement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalReference" ADD CONSTRAINT "ExternalReference_declarantUserId_fkey" FOREIGN KEY ("declarantUserId") REFERENCES "Declarant"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalReference" ADD CONSTRAINT "ExternalReference_compteurId_fkey" FOREIGN KEY ("compteurId") REFERENCES "Compteur"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterStream" ADD CONSTRAINT "MeterStream_compteurId_fkey" FOREIGN KEY ("compteurId") REFERENCES "Compteur"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterStream" ADD CONSTRAINT "MeterStream_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "ServiceAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterAllocation" ADD CONSTRAINT "MeterAllocation_compteurId_fkey" FOREIGN KEY ("compteurId") REFERENCES "Compteur"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterAllocation" ADD CONSTRAINT "MeterAllocation_exploitationId_fkey" FOREIGN KEY ("exploitationId") REFERENCES "DeclarantPointPrelevement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterAllocationVersion" ADD CONSTRAINT "MeterAllocationVersion_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "MeterAllocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterIngestion" ADD CONSTRAINT "MeterIngestion_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "ServiceAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterIngestion" ADD CONSTRAINT "MeterIngestion_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_compteurId_fkey" FOREIGN KEY ("compteurId") REFERENCES "Compteur"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_currentRevisionId_fkey" FOREIGN KEY ("currentRevisionId") REFERENCES "MeterReadingRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterReadingRevision" ADD CONSTRAINT "MeterReadingRevision_readingId_fkey" FOREIGN KEY ("readingId") REFERENCES "MeterReading"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterReadingRevision" ADD CONSTRAINT "MeterReadingRevision_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "MeterStream"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterReadingRevision" ADD CONSTRAINT "MeterReadingRevision_ingestionId_fkey" FOREIGN KEY ("ingestionId") REFERENCES "MeterIngestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterPublication" ADD CONSTRAINT "MeterPublication_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "MeterStream"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterPublication" ADD CONSTRAINT "MeterPublication_compteurId_fkey" FOREIGN KEY ("compteurId") REFERENCES "Compteur"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterPublication" ADD CONSTRAINT "MeterPublication_startRevisionId_fkey" FOREIGN KEY ("startRevisionId") REFERENCES "MeterReadingRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterPublication" ADD CONSTRAINT "MeterPublication_endRevisionId_fkey" FOREIGN KEY ("endRevisionId") REFERENCES "MeterReadingRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterPublication" ADD CONSTRAINT "MeterPublication_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterVolumeContribution" ADD CONSTRAINT "MeterVolumeContribution_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "MeterPublication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterVolumeContribution" ADD CONSTRAINT "MeterVolumeContribution_allocationVersionId_fkey" FOREIGN KEY ("allocationVersionId") REFERENCES "MeterAllocationVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterVolumeContribution" ADD CONSTRAINT "MeterVolumeContribution_chunkValueId_fkey" FOREIGN KEY ("chunkValueId") REFERENCES "ChunkValue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Resolved references must point to one real identity, never a polymorphic UUID.
ALTER TABLE "MeterStream" ADD COLUMN "blockedWindows" JSONB NOT NULL DEFAULT '[]';
CREATE UNIQUE INDEX "MeterStream_one_enabled_per_meter" ON "MeterStream" ("compteurId") WHERE enabled;
ALTER TABLE "ExternalReference" ADD CONSTRAINT "ExternalReference_one_target_check"
CHECK (num_nonnulls("pointPrelevementId", "declarantUserId", "compteurId") = 1);
ALTER TABLE "ExternalReference" ADD CONSTRAINT "ExternalReference_nonempty_check"
CHECK (btrim(provider) <> '' AND btrim(scope) <> '' AND btrim(kind) <> '' AND btrim("externalId") <> '');
ALTER TABLE "MeterStream" ADD CONSTRAINT "MeterStream_activation_check"
CHECK (NOT enabled OR ("activatedAt" IS NOT NULL AND "allocationSnapshotValidated"));
ALTER TABLE "MeterAllocationVersion" ADD CONSTRAINT "MeterAllocationVersion_percentage_check"
CHECK (percentage IS NULL OR (percentage >= 0 AND percentage <= 100));
ALTER TABLE "MeterAllocationVersion" ADD CONSTRAINT "MeterAllocationVersion_period_check"
CHECK (("endDate" IS NULL OR "startDate" IS NULL OR "endDate" > "startDate")
  AND (NOT enabled OR ("startDate" IS NOT NULL AND percentage IS NOT NULL)) AND version > 0);
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "MeterAllocationVersion" ADD CONSTRAINT "MeterAllocationVersion_active_period_excl"
EXCLUDE USING gist ("allocationId" WITH =, tstzrange("startDate", "endDate", '[)') WITH &&) WHERE (enabled);
ALTER TABLE "MeterIngestion" ADD CONSTRAINT "MeterIngestion_window_check" CHECK ("windowEnd" > "windowStart");
ALTER TABLE "MeterReadingRevision" ADD CONSTRAINT "MeterReadingRevision_index_check"
CHECK ("index" IS NULL OR "index" >= 0);
ALTER TABLE "MeterPublication" ADD CONSTRAINT "MeterPublication_conservation_check"
CHECK ("periodEnd" > "periodStart" AND "physicalVolume" >= 0 AND "inScopeVolume" >= 0 AND "outOfScopeVolume" >= 0
  AND "physicalVolume" = "inScopeVolume" + "outOfScopeVolume");
ALTER TABLE "MeterPublication" ADD CONSTRAINT "MeterPublication_active_period_excl"
EXCLUDE USING gist ("compteurId" WITH =, tstzrange("periodStart", "periodEnd", '[)') WITH &&) WHERE (active);
ALTER TABLE "MeterVolumeContribution" ADD CONSTRAINT "MeterVolumeContribution_volume_check" CHECK (volume >= 0);

CREATE FUNCTION "protectMeterRevision"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Meter reading revisions are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "MeterReadingRevision_immutable" BEFORE UPDATE OR DELETE ON "MeterReadingRevision"
FOR EACH ROW EXECUTE FUNCTION "protectMeterRevision"();

CREATE FUNCTION "protectMeterAllocationVersion"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.enabled OR EXISTS (SELECT 1 FROM "MeterVolumeContribution" WHERE "allocationVersionId" = OLD.id))
    AND ((to_jsonb(NEW) - 'enabled' - 'endDate') IS DISTINCT FROM (to_jsonb(OLD) - 'enabled' - 'endDate')
      OR (NEW."endDate" IS DISTINCT FROM OLD."endDate" AND
        (NEW."endDate" IS NULL OR (OLD."endDate" IS NOT NULL AND NEW."endDate" > OLD."endDate")))) THEN
    RAISE EXCEPTION 'An activated meter allocation version is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."endDate" IS DISTINCT FROM NEW."endDate" THEN
    NEW.metadata := jsonb_set(OLD.metadata, '{_periodClosures}',
      (CASE WHEN jsonb_typeof(OLD.metadata -> '_periodClosures') = 'array' THEN OLD.metadata -> '_periodClosures' ELSE '[]'::jsonb END)
      || jsonb_build_array(jsonb_build_object('previousEndDate', OLD."endDate", 'endDate', NEW."endDate", 'recordedAt', clock_timestamp())));
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "MeterAllocationVersion_immutable" BEFORE UPDATE ON "MeterAllocationVersion"
FOR EACH ROW EXECUTE FUNCTION "protectMeterAllocationVersion"();

CREATE FUNCTION "protectMeterAllocationIdentity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."compteurId", NEW."exploitationId", NEW.provider, NEW.scope, NEW."sourceId", NEW.metadata)
    IS DISTINCT FROM (OLD."compteurId", OLD."exploitationId", OLD.provider, OLD.scope, OLD."sourceId", OLD.metadata)
    AND EXISTS (SELECT 1 FROM "MeterAllocationVersion" v WHERE v."allocationId" = OLD.id
      AND (v.enabled OR EXISTS (SELECT 1 FROM "MeterVolumeContribution" c WHERE c."allocationVersionId" = v.id))) THEN
    RAISE EXCEPTION 'An activated meter allocation cannot change identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "MeterAllocation_identity_guard" BEFORE UPDATE ON "MeterAllocation"
FOR EACH ROW EXECUTE FUNCTION "protectMeterAllocationIdentity"();

CREATE FUNCTION "protectMeterStreamIdentity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."compteurId", NEW.provider, NEW.scope, NEW."externalId")
    IS DISTINCT FROM (OLD."compteurId", OLD.provider, OLD.scope, OLD."externalId")
    AND EXISTS (SELECT 1 FROM "MeterReadingRevision" WHERE "streamId" = OLD.id) THEN
    RAISE EXCEPTION 'A meter stream with readings cannot change identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "MeterStream_identity_guard" BEFORE UPDATE ON "MeterStream"
FOR EACH ROW EXECUTE FUNCTION "protectMeterStreamIdentity"();

CREATE FUNCTION "checkMeterCurrentRevision"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."currentRevisionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "MeterReadingRevision" WHERE id = NEW."currentRevisionId" AND "readingId" = NEW.id
  ) THEN
    RAISE EXCEPTION 'The current meter revision belongs to another reading' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "MeterReading_current_revision_check" BEFORE INSERT OR UPDATE OF "currentRevisionId" ON "MeterReading"
FOR EACH ROW EXECUTE FUNCTION "checkMeterCurrentRevision"();

CREATE FUNCTION "protectMeterExploitationIdentity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."pointPrelevementId" IS DISTINCT FROM OLD."pointPrelevementId" OR NEW."declarantUserId" IS DISTINCT FROM OLD."declarantUserId")
    AND EXISTS (SELECT 1 FROM "MeterAllocation" WHERE "exploitationId" = OLD.id) THEN
    RAISE EXCEPTION 'An exploitation referenced by a meter allocation cannot change identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "DeclarantPointPrelevement_meter_identity_guard" BEFORE UPDATE OF "pointPrelevementId", "declarantUserId"
ON "DeclarantPointPrelevement" FOR EACH ROW EXECUTE FUNCTION "protectMeterExploitationIdentity"();

-- Legacy writers release their application conflict-check transaction before
-- inserting rows. These guards close that race under the same point lock.
CREATE FUNCTION "assertMeterVolumeScope"(v_point UUID, v_actor UUID, v_meter UUID, v_start TIMESTAMP, v_end TIMESTAMP)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF v_point IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('volumes-from-index'), hashtext(v_point::text));
  IF EXISTS (
    SELECT 1 FROM "MeterPublication" p
    JOIN "MeterVolumeContribution" c ON c."publicationId" = p.id
    JOIN "MeterAllocationVersion" av ON av.id = c."allocationVersionId"
    JOIN "MeterAllocation" a ON a.id = av."allocationId"
    JOIN "DeclarantPointPrelevement" e ON e.id = a."exploitationId"
    WHERE p.active AND e."pointPrelevementId" = v_point
      AND (v_actor IS NULL OR e."declarantUserId" = v_actor)
      AND p."periodStart" < (v_end AT TIME ZONE 'UTC') AND p."periodEnd" > (v_start AT TIME ZONE 'UTC')
      AND (v_meter IS NULL OR v_meter = p."compteurId" OR NOT av.additive OR NOT EXISTS (
        SELECT 1 FROM "MeterAllocationVersion" other_av
        JOIN "MeterAllocation" other_a ON other_a.id = other_av."allocationId"
        WHERE other_a."compteurId" = v_meter AND other_a."exploitationId" = e.id
          AND other_av.enabled AND other_av.additive
          AND other_av."startDate" <= (v_start AT TIME ZONE 'UTC')
          AND (other_av."endDate" IS NULL OR other_av."endDate" >= (v_end AT TIME ZONE 'UTC'))
      ))
  ) THEN
    RAISE EXCEPTION 'An active physical meter publication protects this volume interval' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "protectMeterVolumeValue"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c "Chunk"%ROWTYPE;
BEGIN
  IF NEW."metricTypeCode" NOT IN ('volume', 'volume prélevé', 'volume rejeté') THEN RETURN NEW; END IF;
  SELECT * INTO c FROM "Chunk" WHERE id = NEW."chunkId";
  IF c."calculationStrategy"::text <> 'METER' AND c."instructionStatus" <> 'REJECTED' THEN
    PERFORM "assertMeterVolumeScope"(c."pointPrelevementId", c."preleveurUserId", c."compteurId", NEW."periodStart", NEW."periodEnd");
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChunkValue_meter_publication_guard"
BEFORE INSERT OR UPDATE OF "chunkId", "metricTypeCode", "periodStart", "periodEnd", "valueKind", value
ON "ChunkValue" FOR EACH ROW EXECUTE FUNCTION "protectMeterVolumeValue"();

CREATE FUNCTION "protectMeterChunkScope"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v RECORD;
BEGIN
  IF OLD."calculationStrategy"::text = 'METER' AND
    (NEW."pointPrelevementId", NEW."preleveurUserId", NEW."compteurId", NEW."sourceId", NEW."calculationStrategy", NEW."usageId")
    IS DISTINCT FROM
    (OLD."pointPrelevementId", OLD."preleveurUserId", OLD."compteurId", OLD."sourceId", OLD."calculationStrategy", OLD."usageId") THEN
    RAISE EXCEPTION 'Physical meter publication scope is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."calculationStrategy"::text <> 'METER' AND NEW."instructionStatus" <> 'REJECTED' THEN
    FOR v IN SELECT * FROM "ChunkValue" WHERE "chunkId" = NEW.id
      AND "metricTypeCode" IN ('volume', 'volume prélevé', 'volume rejeté') LOOP
      PERFORM "assertMeterVolumeScope"(NEW."pointPrelevementId", NEW."preleveurUserId", NEW."compteurId", v."periodStart", v."periodEnd");
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Chunk_meter_scope_guard" BEFORE UPDATE OF "pointPrelevementId", "preleveurUserId", "compteurId", "sourceId", "calculationStrategy", "usageId", "instructionStatus"
ON "Chunk" FOR EACH ROW EXECUTE FUNCTION "protectMeterChunkScope"();

CREATE FUNCTION "protectMeterSourceCompletion"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v RECORD;
BEGIN
  FOR v IN SELECT c."pointPrelevementId", c."preleveurUserId", c."compteurId", cv."periodStart", cv."periodEnd"
    FROM "Chunk" c JOIN "ChunkValue" cv ON cv."chunkId" = c.id
    WHERE c."sourceId" = NEW.id AND c."calculationStrategy"::text <> 'METER' AND c."instructionStatus" <> 'REJECTED'
      AND cv."metricTypeCode" IN ('volume', 'volume prélevé', 'volume rejeté') ORDER BY c."pointPrelevementId" LOOP
    PERFORM "assertMeterVolumeScope"(v."pointPrelevementId", v."preleveurUserId", v."compteurId", v."periodStart", v."periodEnd");
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Source_meter_completion_guard" BEFORE UPDATE OF status ON "Source"
FOR EACH ROW WHEN (OLD.status <> 'COMPLETED' AND NEW.status = 'COMPLETED')
EXECUTE FUNCTION "protectMeterSourceCompletion"();

-- Preserve existing runtime role privileges without inventing roles or broader rights.
DO $$
DECLARE
  permission RECORD;
  target_table TEXT;
BEGIN
  FOR permission IN SELECT DISTINCT grantee, privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = current_schema() AND table_name = 'Compteur'
      AND grantee <> current_user AND grantee <> 'PUBLIC'
      AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  LOOP
    FOREACH target_table IN ARRAY ARRAY['ExternalReference', 'MeterStream', 'MeterAllocation', 'MeterAllocationVersion',
      'MeterIngestion', 'MeterReading', 'MeterReadingRevision', 'MeterPublication', 'MeterVolumeContribution']
    LOOP
      EXECUTE format('GRANT %s ON TABLE %I.%I TO %I', permission.privilege_type, current_schema(), target_table, permission.grantee);
    END LOOP;
  END LOOP;
END;
$$;
