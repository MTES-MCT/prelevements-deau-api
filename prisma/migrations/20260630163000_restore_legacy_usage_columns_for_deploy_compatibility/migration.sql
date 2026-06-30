DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'UsageEau'
  ) THEN
    CREATE TYPE "UsageEau" AS ENUM (
      'INCONNU',
      'PAS_D_USAGE',
      'IRRIGATION',
      'AGRICULTURE_ELEVAGE',
      'AQUACULTURE',
      'INDUSTRIE',
      'AEP',
      'ENERGIE',
      'LOISIRS',
      'EMBOUTEILLAGE',
      'THERMALISME_THALASSO',
      'DEFENSE_INCENDIE',
      'REALIMENTATION_EAU',
      'CANAUX',
      'ETIAGE',
      'ENTRETIEN_VOIRIES',
      'ALIMENTATION_SOUTIEN_CANAL',
      'DOMESTIQUE'
    );
  END IF;
END
$$;

ALTER TABLE "DeclarantPointPrelevement"
ADD COLUMN IF NOT EXISTS "usages" "UsageEau"[] DEFAULT ARRAY[]::"UsageEau"[];

ALTER TABLE "Chunk"
ADD COLUMN IF NOT EXISTS "usage" "UsageEau";

WITH normalized_usages AS (
  SELECT
    water_use.id AS "usageId",
    CASE
      WHEN water_use.code = '3B' THEN 'AQUACULTURE'
      WHEN COALESCE(root_water_use.code, water_use.code) = '0' THEN 'INCONNU'
      WHEN COALESCE(root_water_use.code, water_use.code) = '1' THEN 'PAS_D_USAGE'
      WHEN COALESCE(root_water_use.code, water_use.code) = '2' THEN 'IRRIGATION'
      WHEN COALESCE(root_water_use.code, water_use.code) = '3' THEN 'AGRICULTURE_ELEVAGE'
      WHEN COALESCE(root_water_use.code, water_use.code) = '4' THEN 'INDUSTRIE'
      WHEN COALESCE(root_water_use.code, water_use.code) = '5' THEN 'AEP'
      WHEN COALESCE(root_water_use.code, water_use.code) = '6' THEN 'ENERGIE'
      WHEN COALESCE(root_water_use.code, water_use.code) = '7' THEN 'LOISIRS'
      WHEN COALESCE(root_water_use.code, water_use.code) = '8' THEN 'EMBOUTEILLAGE'
      WHEN COALESCE(root_water_use.code, water_use.code) = '9' THEN 'THERMALISME_THALASSO'
      WHEN COALESCE(root_water_use.code, water_use.code) = '10' THEN 'DEFENSE_INCENDIE'
      WHEN COALESCE(root_water_use.code, water_use.code) = '12' THEN 'REALIMENTATION_EAU'
      WHEN COALESCE(root_water_use.code, water_use.code) = '13' THEN 'CANAUX'
      WHEN COALESCE(root_water_use.code, water_use.code) = '14' THEN 'ETIAGE'
      WHEN COALESCE(root_water_use.code, water_use.code) = '15' THEN 'ENTRETIEN_VOIRIES'
      WHEN COALESCE(root_water_use.code, water_use.code) = '16' THEN 'ALIMENTATION_SOUTIEN_CANAL'
      WHEN COALESCE(root_water_use.code, water_use.code) = '17' THEN 'DOMESTIQUE'
      ELSE 'INCONNU'
    END AS "legacyUsage"
  FROM "SandreWaterUse" water_use
  LEFT JOIN "SandreWaterUse" root_water_use ON root_water_use.id = water_use."parentId"
)
UPDATE "DeclarantPointPrelevement" exploitation
SET "usages" = ARRAY[normalized_usages."legacyUsage"::"UsageEau"]::"UsageEau"[]
FROM normalized_usages
WHERE exploitation."usageId" = normalized_usages."usageId"
  AND (
    exploitation."usages" IS NULL
    OR cardinality(exploitation."usages") = 0
  );

WITH normalized_usages AS (
  SELECT
    water_use.id AS "usageId",
    CASE
      WHEN water_use.code = '3B' THEN 'AQUACULTURE'
      WHEN COALESCE(root_water_use.code, water_use.code) = '0' THEN 'INCONNU'
      WHEN COALESCE(root_water_use.code, water_use.code) = '1' THEN 'PAS_D_USAGE'
      WHEN COALESCE(root_water_use.code, water_use.code) = '2' THEN 'IRRIGATION'
      WHEN COALESCE(root_water_use.code, water_use.code) = '3' THEN 'AGRICULTURE_ELEVAGE'
      WHEN COALESCE(root_water_use.code, water_use.code) = '4' THEN 'INDUSTRIE'
      WHEN COALESCE(root_water_use.code, water_use.code) = '5' THEN 'AEP'
      WHEN COALESCE(root_water_use.code, water_use.code) = '6' THEN 'ENERGIE'
      WHEN COALESCE(root_water_use.code, water_use.code) = '7' THEN 'LOISIRS'
      WHEN COALESCE(root_water_use.code, water_use.code) = '8' THEN 'EMBOUTEILLAGE'
      WHEN COALESCE(root_water_use.code, water_use.code) = '9' THEN 'THERMALISME_THALASSO'
      WHEN COALESCE(root_water_use.code, water_use.code) = '10' THEN 'DEFENSE_INCENDIE'
      WHEN COALESCE(root_water_use.code, water_use.code) = '12' THEN 'REALIMENTATION_EAU'
      WHEN COALESCE(root_water_use.code, water_use.code) = '13' THEN 'CANAUX'
      WHEN COALESCE(root_water_use.code, water_use.code) = '14' THEN 'ETIAGE'
      WHEN COALESCE(root_water_use.code, water_use.code) = '15' THEN 'ENTRETIEN_VOIRIES'
      WHEN COALESCE(root_water_use.code, water_use.code) = '16' THEN 'ALIMENTATION_SOUTIEN_CANAL'
      WHEN COALESCE(root_water_use.code, water_use.code) = '17' THEN 'DOMESTIQUE'
      ELSE 'INCONNU'
    END AS "legacyUsage"
  FROM "SandreWaterUse" water_use
  LEFT JOIN "SandreWaterUse" root_water_use ON root_water_use.id = water_use."parentId"
)
UPDATE "Chunk" chunk
SET "usage" = normalized_usages."legacyUsage"::"UsageEau"
FROM normalized_usages
WHERE chunk."usageId" = normalized_usages."usageId"
  AND chunk."usage" IS NULL;

CREATE INDEX IF NOT EXISTS "DeclarantPointPrelevement_usages_idx"
ON "DeclarantPointPrelevement" USING GIN ("usages");

CREATE INDEX IF NOT EXISTS "Chunk_usage_idx"
ON "Chunk"("usage");
