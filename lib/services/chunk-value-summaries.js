import {Prisma} from '@prisma/client'
import {prisma} from '../../db/prisma.js'

export const CHUNK_VALUE_SUMMARY_VERSION = 1

// Facts only: callers must scope chunks through their current permissions and
// statuses. Both branches share a single MVCC snapshot; reads never warm caches.
export function chunkValueSummaryGroupsSql(chunkIdSql) {
  return Prisma.sql`
    WITH summary_state AS MATERIALIZED (
      SELECT groups FROM "ChunkValueSummary"
      WHERE "chunkId" = ${chunkIdSql} AND valid AND "formatVersion" = ${CHUNK_VALUE_SUMMARY_VERSION}
    )
    SELECT g.* FROM summary_state s CROSS JOIN LATERAL jsonb_to_recordset(s.groups) AS g(
      "metricTypeCode" text, unit text, frequency text, "valueCount" bigint,
      "minPeriodStart" timestamp(3), "maxPeriodStart" timestamp(3), "minPeriodEnd" timestamp(3), "maxPeriodEnd" timestamp(3),
      "minIntervalPeriodStart" timestamp(3), "maxIntervalPeriodEnd" timestamp(3),
      "maxCoveredPeriodEnd" timestamp(3), "minParisPeriodStart" timestamp(3),
      "minParisPeriodEnd" timestamp(3), "maxParisPeriodEnd" timestamp(3)
    )
    UNION ALL
    SELECT cv."metricTypeCode", cv.unit, cv.frequency, count(*) AS "valueCount",
      min(cv."periodStart"), max(cv."periodStart"), min(cv."periodEnd"), max(cv."periodEnd"),
      min(cv."periodStart") FILTER (WHERE cv."periodEnd" > cv."periodStart"),
      max(cv."periodEnd") FILTER (WHERE cv."periodEnd" > cv."periodStart"),
      max(cv."periodEnd" - CASE WHEN cv."periodEnd" > cv."periodStart" THEN interval '1 millisecond' ELSE interval '0' END),
      min(cv."periodStart" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Paris'),
      min(cv."periodEnd" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Paris'),
      max(cv."periodEnd" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Paris')
    FROM "ChunkValue" cv
    WHERE cv."chunkId" = ${chunkIdSql} AND NOT EXISTS (SELECT 1 FROM summary_state)
    GROUP BY cv."metricTypeCode", cv.unit, cv.frequency
  `
}

export async function loadChunkValueCounts(chunkIds, {client = prisma} = {}) {
  const ids = [...new Set(chunkIds.filter(Boolean))]
  if (!ids.length) return new Map()
  const rows = await client.$queryRaw(Prisma.sql`
    SELECT c.id, COALESCE(s."valueCount", (
      SELECT count(*) FROM "ChunkValue" cv WHERE cv."chunkId" = c.id
    )) AS "valueCount"
    FROM "Chunk" c LEFT JOIN "ChunkValueSummary" s ON s."chunkId" = c.id
      AND s.valid AND s."formatVersion" = ${CHUNK_VALUE_SUMMARY_VERSION}
    WHERE c.id IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
  `)
  return new Map(rows.map(row => [row.id, Number(row.valueCount)]))
}

export async function refreshChunkValueSummaries(chunkIds, {client = prisma} = {}) {
  const ids = [...new Set(chunkIds.filter(Boolean))].sort()
  if (!ids.length) return 0
  // The SQL function locks each state row before aggregating. All refreshers
  // and statement triggers visit chunk IDs in the same order.
  const [row] = await client.$queryRaw(Prisma.sql`
    SELECT refresh_chunk_value_summaries(ARRAY[${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))}]) AS refreshed
  `)
  return row.refreshed
}

export async function refreshChunkValueSummariesForSourceIds(sourceIds, client = prisma) {
  const ids = [...new Set(sourceIds.filter(Boolean))]
  if (!ids.length) return 0
  const chunks = await client.chunk.findMany({where: {sourceId: {in: ids}}, select: {id: true}})
  return refreshChunkValueSummaries(chunks.map(chunk => chunk.id), {client})
}
