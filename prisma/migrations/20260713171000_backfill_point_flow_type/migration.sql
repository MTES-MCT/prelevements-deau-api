-- Le rejet l'emporte dès qu'une mesure historique ou le référentiel du point
-- l'indique explicitement. Tous les autres points deviennent des prélèvements.
UPDATE "PointPrelevement" p
SET "flowType" = CASE
  WHEN
    p."flowType" = 'REJET'::"PointFlowType"
    OR LOWER(COALESCE(p."sourceId", '')) LIKE '%rejet%'
    OR LOWER(p.name) LIKE '%rejet%'
    OR EXISTS (
      SELECT 1
      FROM "Chunk" c
      JOIN "ChunkValue" cv ON cv."chunkId" = c.id
      WHERE c."pointPrelevementId" = p.id
        AND cv."metricTypeCode" = 'volume rejeté'
    )
  THEN 'REJET'::"PointFlowType"
  ELSE 'PRELEVEMENT'::"PointFlowType"
END;

UPDATE "PointPrelevement"
SET "withdrawalType" = NULL
WHERE "flowType" = 'REJET'::"PointFlowType";

-- Un chunk rapproché suit toujours la fonction du PP. Pour un chunk non
-- rapproché, l'ancien type de mesure permet uniquement de conserver l'indice
-- explicite fourni par la source.
UPDATE "Chunk" c
SET "flowType" = p."flowType"
FROM "PointPrelevement" p
WHERE c."pointPrelevementId" = p.id;

UPDATE "Chunk" c
SET "flowType" = CASE
  WHEN EXISTS (
    SELECT 1 FROM "ChunkValue" cv
    WHERE cv."chunkId" = c.id
      AND cv."metricTypeCode" = 'volume rejeté'
  ) THEN 'REJET'::"PointFlowType"
  WHEN EXISTS (
    SELECT 1 FROM "ChunkValue" cv
    WHERE cv."chunkId" = c.id
      AND cv."metricTypeCode" IN ('volume prélevé', 'débit prélevé')
  ) THEN 'PRELEVEMENT'::"PointFlowType"
  ELSE NULL
END
WHERE c."pointPrelevementId" IS NULL;

ALTER TABLE "PointPrelevement"
ALTER COLUMN "flowType" SET NOT NULL;

ALTER TABLE "PointPrelevement"
ADD CONSTRAINT "PointPrelevement_rejet_without_withdrawal_type_check"
CHECK ("flowType" <> 'REJET'::"PointFlowType" OR "withdrawalType" IS NULL);
