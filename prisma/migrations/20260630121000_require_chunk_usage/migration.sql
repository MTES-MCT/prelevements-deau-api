WITH fallback_usages AS (
  SELECT
    (SELECT id FROM "SandreWaterUse" WHERE code = '0') AS unknown_usage_id,
    (SELECT id FROM "SandreWaterUse" WHERE code = '4') AS industrial_usage_id
)
UPDATE "Chunk" chunk
SET "usageId" = CASE
  WHEN declaration.type = 'gidaf' THEN fallback_usages.industrial_usage_id
  ELSE fallback_usages.unknown_usage_id
END
FROM "Source" source
LEFT JOIN "Declaration" declaration ON declaration.id = source."declarationId"
CROSS JOIN fallback_usages
WHERE chunk."sourceId" = source.id
  AND chunk."usageId" IS NULL;

ALTER TABLE "Chunk" ALTER COLUMN "usageId" SET NOT NULL;

ALTER TABLE "Chunk" DROP CONSTRAINT IF EXISTS "Chunk_usageId_fkey";

ALTER TABLE "Chunk"
ADD CONSTRAINT "Chunk_usageId_fkey"
FOREIGN KEY ("usageId") REFERENCES "SandreWaterUse"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
