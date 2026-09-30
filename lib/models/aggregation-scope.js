import {Prisma} from '@prisma/client'
import {NON_REJECTED_CHUNK_INSTRUCTION_STATUSES} from '../constants/chunk-statuses.js'

export function aggregationUuidList(ids) {
  return Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))
}

// SQL equivalent of getMeterSeriesChunkScope. Ordinary series keep their
// historical point-level visibility; shared meter volumes require an actual
// contribution belonging to a delegated exploitation. Chunk.exploitationId is
// deliberately NOT used as proof of that delegation (legacy records can differ).
// Materialize the contribution-backed grants once, instead of traversing this
// relationship separately for every candidate value in a correlated subquery.
export function buildAggregationChunkScope({
  pointIds = [], sourceId, exploitationId, user, preleveurId, collecteurId,
  pointFlowType, includeLegacyPreleveurFallback = false
}) {
  const actorIsDeclarant = user?.role === 'DECLARANT'
    || (includeLegacyPreleveurFallback && !user?.role && Boolean(user?.id))
  const actorIsCollector = actorIsDeclarant && user.declarant?.declarantRole === 'COLLECTEUR'
  const collectorIds = [...new Set([collecteurId, actorIsCollector && user.id].filter(Boolean))]
  // One set per distinct collector also avoids a second collector filter on a
  // materialized CTE: that filter's default cardinality estimate can turn a
  // broad collector request into thousands of poorly planned nested lookups.
  const collectorTables = new Map(collectorIds.map((id, index) => [id, Prisma.raw(`aggregation_collector_chunks_${index}`)]))
  const ctes = collectorIds.length ? Prisma.join(collectorIds.map(id => Prisma.sql`
    ${collectorTables.get(id)} AS MATERIALIZED (
      SELECT DISTINCT scoped_value."chunkId"
      FROM "DeclarantCollecteurExploitation" delegation
      JOIN "MeterAllocation" allocation ON allocation."exploitationId" = delegation."exploitationId"
      JOIN "MeterAllocationVersion" version ON version."allocationId" = allocation.id
      JOIN "MeterVolumeContribution" contribution ON contribution."allocationVersionId" = version.id
      JOIN "ChunkValue" scoped_value ON scoped_value.id = contribution."chunkValueId"
      WHERE delegation."collecteurUserId" = ${id}::uuid
    )`)) : Prisma.empty
  const collectorScope = id => Prisma.sql`c.id IN (
    SELECT "chunkId" FROM ${collectorTables.get(id)}
  )`
  const meterRestrictions = []
  if (actorIsDeclarant) {
    meterRestrictions.push(actorIsCollector
      ? Prisma.sql`(c."preleveurUserId" = ${user.id}::uuid OR ${collectorScope(user.id)})`
      : Prisma.sql`c."preleveurUserId" = ${user.id}::uuid`)
  } else if (user?.role === 'INSTRUCTOR') {
    meterRestrictions.push(pointIds.length
      ? Prisma.sql`c."pointPrelevementId" IN (${aggregationUuidList(pointIds)})`
      : Prisma.sql`false`)
  } else if (user && user.role !== 'ADMIN') {
    meterRestrictions.push(Prisma.sql`false`)
  }
  if (preleveurId) meterRestrictions.push(Prisma.sql`c."preleveurUserId" = ${preleveurId}::uuid`)
  if (collecteurId) meterRestrictions.push(collectorScope(collecteurId))

  const where = Prisma.sql`
    c."instructionStatus" IN (${Prisma.join(NON_REJECTED_CHUNK_INSTRUCTION_STATUSES.map(status => Prisma.sql`${status}::"ChunkInstructionStatus"`))})
    AND source.status = 'COMPLETED'::"SourceStatus"
    ${pointIds.length ? Prisma.sql`AND c."pointPrelevementId" IN (${aggregationUuidList(pointIds)})` : Prisma.empty}
    ${sourceId ? Prisma.sql`AND c."sourceId" = ${sourceId}::uuid` : Prisma.empty}
    ${exploitationId ? Prisma.sql`AND c."exploitationId" = ${exploitationId}::uuid` : Prisma.empty}
    ${pointFlowType ? Prisma.sql`AND COALESCE(c."flowType", point."flowType") = ${pointFlowType}::"PointFlowType"` : Prisma.empty}
    ${meterRestrictions.length ? Prisma.sql`AND (c."calculationStrategy" <> 'METER' OR (${Prisma.join(meterRestrictions, ' AND ')}))` : Prisma.empty}
    ${includeLegacyPreleveurFallback && preleveurId ? Prisma.sql`
      AND (c."preleveurUserId" = ${preleveurId}::uuid OR (
        c."preleveurUserId" IS NULL AND c."pointPrelevementId" IN (
          SELECT "pointPrelevementId" FROM "DeclarantPointPrelevement" WHERE "declarantUserId" = ${preleveurId}::uuid
        )
      ))` : Prisma.empty}
  `
  return {ctes, where}
}
