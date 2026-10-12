import {Prisma} from '@prisma/client'
import {prisma} from '../../db/prisma.js'

// A measurement from another module (or a manual declaration) must not move
// this module's cursor. Explicit null means that its own history is empty.
export async function getWillieConnectorCursors(connectors, {client = prisma} = {}) {
  const ids = [...new Set(connectors.filter(connector => connector.connectorType === 'willie').map(connector => connector.id))]
  if (!ids.length) return new Map()
  const rows = await client.$queryRaw`
    SELECT co.id, max(v."periodEnd") AS "mostRecentAvailableDate"
    FROM "DeclarantPointPrelevementConnector" co
    JOIN "DeclarantPointPrelevement" e ON e.id = co."declarantPointPrelevementId"
    JOIN "Source" s ON s.type = 'API' AND s.status = 'COMPLETED'
      AND s.metadata->>'connector' = 'willie'
      AND s.metadata->>'connectorId' = co.id::text
      AND s.metadata->>'sourcePointId' = co."connectorParameters"->>'sourcePointId'
    JOIN "Chunk" c ON c."sourceId" = s.id
      AND c."pointPrelevementId" = e."pointPrelevementId"
      AND c."preleveurUserId" = e."declarantUserId"
      AND (c."exploitationId" = e.id OR c."exploitationId" IS NULL)
      AND c."calculationStrategy" = 'GENERIC' AND c."instructionStatus" <> 'REJECTED'
    JOIN "ChunkValue" v ON v."chunkId" = c.id AND v."metricTypeCode" = 'volume'
    WHERE co.id IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      AND co."connectorType" = 'willie'
    GROUP BY co.id
  `
  const cursors = new Map(ids.map(id => [id, null]))
  for (const row of rows) cursors.set(row.id, row.mostRecentAvailableDate)
  return cursors
}
