import {Prisma} from '@prisma/client'
import {prisma} from '../../db/prisma.js'
import {refreshSourceDeclarantsLastDeclarationAt} from '../models/declarant.js'
import {
  LEGACY_METRIC_TYPE_CODES,
  METRIC_TYPE_CODES,
  normalizeMetricTypeCode
} from '../constants/metric-type-codes.js'
import {computeGlobalPointMatchingStatus} from '../handlers/chunks.js'
import {MIN_TIME_STEP_MINUTES} from '../util/temporal-discretization.js'
import {refreshVolumeMetadataForSourceIds} from './volume-totals.js'

const RESOLUTION_POLICIES = {
  REPLACE_EXISTING: 'REPLACE_EXISTING',
  SKIP_NEW_CHUNK: 'SKIP_NEW_CHUNK',
  SKIP_CONFLICTING_VALUES: 'SKIP_CONFLICTING_VALUES',
  REPLACE_EXISTING_EXCEPT_WILLIE: 'REPLACE_EXISTING_EXCEPT_WILLIE'
}
const PROTECTED_REPLACEMENT_CONNECTORS = new Set(['willie'])
const CONFLICT_QUERY_BATCH_SIZE = 1000
const REPLACEMENT_AUDIT_BATCH_SIZE = 1000
const CONFLICT_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 60_000
}

export const CHUNK_VALUE_CONFLICT_POLICIES = Object.freeze([
  RESOLUTION_POLICIES.REPLACE_EXISTING,
  RESOLUTION_POLICIES.SKIP_NEW_CHUNK,
  RESOLUTION_POLICIES.SKIP_CONFLICTING_VALUES,
  RESOLUTION_POLICIES.REPLACE_EXISTING_EXCEPT_WILLIE
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

  if (normalized === RESOLUTION_POLICIES.SKIP_CONFLICTING_VALUES) {
    return RESOLUTION_POLICIES.SKIP_CONFLICTING_VALUES
  }

  if (normalized === RESOLUTION_POLICIES.REPLACE_EXISTING_EXCEPT_WILLIE) {
    return RESOLUTION_POLICIES.REPLACE_EXISTING_EXCEPT_WILLIE
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

function normalizeConnectorName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function getNestedProvider(metadata) {
  const objectMetadata = getObjectMetadata(metadata)
  return getObjectMetadata(objectMetadata.sourceMetadata).provider
}

function getConflictConnector(conflict) {
  return normalizeConnectorName(
    conflict?.sourceConnector
    ?? getObjectMetadata(conflict?.chunkMetadata).connector
    ?? getObjectMetadata(conflict?.chunkParsingInfo).connector
    ?? getObjectMetadata(conflict?.sourceMetadata).connector
    ?? getNestedProvider(conflict?.sourceMetadata)
  )
}

function isProtectedReplacementConflict(conflict) {
  return PROTECTED_REPLACEMENT_CONNECTORS.has(getConflictConnector(conflict))
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))]
}

function shouldOpenConflictTransaction(client) {
  return client === prisma && typeof client.$transaction === 'function'
}

async function getConflictingChunkValuesForBatch({
  client = prisma,
  exactMatchOnly,
  pointPrelevementId,
  preleveurUserId,
  valueRows
}) {
  const minPeriodStart = new Date(Math.min(...valueRows.map(row => row.periodStart.getTime())))
  const maxPeriodEnd = new Date(Math.max(...valueRows.map(row => row.periodEnd.getTime())))
  const incomingPeriods = Prisma.join(
    valueRows.map(row => Prisma.sql`(${row.periodStart}::timestamp, ${row.periodEnd}::timestamp, ${normalizeMetricTypeCode(row.metricTypeCode)}::text)`)
  )

  const normalizedExistingMetric = Prisma.sql`
    CASE
      WHEN cv."metricTypeCode" IN (
        ${LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE},
        ${LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE}
      ) THEN ${METRIC_TYPE_CODES.VOLUME}
      WHEN cv."metricTypeCode" = ${LEGACY_METRIC_TYPE_CODES.DEBIT_PRELEVE}
        THEN ${METRIC_TYPE_CODES.DEBIT}
      WHEN cv."metricTypeCode" = ${LEGACY_METRIC_TYPE_CODES.RELEVE_INDEX}
        THEN ${METRIC_TYPE_CODES.INDEX}
      ELSE cv."metricTypeCode"
    END
  `

  const overlapCondition = exactMatchOnly
    ? Prisma.sql`${normalizedExistingMetric} = inc."metricTypeCode" AND cv."periodStart" = inc."periodStart" AND cv."periodEnd" = inc."periodEnd"`
    // Strict overlap: contiguous intervals are not considered conflicts.
    : Prisma.sql`${normalizedExistingMetric} = inc."metricTypeCode" AND cv."periodStart" < inc."periodEnd" AND cv."periodEnd" > inc."periodStart"`

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
      s.type::text AS "sourceType",
      s.metadata AS "sourceMetadata",
      c.metadata AS "chunkMetadata",
      c."parsingInfo" AS "chunkParsingInfo",
      COALESCE(
        c.metadata->>'connector',
        c."parsingInfo"->>'connector',
        s.metadata->>'connector',
        s.metadata->'sourceMetadata'->>'provider'
      ) AS "sourceConnector",
      d.id AS "declarationId",
      d.code AS "declarationCode",
      c."pointPrelevementId" AS "pointPrelevementId",
      c."preleveurUserId" AS "preleveurUserId",
      ${normalizedExistingMetric} AS "metricTypeCode",
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
      AND (
        (${preleveurUserId}::uuid IS NOT NULL AND c."preleveurUserId" = ${preleveurUserId}::uuid)
        OR (${preleveurUserId}::uuid IS NULL AND c."preleveurUserId" IS NULL)
      )
      AND c."instructionStatus" IN ('PENDING', 'VALIDATED', 'AUTOMATICALLY_VALIDATED')
      AND cv."periodStart" < ${maxPeriodEnd}::timestamp
      AND cv."periodEnd" > ${minPeriodStart}::timestamp
  `
}

export async function findConflictingChunkValuesForIncomingChunkValues({
  client = prisma,
  pointPrelevementId,
  preleveurUserId = null,
  valueRows
}) {
  return getConflictingChunkValues({
    client,
    pointPrelevementId,
    preleveurUserId,
    valueRows,
    exactMatchOnly: isPunctualDataset(valueRows)
  })
}

async function getConflictingChunkValues({
  client = prisma,
  exactMatchOnly,
  pointPrelevementId,
  preleveurUserId,
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
      preleveurUserId,
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

function canCompareConflictPeriod(row) {
  return row?.metricTypeCode && row?.periodStart && row?.periodEnd
}

function getSkippedValueRowsForConflicts({conflicts, valueRows, exactMatchOnly}) {
  if (conflicts.length === 0 || valueRows.length === 0) {
    return []
  }

  if (exactMatchOnly) {
    const conflictKeys = new Set(
      conflicts
        .filter(canCompareConflictPeriod)
        .map(conflict => replacementKey(conflict))
        .filter(Boolean)
    )

    return valueRows.filter(valueRow => conflictKeys.has(replacementKey(valueRow)))
  }

  const conflictsByMetricType = new Map()
  for (const conflict of conflicts.filter(canCompareConflictPeriod)) {
    const metricConflicts = conflictsByMetricType.get(conflict.metricTypeCode) ?? []
    metricConflicts.push(conflict)
    conflictsByMetricType.set(conflict.metricTypeCode, metricConflicts)
  }

  return valueRows.filter(valueRow => {
    if (!canCompareConflictPeriod(valueRow)) {
      return false
    }

    return (conflictsByMetricType.get(valueRow.metricTypeCode) ?? [])
      .some(conflict => datesOverlap(
        conflict.periodStart,
        conflict.periodEnd,
        valueRow.periodStart,
        valueRow.periodEnd
      ))
  })
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

function getConflictsReplacedByValueRows({conflicts, valueRows, exactMatchOnly}) {
  const findReplacement = buildReplacementFinder(valueRows)
  return conflicts.filter(conflict => findReplacement({conflict, exactMatchOnly}))
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

    return client.chunk.update({
      where: {id: chunkId},
      data: {
        minDate: aggregate._min.periodStart,
        maxDate: aggregate._max.periodEnd
      }
    })
  }))
}

export async function refreshReplacedSourcesAfterConflict(sourceIds, client = prisma) {
  const uniqueSourceIds = uniqueValues(sourceIds)
  if (uniqueSourceIds.length === 0) {
    return
  }

  await refreshVolumeMetadataForSourceIds(uniqueSourceIds, client)
  await refreshGlobalInstructionStatuses(uniqueSourceIds, client)
  await Promise.all(uniqueSourceIds.map(async sourceId =>
    refreshSourceDeclarantsLastDeclarationAt(sourceId, {client})
  ))
}

export async function applyConflictPolicyForIncomingChunkValues({
  pointPrelevementId,
  preleveurUserId = null,
  valueRows: rawValueRows,
  requestedPolicy,
  replaceComment,
  replacementSourceId = null,
  replacementMetadata,
  deferredReplacedSourceIds,
  client = prisma,
  findConflictingChunkValues = getConflictingChunkValues
}) {
  const valueRows = rawValueRows.map(valueRow => ({
    ...valueRow,
    metricTypeCode: normalizeMetricTypeCode(valueRow.metricTypeCode)
  }))
  if (!pointPrelevementId || valueRows.length === 0) {
    return {
      shouldSkip: false,
      replacedChunkIds: [],
      valueRowsToInsert: valueRows,
      skippedValueRows: [],
      skippedValueCount: 0
    }
  }

  const punctualDataset = isPunctualDataset(valueRows)
  const normalizedPolicy = normalizeConflictPolicy(requestedPolicy)
  const effectivePolicy = normalizedPolicy

  if (!effectivePolicy) {
    throw new Error(
      `Conflict policy required: expected ${CHUNK_VALUE_CONFLICT_POLICIES.join(' or ')}`
    )
  }

  const conflicts = findConflictingChunkValues === getConflictingChunkValues
    ? await findConflictingChunkValuesForIncomingChunkValues({
      client,
      pointPrelevementId,
      preleveurUserId,
      valueRows
    })
    : await findConflictingChunkValues({
      client,
      pointPrelevementId,
      preleveurUserId,
      valueRows,
      exactMatchOnly: punctualDataset
    })

  if (conflicts.length === 0) {
    return {
      shouldSkip: false,
      replacedChunkIds: [],
      valueRowsToInsert: valueRows,
      skippedValueRows: [],
      skippedValueCount: 0
    }
  }

  if (effectivePolicy === RESOLUTION_POLICIES.SKIP_NEW_CHUNK) {
    return {
      shouldSkip: true,
      replacedChunkIds: [],
      valueRowsToInsert: [],
      skippedValueRows: valueRows,
      skippedValueCount: valueRows.length
    }
  }

  if (effectivePolicy === RESOLUTION_POLICIES.SKIP_CONFLICTING_VALUES) {
    const skippedValueRows = getSkippedValueRowsForConflicts({
      conflicts,
      valueRows,
      exactMatchOnly: punctualDataset
    })
    const skippedValueRowsSet = new Set(skippedValueRows)
    const valueRowsToInsert = valueRows.filter(valueRow => !skippedValueRowsSet.has(valueRow))

    return {
      shouldSkip: valueRowsToInsert.length === 0,
      replacedChunkIds: [],
      valueRowsToInsert,
      skippedValueRows,
      skippedValueCount: skippedValueRows.length
    }
  }

  const replaceConflicts = async ({conflictsToReplace, replacementValueRows}) => {
    const replacedChunkIds = uniqueValues(conflictsToReplace.map(conflict => conflict.chunkId))
    const affectedSourceIds = uniqueValues(conflictsToReplace.map(conflict => conflict.sourceId))
    const replacedChunkValueIds = conflictsToReplace.map(conflict => conflict.chunkValueId)

    const applyReplacement = async tx => {
      await createReplacementAudits({
        conflicts: conflictsToReplace,
        valueRows: replacementValueRows,
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

      if (deferredReplacedSourceIds) {
        for (const sourceId of affectedSourceIds) {
          deferredReplacedSourceIds.add(sourceId)
        }

        return
      }

      await refreshReplacedSourcesAfterConflict(affectedSourceIds, tx)
    }

    await (shouldOpenConflictTransaction(client)
      ? client.$transaction(applyReplacement, CONFLICT_TRANSACTION_OPTIONS)
      : applyReplacement(client))

    return replacedChunkIds
  }

  if (effectivePolicy === RESOLUTION_POLICIES.REPLACE_EXISTING_EXCEPT_WILLIE) {
    const protectedConflicts = conflicts.filter(isProtectedReplacementConflict)
    const skippedValueRows = getSkippedValueRowsForConflicts({
      conflicts: protectedConflicts,
      valueRows,
      exactMatchOnly: punctualDataset
    })
    const skippedValueRowsSet = new Set(skippedValueRows)
    const valueRowsToInsert = valueRows.filter(valueRow => !skippedValueRowsSet.has(valueRow))
    const replaceableConflicts = getConflictsReplacedByValueRows({
      conflicts: conflicts.filter(conflict => !isProtectedReplacementConflict(conflict)),
      valueRows: valueRowsToInsert,
      exactMatchOnly: punctualDataset
    })
    const replacedChunkIds = replaceableConflicts.length > 0
      ? await replaceConflicts({
        conflictsToReplace: replaceableConflicts,
        replacementValueRows: valueRowsToInsert
      })
      : []

    return {
      shouldSkip: valueRowsToInsert.length === 0,
      replacedChunkIds,
      valueRowsToInsert,
      skippedValueRows,
      skippedValueCount: skippedValueRows.length
    }
  }

  const replacedChunkIds = await replaceConflicts({
    conflictsToReplace: conflicts,
    replacementValueRows: valueRows
  })

  return {
    shouldSkip: false,
    replacedChunkIds,
    valueRowsToInsert: valueRows,
    skippedValueRows: [],
    skippedValueCount: 0
  }
}
