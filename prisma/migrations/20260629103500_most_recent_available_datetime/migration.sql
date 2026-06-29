-- Preserve existing date-only cursors at midnight, while allowing hourly API
-- connectors to persist an exact resume timestamp.
ALTER TABLE "DeclarantPointPrelevement"
ALTER COLUMN "mostRecentAvailableDate" TYPE TIMESTAMP(3)
USING "mostRecentAvailableDate"::timestamp(3);

WITH latest_connector_values AS (
  SELECT
    dpp.id AS "exploitationId",
    MAX(cv."periodEnd") AS "mostRecentAvailableDate"
  FROM "DeclarantPointPrelevement" dpp
  JOIN "DeclarantPointPrelevementConnector" dppc
    ON dppc."declarantPointPrelevementId" = dpp.id
  JOIN "Chunk" c
    ON c."pointPrelevementId" = dpp."pointPrelevementId"
  JOIN "Source" s
    ON s.id = c."sourceId"
  JOIN "ChunkValue" cv
    ON cv."chunkId" = c.id
  WHERE s.type = 'API'
    AND COALESCE(c.metadata->>'connectorId', s.metadata->>'connectorId') = dppc.id::text
  GROUP BY dpp.id
)
UPDATE "DeclarantPointPrelevement" dpp
SET "mostRecentAvailableDate" = latest_connector_values."mostRecentAvailableDate"
FROM latest_connector_values
WHERE dpp.id = latest_connector_values."exploitationId"
  AND (
    dpp."mostRecentAvailableDate" IS NULL
    OR latest_connector_values."mostRecentAvailableDate" > dpp."mostRecentAvailableDate"
  );
