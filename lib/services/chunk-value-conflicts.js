import {Prisma} from '@prisma/client'
import {prisma} from '../../db/prisma.js'
import {computeGlobalInstructionStatus} from '../handlers/chunks.js'
import {MIN_TIME_STEP_MINUTES} from '../util/temporal-discretization.js'

const RESOLUTION_POLICIES = {
  REPLACE_EXISTING: 'REPLACE_EXISTING',
  SKIP_NEW_CHUNK: 'SKIP_NEW_CHUNK'
}

export const CHUNK_VALUE_CONFLICT_POLICIES = Object.freeze([
  RESOLUTION_POLICIES.REPLACE_EXISTING,
  RESOLUTION_POLICIES.SKIP_NEW_CHUNK
])

export function normalizeConflictPolicy(rawPolicy) {
  if (typeof rawPolicy !== 'string') {
    return null
  }

  const normalized = rawPolicy.trim().toUpperCase()
  if (normalized === RESOLUTION_POLICIES.REPLACE_EXISTING) {
    return RESOLUTION_POLICIES.REPLACE_EXISTING
  }

  if (normalized === RESOLUTION_POLICIES.SKIP_NEW_CHUNK) {
    return RESOLUTION_POLICIES.SKIP_NEW_CHUNK
  }

  return null
}

function getDurationMinutes(periodStart, periodEnd) {
  const durationMs = periodEnd.getTime() - periodStart.getTime()
  if (durationMs <= 0) {
    return null
  }

  return durationMs / (60 * 1000)
}

function isPunctualDataset(valueRows) {
  if (valueRows.length === 0) {
    return true
  }

  return valueRows.every(valueRow => getDurationMinutes(valueRow.periodStart, valueRow.periodEnd) === MIN_TIME_STEP_MINUTES)
}

async function getConflictingChunks({pointPrelevementId, valueRows, exactMatchOnly}) {
  if (!pointPrelevementId || valueRows.length === 0) {
    return []
  }

  const minPeriodStart = new Date(Math.min(...valueRows.map(row => row.periodStart.getTime())))
  const maxPeriodEnd = new Date(Math.max(...valueRows.map(row => row.periodEnd.getTime())))
  const incomingPeriods = Prisma.join(
    valueRows.map(row => Prisma.sql`(${row.periodStart}::timestamp, ${row.periodEnd}::timestamp)`)
  )

  const overlapCondition = exactMatchOnly
    ? Prisma.sql`cv."periodStart" = inc."periodStart" AND cv."periodEnd" = inc."periodEnd"`
    // Strict overlap: contiguous intervals are not considered conflicts.
    : Prisma.sql`cv."periodStart" < inc."periodEnd" AND cv."periodEnd" > inc."periodStart"`

  // Keep this query set-based in SQL:
  // - avoids loading many candidate ChunkValues in Node memory
  // - returns only distinct conflicting chunk/source ids
  // - scales better than generating large Prisma OR predicates
  return prisma.$queryRaw`
    WITH incoming ("periodStart", "periodEnd") AS (
      VALUES ${incomingPeriods}
    )
    SELECT DISTINCT cv."chunkId" AS "chunkId", c."sourceId" AS "sourceId"
    FROM "ChunkValue" cv
    JOIN "Chunk" c ON c.id = cv."chunkId"
    JOIN incoming inc ON ${overlapCondition}
    WHERE c."pointPrelevementId" = ${pointPrelevementId}::uuid
      AND c."instructionStatus" IN ('PENDING', 'VALIDATED', 'AUTOMATICALLY_VALIDATED')
      AND cv."periodStart" < ${maxPeriodEnd}::timestamp
      AND cv."periodEnd" > ${minPeriodStart}::timestamp
  `
}

async function refreshGlobalInstructionStatuses(sourceIds) {
  if (!sourceIds?.length) {
    return
  }

  const chunks = await prisma.chunk.findMany({
    where: {
      sourceId: {in: sourceIds}
    },
    select: {
      sourceId: true,
      instructionStatus: true
    }
  })

  const statusesBySourceId = new Map()
  for (const chunk of chunks) {
    const statuses = statusesBySourceId.get(chunk.sourceId) ?? []
    statuses.push(chunk.instructionStatus)
    statusesBySourceId.set(chunk.sourceId, statuses)
  }

  await Promise.all(
    sourceIds.map(sourceId => prisma.source.update({
      where: {id: sourceId},
      data: {
        globalInstructionStatus: computeGlobalInstructionStatus(statusesBySourceId.get(sourceId) ?? [])
      }
    }))
  )
}

export async function applyConflictPolicyForIncomingChunkValues({
  pointPrelevementId,
  valueRows,
  requestedPolicy,
  replaceComment
}) {
  if (!pointPrelevementId || valueRows.length === 0) {
    return {shouldSkip: false, replacedChunkIds: []}
  }

  const punctualDataset = isPunctualDataset(valueRows)
  const normalizedPolicy = normalizeConflictPolicy(requestedPolicy)
  const effectivePolicy = normalizedPolicy

  if (!effectivePolicy) {
    throw new Error(
      'Conflict policy required: expected REPLACE_EXISTING or SKIP_NEW_CHUNK'
    )
  }

  const conflicts = await getConflictingChunks({
    pointPrelevementId,
    valueRows,
    exactMatchOnly: punctualDataset
  })

  if (conflicts.length === 0) {
    return {shouldSkip: false, replacedChunkIds: []}
  }

  if (effectivePolicy === RESOLUTION_POLICIES.SKIP_NEW_CHUNK) {
    return {
      shouldSkip: true,
      replacedChunkIds: []
    }
  }

  const replacedChunkIds = conflicts.map(conflict => conflict.chunkId)
  const affectedSourceIds = [...new Set(conflicts.map(conflict => conflict.sourceId))]

  await prisma.chunk.updateMany({
    where: {
      id: {in: replacedChunkIds}
    },
    data: {
      instructionStatus: 'REJECTED',
      instructedAt: new Date(),
      instructedByInstructorUserId: null,
      instructionComment: replaceComment
    }
  })

  await refreshGlobalInstructionStatuses(affectedSourceIds)

  return {shouldSkip: false, replacedChunkIds}
}
