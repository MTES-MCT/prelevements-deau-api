import {Prisma} from '@prisma/client'

// SQL fragments for queries whose Chunk and Source aliases are c and s.
const connectorId = Prisma.sql`COALESCE(c.metadata->>'connectorId', c."parsingInfo"->>'connectorId', s.metadata->>'connectorId')`
const streamId = Prisma.sql`btrim(COALESCE(c."parsingInfo"->>'sourcePointId', s.metadata->>'sourcePointId'))`

function consistentOrangeMetadataSql() {
  return Prisma.sql`
    s.type = 'API' AND c."calculationStrategy" = 'GENERIC'
    AND COALESCE(c.metadata->>'connector', c."parsingInfo"->>'connector', s.metadata->>'connector') = 'orange_live_objects'
    AND NULLIF(btrim(${connectorId}), '') IS NOT NULL AND NULLIF(${streamId}, '') IS NOT NULL
    AND ${connectorId} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES (c.metadata), (c."parsingInfo"), (s.metadata)) AS identity_metadata(value)
      WHERE (value->>'connector' IS NOT NULL AND value->>'connector' <> 'orange_live_objects')
        OR (value->>'connectorId' IS NOT NULL AND value->>'connectorId' <> ${connectorId})
        OR (value->>'sourcePointId' IS NOT NULL AND btrim(value->>'sourcePointId') <> ${streamId})
        OR (value->'sourceMetadata'->>'provider' IS NOT NULL AND value->'sourceMetadata'->>'provider' <> 'orange_live_objects')
        OR (value->'sourceMetadata'->>'stream_id' IS NOT NULL AND btrim(value->'sourceMetadata'->>'stream_id') <> ${streamId})
    )`
}

export function orangeConnectorIdSql() {
  // Cursors and additive conflict handling also require the current authorized
  // configuration. Legacy chunks can lack exploitationId if owner/point match.
  return Prisma.sql`(
    SELECT orange_connector.id::text
    FROM "DeclarantPointPrelevementConnector" orange_connector
    JOIN "DeclarantPointPrelevement" orange_exploitation
      ON orange_exploitation.id = orange_connector."declarantPointPrelevementId"
    WHERE orange_connector."connectorType" = 'orange_live_objects'
      AND ${consistentOrangeMetadataSql()}
      AND orange_exploitation."pointPrelevementId" = c."pointPrelevementId"
      AND orange_exploitation."declarantUserId" = c."preleveurUserId"
      AND (c."exploitationId" = orange_exploitation.id OR c."exploitationId" IS NULL)
      AND orange_connector.id::text = ${connectorId}
      AND btrim(orange_connector."connectorParameters"->>'sourcePointId') = ${streamId}
  )`
}

export function orangeIndexPartitionSql() {
  // History must keep the identity proved when it was ingested, even if the
  // connector is subsequently removed or reconfigured to another stream.
  // Contradictory/unknown Orange history is isolated within its own chunk.
  return Prisma.sql`CASE WHEN ${consistentOrangeMetadataSql()}
    THEN 'orange:' || ${connectorId} || ':' || ${streamId}
    WHEN EXISTS (SELECT 1 FROM (VALUES (c.metadata), (c."parsingInfo"), (s.metadata)) AS provider_metadata(value)
      WHERE value->>'connector' = 'orange_live_objects' OR value->'sourceMetadata'->>'provider' = 'orange_live_objects')
    THEN 'orange:unidentified:' || c.id::text ELSE NULL END`
}
