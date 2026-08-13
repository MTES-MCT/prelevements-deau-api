BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE TYPE "PreleveurType" AS ENUM (
  'ICPE',
  'IRRIGANT',
  'GESTIONNAIRE_AEP',
  'AUTRE'
);

ALTER TABLE "Declarant"
ADD COLUMN "preleveurType" "PreleveurType";

-- Refuse une classification ambiguë au lieu de choisir silencieusement un type.
-- L'ensemble de la migration est annulé si un tel cas existe.
DO $$
BEGIN
  IF EXISTS (
    SELECT exploitation."declarantUserId"
    FROM "DeclarantPointPrelevement" AS exploitation
    JOIN "Declarant" AS declarant
      ON declarant."userId" = exploitation."declarantUserId"
    JOIN "SandreWaterUse" AS usage
      ON usage."id" = exploitation."usageId"
    LEFT JOIN "SandreWaterUse" AS parent_usage
      ON parent_usage."id" = usage."parentId"
    WHERE declarant."declarantRole" = 'PRELEVEUR'
      AND COALESCE(parent_usage."code", usage."code") IN ('2', '4', '5')
    GROUP BY exploitation."declarantUserId"
    HAVING COUNT(DISTINCT COALESCE(parent_usage."code", usage."code")) > 1
  ) THEN
    RAISE EXCEPTION 'Backfill preleveurType ambigu : au moins un préleveur relève de plusieurs catégories 2, 4 ou 5.';
  END IF;
END;
$$;

-- Le type est déduit de la racine SANDRE des usages des exploitations.
WITH "DeclarantRootUsages" AS (
  SELECT
    exploitation."declarantUserId",
    COALESCE(parent_usage."code", usage."code") AS "rootUsageCode"
  FROM "DeclarantPointPrelevement" AS exploitation
  LEFT JOIN "SandreWaterUse" AS usage
    ON usage."id" = exploitation."usageId"
  LEFT JOIN "SandreWaterUse" AS parent_usage
    ON parent_usage."id" = usage."parentId"
),
"ClassifiedPreleveurs" AS (
  SELECT
    declarant."userId",
    CASE
      WHEN BOOL_OR(root_usage."rootUsageCode" = '4') THEN 'ICPE'::"PreleveurType"
      WHEN BOOL_OR(root_usage."rootUsageCode" = '2') THEN 'IRRIGANT'::"PreleveurType"
      WHEN BOOL_OR(root_usage."rootUsageCode" = '5') THEN 'GESTIONNAIRE_AEP'::"PreleveurType"
      ELSE 'AUTRE'::"PreleveurType"
    END AS "preleveurType"
  FROM "Declarant" AS declarant
  LEFT JOIN "DeclarantRootUsages" AS root_usage
    ON root_usage."declarantUserId" = declarant."userId"
  WHERE declarant."declarantRole" = 'PRELEVEUR'
  GROUP BY declarant."userId"
)
UPDATE "Declarant" AS declarant
SET "preleveurType" = classified."preleveurType"
FROM "ClassifiedPreleveurs" AS classified
WHERE classified."userId" = declarant."userId";

COMMIT;
