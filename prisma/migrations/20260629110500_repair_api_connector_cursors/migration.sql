-- The previous migration made connector cursors timestamp-capable but only
-- moved them forward. Some date-only cursors had already been rounded past the
-- actual last imported hourly value, so repair API connector cursors to the
-- exact latest imported period end.
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
  AND dpp."mostRecentAvailableDate" IS DISTINCT FROM latest_connector_values."mostRecentAvailableDate";
