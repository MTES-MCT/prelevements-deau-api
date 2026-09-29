-- Release B: run only after every API/worker instance uses release A without campaigns.
-- A verified database backup and a maintenance window are required. No ordinary
-- source, chunk, reading, replacement audit, declarant or point is deleted here.
-- This deliberately narrow migration refuses published or mixed campaign data.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path = public, pg_temp;

-- Lock before checking so the accepted preflight cannot change under the DDL.
LOCK TABLE "Campaign", "CampaignPeriod", "CampaignTarget", "CampaignTargetMeter",
  "CampaignManager", "CampaignResponse", "CampaignSubmission", "CampaignNeedLine",
  "CampaignCoverage", "CampaignNotification", "CampaignExport",
  "CompteurPointPrelevement", "Source", "Chunk", "ChunkValue",
  "ChunkValueReplacement", "InstructorZonePermission", "MeterPublication"
  IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typname = 'ChunkCalculationStrategy')
      IS DISTINCT FROM ARRAY['GENERIC', 'CAMPAIGN', 'METER']::text[] THEN
    RAISE EXCEPTION 'RELEASE_B_UNEXPECTED_STRATEGY_ENUM: release A must be applied first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid = '"Chunk"'::regclass AND tgname = 'Chunk_meter_scope_guard' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'RELEASE_B_MISSING_METER_GUARD: release A protection must be enabled';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Source" s
    WHERE (s.metadata ? 'campaignId'
      OR EXISTS (SELECT 1 FROM "CampaignCoverage" cc WHERE cc."sourceId" = s.id)
      OR EXISTS (SELECT 1 FROM "Chunk" c WHERE c."sourceId" = s.id
        AND (c."calculationStrategy"::text = 'CAMPAIGN'
          OR c.metadata ? 'campaignId' OR c.metadata->>'calculationStrategy' = 'CAMPAIGN')))
      AND (s."declarationId" IS NOT NULL OR s."apiImportId" IS NOT NULL
        OR EXISTS (SELECT 1 FROM "MeterPublication" mp WHERE mp."sourceId" = s.id)
        OR EXISTS (SELECT 1 FROM "Chunk" c WHERE c."sourceId" = s.id
          AND c."calculationStrategy"::text <> 'CAMPAIGN'))
  ) THEN
    RAISE EXCEPTION 'RELEASE_B_MIXED_SOURCE: ordinary data requires an explicit repair before campaign removal';
  END IF;

  -- Replacement rows are immutable historical evidence, not permission to erase
  -- superseded ordinary values. Require a separately reviewed repair first.
  IF EXISTS (SELECT 1 FROM "ChunkValueReplacement"
      WHERE "conflictPolicy" LIKE 'CAMPAIGN\_%' ESCAPE '\' OR metadata ? 'campaignId') THEN
    RAISE EXCEPTION 'RELEASE_B_CAMPAIGN_REPLACEMENTS: restore/reconcile replaced ordinary data explicitly';
  END IF;
  IF EXISTS (SELECT 1 FROM "CampaignSubmission") THEN
    RAISE EXCEPTION 'RELEASE_B_CAMPAIGN_SUBMISSIONS: published snapshots require an explicit archival plan';
  END IF;
  IF EXISTS (SELECT 1 FROM "CampaignCoverage") THEN
    RAISE EXCEPTION 'RELEASE_B_CAMPAIGN_COVERAGE: coverage cannot be discarded automatically';
  END IF;
  IF EXISTS (SELECT 1 FROM "Chunk" WHERE "calculationStrategy"::text = 'CAMPAIGN') THEN
    RAISE EXCEPTION 'RELEASE_B_CAMPAIGN_CHUNKS: campaign values cannot be discarded automatically';
  END IF;
  IF EXISTS (SELECT 1 FROM "Source" WHERE metadata ? 'campaignId')
      OR EXISTS (SELECT 1 FROM "Chunk" WHERE metadata ? 'campaignId'
        OR metadata->>'calculationStrategy' = 'CAMPAIGN') THEN
    RAISE EXCEPTION 'RELEASE_B_CAMPAIGN_SOURCE_METADATA: review remaining source/chunk history explicitly';
  END IF;
  IF EXISTS (SELECT 1 FROM "ChunkValue" WHERE "readingDate" IS NOT NULL) THEN
    RAISE EXCEPTION 'RELEASE_B_NONEMPTY_READING_DATE: preserve remaining dates explicitly';
  END IF;
  IF EXISTS (SELECT 1 FROM "CompteurPointPrelevement") THEN
    RAISE EXCEPTION 'RELEASE_B_METER_ASSOCIATIONS: migrate old meter links to dated allocations explicitly';
  END IF;
  IF EXISTS (SELECT 1 FROM "InstructorZonePermission"
      WHERE permission LIKE 'campaign.%'
        AND permission NOT IN ('campaign.read', 'campaign.manage', 'campaign.export')) THEN
    RAISE EXCEPTION 'RELEASE_B_UNKNOWN_CAMPAIGN_PERMISSION: review this permission before removal';
  END IF;
END;
$$;

-- Remove only the three retired live grants. Historical audit JSON is retained.
DELETE FROM "InstructorZonePermission"
  WHERE permission IN ('campaign.read', 'campaign.manage', 'campaign.export');

DROP TRIGGER "CampaignSubmission_immutable" ON "CampaignSubmission";
DROP TRIGGER "ChunkValue_campaign_coverage_guard" ON "ChunkValue";
DROP TRIGGER "Chunk_campaign_scope_guard" ON "Chunk";
DROP TRIGGER "Source_campaign_completion_guard" ON "Source";
DROP FUNCTION "protectCampaignSubmission"();
DROP FUNCTION "protectCampaignVolumeValue"();
DROP FUNCTION "protectCampaignChunkScope"();
DROP FUNCTION "protectCampaignSourceCompletion"();

-- One explicit set handles the response/submission FK cycle; no CASCADE can
-- silently remove an external dependency. Any unexpected dependency aborts all.
DROP TABLE "Campaign", "CampaignPeriod", "CampaignTarget", "CampaignTargetMeter",
  "CampaignManager", "CampaignResponse", "CampaignSubmission", "CampaignNeedLine",
  "CampaignCoverage", "CampaignNotification", "CampaignExport",
  "CompteurPointPrelevement";

DROP TYPE "CampaignStatus", "CampaignResponseKind", "CampaignResponseStatus",
  "CampaignManagerRole", "CampaignNotificationKind", "CampaignNotificationStatus";
ALTER TABLE "ChunkValue" DROP COLUMN "readingDate";

-- PostgreSQL cannot remove one enum label. Preserve the enum's effective USAGE
-- grants, owner and comment while replacing its type, including custom grants.
CREATE TEMPORARY TABLE "_ReleaseBCalculationStrategyAcl" ON COMMIT DROP AS
  SELECT pg_get_userbyid(t.typowner) AS owner_name,
    obj_description(t.oid, 'pg_type') AS type_comment,
    CASE WHEN acl.grantee = 0 THEN NULL ELSE pg_get_userbyid(acl.grantee) END AS grantee_name,
    acl.is_grantable
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  CROSS JOIN LATERAL aclexplode(coalesce(t.typacl, acldefault('T', t.typowner))) acl
  WHERE n.nspname = 'public' AND t.typname = 'ChunkCalculationStrategy';

ALTER TYPE "ChunkCalculationStrategy" RENAME TO "ChunkCalculationStrategy_release_a";
CREATE TYPE "ChunkCalculationStrategy" AS ENUM ('GENERIC', 'METER');
-- Even an UPDATE OF dependency blocks ALTER TYPE. Recreate this exact trigger
-- under the same ACCESS EXCLUSIVE lock/transaction; no unguarded write can run.
CREATE TEMPORARY TABLE "_ReleaseBMeterScopeTrigger" ON COMMIT DROP AS
  SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
  WHERE tgrelid = '"Chunk"'::regclass AND tgname = 'Chunk_meter_scope_guard';
DROP TRIGGER "Chunk_meter_scope_guard" ON "Chunk";
ALTER TABLE "Chunk" ALTER COLUMN "calculationStrategy" DROP DEFAULT;
ALTER TABLE "Chunk" ALTER COLUMN "calculationStrategy"
  TYPE "ChunkCalculationStrategy" USING ("calculationStrategy"::text::"ChunkCalculationStrategy");
ALTER TABLE "Chunk" ALTER COLUMN "calculationStrategy" SET DEFAULT 'GENERIC';
DO $$
DECLARE trigger_definition TEXT;
BEGIN
  SELECT definition INTO STRICT trigger_definition FROM "_ReleaseBMeterScopeTrigger";
  EXECUTE trigger_definition;
END;
$$;

DO $$
DECLARE grant_row RECORD;
DECLARE original_owner TEXT;
DECLARE original_comment TEXT;
BEGIN
  SELECT owner_name, type_comment INTO STRICT original_owner, original_comment
    FROM "_ReleaseBCalculationStrategyAcl" LIMIT 1;
  -- Remove grants introduced by current default privileges before restoring the
  -- exact former grantees; the eventual owner always retains inherent rights.
  FOR grant_row IN
    SELECT CASE WHEN acl.grantee = 0 THEN NULL ELSE pg_get_userbyid(acl.grantee) END AS grantee_name
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    CROSS JOIN LATERAL aclexplode(coalesce(t.typacl, acldefault('T', t.typowner))) acl
    WHERE n.nspname = 'public' AND t.typname = 'ChunkCalculationStrategy'
  LOOP
    EXECUTE format('REVOKE ALL ON TYPE "ChunkCalculationStrategy" FROM %s',
      CASE WHEN grant_row.grantee_name IS NULL THEN 'PUBLIC' ELSE quote_ident(grant_row.grantee_name) END);
  END LOOP;
  FOR grant_row IN SELECT * FROM "_ReleaseBCalculationStrategyAcl" LOOP
    EXECUTE format('GRANT USAGE ON TYPE "ChunkCalculationStrategy" TO %s%s',
      CASE WHEN grant_row.grantee_name IS NULL THEN 'PUBLIC' ELSE quote_ident(grant_row.grantee_name) END,
      CASE WHEN grant_row.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
  EXECUTE format('ALTER TYPE "ChunkCalculationStrategy" OWNER TO %I', original_owner);
  EXECUTE format('COMMENT ON TYPE "ChunkCalculationStrategy" IS %L', original_comment);
END;
$$;
DROP TYPE "ChunkCalculationStrategy_release_a";
COMMIT;
