-- Backfill remaining chunks when the usage can still be inferred safely.
-- 1. API chunks: use the exploitation attached to the connector that produced the chunk.
WITH connector_chunk_usage AS (
  SELECT
    chunk.id AS "chunkId",
    exploitation."usageId"
  FROM "Chunk" chunk
  JOIN "Source" source
    ON source.id = chunk."sourceId"
  JOIN "DeclarantPointPrelevementConnector" connector
    ON connector.id::text = COALESCE(
      chunk.metadata->>'connectorId',
      source.metadata->>'connectorId'
    )
  JOIN "DeclarantPointPrelevement" exploitation
    ON exploitation.id = connector."declarantPointPrelevementId"
  WHERE chunk."usageId" IS NULL
    AND exploitation."usageId" IS NOT NULL
)
UPDATE "Chunk" chunk
SET "usageId" = connector_chunk_usage."usageId"
FROM connector_chunk_usage
WHERE chunk.id = connector_chunk_usage."chunkId";

-- 2. Declaration chunks: use the point usage only when it is not ambiguous.
WITH point_unique_usage AS (
  SELECT
    chunk.id AS "chunkId",
    MIN(exploitation."usageId"::text)::uuid AS "usageId"
  FROM "Chunk" chunk
  JOIN "DeclarantPointPrelevement" exploitation
    ON exploitation."pointPrelevementId" = chunk."pointPrelevementId"
  WHERE chunk."usageId" IS NULL
    AND chunk."pointPrelevementId" IS NOT NULL
    AND exploitation."usageId" IS NOT NULL
  GROUP BY chunk.id
  HAVING COUNT(DISTINCT exploitation."usageId") = 1
)
UPDATE "Chunk" chunk
SET "usageId" = point_unique_usage."usageId"
FROM point_unique_usage
WHERE chunk.id = point_unique_usage."chunkId";
