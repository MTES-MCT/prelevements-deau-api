import {Prisma} from '@prisma/client'
import {prisma} from '../../db/prisma.js'
import {METRIC_TYPE_CODES} from '../constants/metric-type-codes.js'
import {computeGlobalPointMatchingStatus} from '../handlers/chunks.js'
import {MIN_TIME_STEP_MINUTES} from '../util/temporal-discretization.js'

const RESOLUTION_POLICIES = {
  REPLACE_EXISTING: 'REPLACE_EXISTING',
  SKIP_NEW_CHUNK: 'SKIP_NEW_CHUNK'
}
const CONFLICT_QUERY_BATCH_SIZE = 1000
const REPLACEMENT_AUDIT_BATCH_SIZE = 1000
const CONFLICT_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 60_000
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

function getObjectMetadata(metadata) {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
}

function toNumber(value) {
  if (value === null || value === undefined) {
    return 0
  }

  if (typeof value === 'number') {
    return value
  }

  if (typeof value === 'string') {
    return Number(value)
  }

  if (typeof value === 'object' && typeof value.toNumber === 'function') {
    return value.toNumber()
  }

  return Number(value)
}

async function getConflictingChunkValuesForBatch({
  client = prisma,
  exactMatchOnly,
  pointPrelevementId,
  valueRows
}) {
  const minPeriodStart = new Date(Math.min(...valueRows.map(row => row.periodStart.getTime())))
  const maxPeriodEnd = new Date(Math.max(...valueRows.map(row => row.periodEnd.getTime())))
  const incomingPeriods = Prisma.join(
    valueRows.map(row => Prisma.sql`(${row.periodStart}::timestamp, ${row.periodEnd}::timestamp, ${row.metricTypeCode}::text)`)
  )

  const overlapCondition = exactMatchOnly
    ? Prisma.sql`cv."metricTypeCode" = inc."metricTypeCode" AND cv."periodStart" = inc."periodStart" AND cv."periodEnd" = inc."periodEnd"`
    // Strict overlap: contiguous intervals are not considered conflicts.
    : Prisma.sql`cv."metricTypeCode" = inc."metricTypeCode" AND cv."periodStart" < inc."periodEnd" AND cv."periodEnd" > inc."periodStart"`

  // Keep this query set-based in SQL:
  // - avoids loading many candidate ChunkValues in Node memory
  // - returns only distinct conflicting value/chunk/source ids
  // - scales better than generating large Prisma OR predicates
  return client.$queryRaw`
    WITH incoming ("periodStart", "periodEnd", "metricTypeCode") AS (
      VALUES ${incomingPeriods}
    )
    SELECT DISTINCT
      cv.id AS "chunkValueId",
      cv."chunkId" AS "chunkId",
      c."sourceId" AS "sourceId",
      d.id AS "declarationId",
      d.code AS "declarationCode",
      c."pointPrelevementId" AS "pointPrelevementId",
      cv."metricTypeCode" AS "metricTypeCode",
      cv.unit AS "unit",
      cv.frequency AS "frequency",
      cv."periodStart" AS "periodStart",
      cv."periodEnd" AS "periodEnd",
      cv."valueKind" AS "valueKind",
      cv.value AS "value"
    FROM "ChunkValue" cv
    JOIN "Chunk" c ON c.id = cv."chunkId"
    LEFT JOIN "Source" s ON s.id = c."sourceId"
    LEFT JOIN "Declaration" d ON d.id = s."declarationId"
    JOIN incoming inc ON ${overlapCondition}
    WHERE c."pointPrelevementId" = ${pointPrelevementId}::uuid
      AND c."instructionStatus" IN ('PENDING', 'VALIDATED', 'AUTOMATICALLY_VALIDATED')
      AND cv."periodStart" < ${maxPeriodEnd}::timestamp
      AND cv."periodEnd" > ${minPeriodStart}::timestamp
  `
}

export async function findConflictingChunkValuesForIncomingChunkValues({
  client = prisma,
  pointPrelevementId,
  valueRows
}) {
  return getConflictingChunkValues({
    client,
    pointPrelevementId,
    valueRows,
    exactMatchOnly: isPunctualDataset(valueRows)
  })
}

async function getConflictingChunkValues({
  client = prisma,
  exactMatchOnly,
  pointPrelevementId,
  valueRows
}) {
  if (!pointPrelevementId || valueRows.length === 0) {
    return []
  }

  const conflictsByValueId = new Map()

  for (let index = 0; index < valueRows.length; index += CONFLICT_QUERY_BATCH_SIZE) {
    const valueRowsBatch = valueRows.slice(index, index + CONFLICT_QUERY_BATCH_SIZE)

    // eslint-disable-next-line no-await-in-loop
    const conflicts = await getConflictingChunkValuesForBatch({
      client,
      pointPrelevementId,
      valueRows: valueRowsBatch,
      exactMatchOnly
    })

    for (const conflict of conflicts) {
      conflictsByValueId.set(conflict.chunkValueId, conflict)
    }
  }

  return [...conflictsByValueId.values()]
}

async function refreshGlobalInstructionStatuses(sourceIds, client = prisma) {
  if (!sourceIds?.length) {
    return
  }

  const chunks = await client.chunk.findMany({
    where: {
      sourceId: {in: sourceIds}
    },
    select: {
      sourceId: true,
      pointPrelevementId: true
    }
  })

  const chunksBySourceId = new Map()
  for (const chunk of chunks) {
    const sourceChunks = chunksBySourceId.get(chunk.sourceId) ?? []
    sourceChunks.push(chunk)
    chunksBySourceId.set(chunk.sourceId, sourceChunks)
  }

  await Promise.all(
    sourceIds.map(sourceId => client.source.update({
      where: {id: sourceId},
      data: {
        globalInstructionStatus: computeGlobalPointMatchingStatus(chunksBySourceId.get(sourceId) ?? [])
      }
    }))
  )
}

async function deleteConflictingChunkValues(chunkValueIds, client = prisma) {
  for (let index = 0; index < chunkValueIds.length; index += CONFLICT_QUERY_BATCH_SIZE) {
    const chunkValueIdsBatch = chunkValueIds.slice(index, index + CONFLICT_QUERY_BATCH_SIZE)

    // eslint-disable-next-line no-await-in-loop
    await client.chunkValue.deleteMany({
      where: {
        id: {in: chunkValueIdsBatch}
      }
    })
  }
}

function hasReplacementAuditClient(client) {
  return typeof client?.chunkValueReplacement?.createMany === 'function'
}

function datesOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart < rightEnd && leftEnd > rightStart
}

function isSamePeriod(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart.getTime() === rightStart.getTime() && leftEnd.getTime() === rightEnd.getTime()
}

function findReplacementValueRow({conflict, valueRows, exactMatchOnly}) {
  if (!conflict?.metricTypeCode || !conflict?.periodStart || !conflict?.periodEnd) {
    return null
  }

  return valueRows.find(valueRow => {
    if (valueRow.metricTypeCode !== conflict.metricTypeCode || !valueRow.periodStart || !valueRow.periodEnd) {
      return false
    }

    return exactMatchOnly
      ? isSamePeriod(conflict.periodStart, conflict.periodEnd, valueRow.periodStart, valueRow.periodEnd)
      : datesOverlap(conflict.periodStart, conflict.periodEnd, valueRow.periodStart, valueRow.periodEnd)
  }) ?? null
}

function replacementKey({metricTypeCode, periodStart, periodEnd}) {
  if (!metricTypeCode || !periodStart || !periodEnd) {
    return null
  }

  return `${metricTypeCode}:${periodStart.getTime()}:${periodEnd.getTime()}`
}

function buildReplacementFinder(valueRows) {
  const exactRowsByKey = new Map()
  const rowsByMetricType = new Map()

  for (const valueRow of valueRows) {
    const key = replacementKey(valueRow)

    if (key) {
      exactRowsByKey.set(key, valueRow)
    }

    if (valueRow.metricTypeCode) {
      const rows = rowsByMetricType.get(valueRow.metricTypeCode) ?? []
      rows.push(valueRow)
      rowsByMetricType.set(valueRow.metricTypeCode, rows)
    }
  }

  return ({conflict, exactMatchOnly}) => {
    const exactReplacement = exactRowsByKey.get(replacementKey(conflict))
    if (exactReplacement) {
      return exactReplacement
    }

    if (exactMatchOnly) {
      return null
    }

    return findReplacementValueRow({
      conflict,
      valueRows: rowsByMetricType.get(conflict.metricTypeCode) ?? [],
      exactMatchOnly: false
    })
  }
}

function canAuditConflict(conflict) {
  return conflict?.chunkValueId
    && conflict?.chunkId
    && conflict?.sourceId
    && conflict?.metricTypeCode
    && conflict?.frequency
    && conflict?.periodStart
    && conflict?.periodEnd
    && conflict?.valueKind
    && conflict?.value !== undefined
}

async function createReplacementAudits({
  conflicts,
  valueRows,
  conflictPolicy,
  replaceComment,
  replacementSourceId,
  replacementMetadata,
  exactMatchOnly,
  client = prisma
}) {
  if (!hasReplacementAuditClient(client)) {
    return
  }

  const findReplacement = buildReplacementFinder(valueRows)
  const auditRows = conflicts
    .filter(canAuditConflict)
    .map(conflict => {
      const replacement = findReplacement({
        conflict,
        exactMatchOnly
      })

      return {
        replacedChunkValueId: conflict.chunkValueId,
        replacedChunkId: conflict.chunkId,
        replacedSourceId: conflict.sourceId,
        replacementChunkValueId: replacement?.id ?? null,
        replacementChunkId: replacement?.chunkId ?? null,
        replacementSourceId: replacementSourceId ?? null,
        pointPrelevementId: conflict.pointPrelevementId ?? null,
        metricTypeCode: conflict.metricTypeCode,
        unit: conflict.unit ?? null,
        frequency: conflict.frequency,
        periodStart: conflict.periodStart,
        periodEnd: conflict.periodEnd,
        valueKind: conflict.valueKind,
        value: conflict.value,
        conflictPolicy,
        replaceComment: replaceComment ?? null,
        metadata: replacementMetadata ?? undefined
      }
    })

  for (let index = 0; index < auditRows.length; index += REPLACEMENT_AUDIT_BATCH_SIZE) {
    const batch = auditRows.slice(index, index + REPLACEMENT_AUDIT_BATCH_SIZE)

    // eslint-disable-next-line no-await-in-loop
    await client.chunkValueReplacement.createMany({
      data: batch,
      skipDuplicates: true
    })
  }
}

async function refreshPartiallyReplacedChunks({chunkIds, replaceComment, client = prisma}) {
  if (chunkIds.length === 0) {
    return
  }

  const chunks = await client.chunk.findMany({
    where: {
      id: {in: chunkIds}
    },
    select: {
      id: true,
      metadata: true
    }
  })
  const chunkMetadataById = new Map(chunks.map(chunk => [chunk.id, chunk.metadata]))
  const aggregates = await client.chunkValue.groupBy({
    by: ['chunkId'],
    where: {
      chunkId: {in: chunkIds}
    },
    _count: {_all: true},
    _min: {periodStart: true},
    _max: {periodEnd: true}
  })
  const aggregatesByChunkId = new Map(aggregates.map(aggregate => [aggregate.chunkId, aggregate]))
  const volumeRows = await client.chunkValue.groupBy({
    by: ['chunkId', 'metricTypeCode'],
    where: {
      chunkId: {in: chunkIds},
      metricTypeCode: {in: [METRIC_TYPE_CODES.VOLUME_PRELEVE, METRIC_TYPE_CODES.VOLUME_REJETE]}
    },
    _sum: {
      value: true
    }
  })
  const totalsByChunkId = new Map()

  for (const row of volumeRows) {
    const totals = totalsByChunkId.get(row.chunkId) ?? {
      totalWaterVolumeWithdrawn: 0,
      totalWaterVolumeDischarged: 0
    }

    if (row.metricTypeCode === METRIC_TYPE_CODES.VOLUME_PRELEVE) {
      totals.totalWaterVolumeWithdrawn = toNumber(row._sum.value)
    } else if (row.metricTypeCode === METRIC_TYPE_CODES.VOLUME_REJETE) {
      totals.totalWaterVolumeDischarged = toNumber(row._sum.value)
    }

    totalsByChunkId.set(row.chunkId, totals)
  }

  await Promise.all(chunkIds.map(chunkId => {
    const aggregate = aggregatesByChunkId.get(chunkId)

    if (!aggregate?._count?._all) {
      return client.chunk.update({
        where: {id: chunkId},
        data: {
          instructionStatus: 'REJECTED',
          instructedAt: new Date(),
          instructedByInstructorUserId: null,
          instructionComment: replaceComment
        }
      })
    }

    const totals = totalsByChunkId.get(chunkId) ?? {
      totalWaterVolumeWithdrawn: 0,
      totalWaterVolumeDischarged: 0
    }

    return client.chunk.update({
      where: {id: chunkId},
      data: {
        minDate: aggregate._min.periodStart,
        maxDate: aggregate._max.periodEnd,
        metadata: {
          ...getObjectMetadata(chunkMetadataById.get(chunkId)),
          ...totals
        }
      }
    })
  }))
}

async function refreshSourceVolumeMetadata(sourceIds, client = prisma) {
  if (sourceIds.length === 0) {
    return
  }

  const sources = await client.source.findMany({
    where: {
      id: {in: sourceIds}
    },
    select: {
      id: true,
      metadata: true
    }
  })
  const sourceMetadataById = new Map(sources.map(source => [source.id, source.metadata]))
  const totals = await client.$queryRaw`
    SELECT
      s.id AS "sourceId",
      COALESCE(SUM(CASE WHEN cv."metricTypeCode" = ${METRIC_TYPE_CODES.VOLUME_PRELEVE} THEN cv.value ELSE 0 END), 0) AS "totalWaterVolumeWithdrawn",
      COALESCE(SUM(CASE WHEN cv."metricTypeCode" = ${METRIC_TYPE_CODES.VOLUME_REJETE} THEN cv.value ELSE 0 END), 0) AS "totalWaterVolumeDischarged"
    FROM "Source" s
    LEFT JOIN "Chunk" c
      ON c."sourceId" = s.id
      AND c."instructionStatus" IN ('PENDING', 'VALIDATED', 'AUTOMATICALLY_VALIDATED')
    LEFT JOIN "ChunkValue" cv ON cv."chunkId" = c.id
    WHERE s.id IN (${Prisma.join(sourceIds.map(sourceId => Prisma.sql`${sourceId}::uuid`))})
    GROUP BY s.id
  `

  await Promise.all(totals.map(row => client.source.update({
    where: {
      id: row.sourceId
    },
    data: {
      metadata: {
        ...getObjectMetadata(sourceMetadataById.get(row.sourceId)),
        totalWaterVolumeWithdrawn: toNumber(row.totalWaterVolumeWithdrawn),
        totalWaterVolumeDischarged: toNumber(row.totalWaterVolumeDischarged)
      }
    }
  })))
}

export async function applyConflictPolicyForIncomingChunkValues({
  pointPrelevementId,
  valueRows,
  requestedPolicy,
  replaceComment,
  replacementSourceId = null,
  replacementMetadata,
  client = prisma,
  findConflictingChunkValues = getConflictingChunkValues
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

  const conflicts = findConflictingChunkValues === getConflictingChunkValues
    ? await findConflictingChunkValuesForIncomingChunkValues({
      client,
      pointPrelevementId,
      valueRows
    })
    : await findConflictingChunkValues({
      client,
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

  const replacedChunkIds = [...new Set(conflicts.map(conflict => conflict.chunkId))]
  const affectedSourceIds = [...new Set(conflicts.map(conflict => conflict.sourceId))]
  const replacedChunkValueIds = conflicts.map(conflict => conflict.chunkValueId)

  const replaceConflicts = async tx => {
    await createReplacementAudits({
      conflicts,
      valueRows,
      conflictPolicy: effectivePolicy,
      replaceComment,
      replacementSourceId,
      replacementMetadata,
      exactMatchOnly: punctualDataset,
      client: tx
    })
    await deleteConflictingChunkValues(replacedChunkValueIds, tx)
    await refreshPartiallyReplacedChunks({
      chunkIds: replacedChunkIds,
      replaceComment,
      client: tx
    })
    await refreshSourceVolumeMetadata(affectedSourceIds, tx)
    await refreshGlobalInstructionStatuses(affectedSourceIds, tx)
  }

  await (typeof client.$transaction === 'function'
    ? client.$transaction(replaceConflicts, CONFLICT_TRANSACTION_OPTIONS)
    : replaceConflicts(client))

  return {shouldSkip: false, replacedChunkIds}
}
