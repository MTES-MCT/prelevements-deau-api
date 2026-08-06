import '../lib/config/env.js'

import {prisma} from '../db/prisma.js'
import {
  LEGACY_METRIC_TYPE_CODES,
  METRIC_TYPE_CODES,
  inferFlowTypeFromLegacyMetricTypeCode,
  normalizeMetricTypeCode
} from '../lib/constants/metric-type-codes.js'
import {getSourceFlowTypeFromMetadata} from '../lib/constants/point-flow-types.js'
import {refreshVolumeMetadataForSourceIds} from '../lib/services/volume-totals.js'

const DEFAULT_BATCH_SIZE = 100
const LEGACY_QUICK_MEASUREMENT_TYPES = Object.freeze({
  VOLUME_PRELEVE: 'PRELEVEMENT',
  VOLUME_REJETE: 'REJET'
})
const LEGACY_CODES_TO_NORMALIZE = Object.freeze([
  LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE,
  LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE,
  LEGACY_METRIC_TYPE_CODES.DEBIT_PRELEVE,
  LEGACY_METRIC_TYPE_CODES.RELEVE_INDEX
])
const BACKFILL_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 600_000
}

function hasArg(name) {
  return process.argv.includes(name)
}

function getArgValue(name) {
  const prefix = `${name}=`
  return process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length) ?? null
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function getObjectMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function normalizeMeasurementType(measurementType) {
  if (measurementType === 'VOLUME_PRELEVE' || measurementType === 'VOLUME_REJETE') {
    return 'VOLUME'
  }

  return measurementType
}

function normalizeChunkMetadata(metadata, flowType) {
  const record = getObjectMetadata(metadata)
  const rawMetrics = Array.isArray(record.metrics) ? record.metrics : []
  const inferredSourceFlowTypes = new Set(rawMetrics
    .map(metric => inferFlowTypeFromLegacyMetricTypeCode(getObjectMetadata(metric).parameter))
    .filter(Boolean))
  const quickMeasurementFlowType = LEGACY_QUICK_MEASUREMENT_TYPES[record.measurementType] ?? null
  if (quickMeasurementFlowType) {
    inferredSourceFlowTypes.add(quickMeasurementFlowType)
  }

  const inferredSourceFlowType = inferredSourceFlowTypes.size === 1
    ? [...inferredSourceFlowTypes][0]
    : null
  const sourceFlowType = getSourceFlowTypeFromMetadata(record) ?? inferredSourceFlowType
  const metrics = Array.isArray(record.metrics)
    ? record.metrics.map(metric => {
      const metricRecord = getObjectMetadata(metric)
      return {
        ...metricRecord,
        parameter: normalizeMetricTypeCode(metricRecord.parameter)
      }
    })
    : record.metrics

  return {
    ...record,
    ...(flowType ? {flowType} : {}),
    ...(sourceFlowType ? {sourceFlowType} : {}),
    ...(record.measurementType
      ? {measurementType: normalizeMeasurementType(record.measurementType)}
      : {}),
    ...(metrics ? {metrics} : {})
  }
}

function normalizeSourceMetadata(metadata) {
  const record = getObjectMetadata(metadata)

  return {
    ...record,
    ...(record.measurementType
      ? {measurementType: normalizeMeasurementType(record.measurementType)}
      : {})
  }
}

async function getAudit() {
  const [
    pointCounts,
    rejectionPoints,
    pointsWithoutMeasurements,
    mixedDirectionPoints,
    mixedChunks,
    volumeOverlaps,
    indexCollisions,
    legacyCounts,
    legacyRules,
    invalidLegacyPeriods
  ] = await Promise.all([
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS total
      FROM "PointPrelevement"
      WHERE "deletedAt" IS NULL
    `,
    prisma.$queryRaw`
      SELECT
        p.id,
        p.name,
        p."sourceId",
        BOOL_OR(p."flowType" = 'REJET'::"PointFlowType") AS "alreadyClassifiedAsRejection",
        BOOL_OR(c."flowType" = 'REJET'::"PointFlowType") AS "hasRejectionChunk",
        BOOL_OR(cv."metricTypeCode" = ${LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE}) AS "hasRejectedVolume",
        LOWER(COALESCE(p."sourceId", '')) LIKE '%rejet%' AS "hasSourceHint",
        LOWER(p.name) LIKE '%rejet%' AS "hasNameHint"
      FROM "PointPrelevement" p
      LEFT JOIN "Chunk" c ON c."pointPrelevementId" = p.id
      LEFT JOIN "ChunkValue" cv ON cv."chunkId" = c.id
      GROUP BY p.id, p.name, p."sourceId"
      HAVING
        BOOL_OR(p."flowType" = 'REJET'::"PointFlowType")
        OR BOOL_OR(c."flowType" = 'REJET'::"PointFlowType")
        OR BOOL_OR(cv."metricTypeCode" = ${LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE})
        OR LOWER(COALESCE(p."sourceId", '')) LIKE '%rejet%'
        OR LOWER(p.name) LIKE '%rejet%'
      ORDER BY p.name
    `,
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS total
      FROM "PointPrelevement" p
      WHERE p."deletedAt" IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "Chunk" c
          JOIN "ChunkValue" cv ON cv."chunkId" = c.id
          WHERE c."pointPrelevementId" = p.id
        )
    `,
    prisma.$queryRaw`
      SELECT
        p.id,
        p.name,
        COUNT(*) FILTER (
          WHERE cv."metricTypeCode" = ${LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE}
        )::int AS "withdrawnValueCount",
        COUNT(*) FILTER (
          WHERE cv."metricTypeCode" = ${LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE}
        )::int AS "dischargedValueCount"
      FROM "PointPrelevement" p
      JOIN "Chunk" c ON c."pointPrelevementId" = p.id
      JOIN "ChunkValue" cv ON cv."chunkId" = c.id
      GROUP BY p.id, p.name
      HAVING
        BOOL_OR(cv."metricTypeCode" = ${LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE})
        AND BOOL_OR(cv."metricTypeCode" = ${LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE})
      ORDER BY p.name
    `,
    prisma.$queryRaw`
      SELECT c.id, c."pointPrelevementId"
      FROM "Chunk" c
      JOIN "ChunkValue" cv ON cv."chunkId" = c.id
      GROUP BY c.id, c."pointPrelevementId"
      HAVING BOOL_OR(cv."metricTypeCode" = ${LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE})
        AND BOOL_OR(cv."metricTypeCode" IN (
          ${LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE},
          ${LEGACY_METRIC_TYPE_CODES.DEBIT_PRELEVE}
        ))
    `,
    prisma.$queryRaw`
      SELECT DISTINCT
        left_chunk."pointPrelevementId",
        left_chunk."preleveurUserId",
        left_value.id AS "withdrawnValueId",
        right_value.id AS "dischargedValueId"
      FROM "ChunkValue" left_value
      JOIN "Chunk" left_chunk ON left_chunk.id = left_value."chunkId"
      JOIN "Chunk" right_chunk
        ON right_chunk."pointPrelevementId" = left_chunk."pointPrelevementId"
        AND right_chunk."preleveurUserId" IS NOT DISTINCT FROM left_chunk."preleveurUserId"
      JOIN "ChunkValue" right_value ON right_value."chunkId" = right_chunk.id
      WHERE left_value."metricTypeCode" = ${LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE}
        AND right_value."metricTypeCode" = ${LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE}
        AND left_value."periodStart" < right_value."periodEnd"
        AND right_value."periodStart" < left_value."periodEnd"
      LIMIT 100
    `,
    prisma.$queryRaw`
      SELECT
        c."pointPrelevementId",
        c."preleveurUserId",
        cv."periodStart",
        cv."periodEnd",
        COUNT(*)::int AS count
      FROM "ChunkValue" cv
      JOIN "Chunk" c ON c.id = cv."chunkId"
      WHERE cv."metricTypeCode" IN (
        ${METRIC_TYPE_CODES.INDEX},
        ${LEGACY_METRIC_TYPE_CODES.RELEVE_INDEX}
      )
      GROUP BY c."pointPrelevementId", c."preleveurUserId", cv."periodStart", cv."periodEnd"
      HAVING COUNT(DISTINCT cv."metricTypeCode") > 1
      LIMIT 100
    `,
    prisma.chunkValue.groupBy({
      by: ['metricTypeCode'],
      where: {
        metricTypeCode: {
          in: LEGACY_CODES_TO_NORMALIZE
        }
      },
      _count: {_all: true},
      _sum: {value: true}
    }),
    prisma.resourceRule.groupBy({
      by: ['parameter'],
      where: {
        parameter: {
          in: LEGACY_CODES_TO_NORMALIZE
        }
      },
      _count: {_all: true}
    }),
    prisma.$queryRaw`
      SELECT
        s.id AS "sourceId",
        s."declarationId",
        d.code AS "declarationCode",
        d.type AS "declarationType",
        cv."metricTypeCode",
        cv.frequency,
        COUNT(*)::int AS "valueCount",
        COUNT(DISTINCT c."pointPrelevementId")::int AS "pointCount"
      FROM "ChunkValue" cv
      JOIN "Chunk" c ON c.id = cv."chunkId"
      JOIN "Source" s ON s.id = c."sourceId"
      LEFT JOIN "Declaration" d ON d.id = s."declarationId"
      WHERE cv."metricTypeCode" IN (
        ${LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE},
        ${LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE},
        ${LEGACY_METRIC_TYPE_CODES.DEBIT_PRELEVE},
        ${LEGACY_METRIC_TYPE_CODES.RELEVE_INDEX}
      )
        AND cv."periodEnd" <= cv."periodStart"
      GROUP BY
        s.id,
        s."declarationId",
        d.code,
        d.type,
        cv."metricTypeCode",
        cv.frequency
      ORDER BY s."declarationId", cv."metricTypeCode", cv.frequency
    `
  ])

  return {
    pointCount: pointCounts[0]?.total ?? 0,
    rejectionPoints,
    pointsWithoutMeasurements: pointsWithoutMeasurements[0]?.total ?? 0,
    mixedDirectionPoints,
    mixedChunks,
    volumeOverlaps,
    indexCollisions,
    legacyCounts: legacyCounts.map(row => ({
      metricTypeCode: row.metricTypeCode,
      count: row._count._all,
      sum: Number(row._sum.value ?? 0)
    })),
    legacyRules: legacyRules.map(row => ({
      parameter: row.parameter,
      count: row._count._all
    })),
    invalidLegacyPeriods
  }
}

function assertSafeAudit(audit) {
  const errors = []

  if (audit.mixedChunks.length > 0) {
    errors.push(`${audit.mixedChunks.length} chunk(s) contiennent plusieurs fonctions`)
  }

  if (audit.volumeOverlaps.length > 0) {
    errors.push(`${audit.volumeOverlaps.length} chevauchement(s) prélèvement/rejet`)
  }

  if (audit.indexCollisions.length > 0) {
    errors.push(`${audit.indexCollisions.length} collision(s) entre index historiques`)
  }

  if (errors.length > 0) {
    throw new Error(`Backfill interrompu : ${errors.join(', ')}`)
  }
}

async function normalizeChunkMetadataInBatches(batchSize) {
  let cursor = null

  while (true) {
    const chunks = await prisma.chunk.findMany({
      take: batchSize,
      ...(cursor ? {cursor: {id: cursor}, skip: 1} : {}),
      orderBy: {id: 'asc'},
      select: {id: true, flowType: true, metadata: true}
    })

    if (chunks.length === 0) {
      return
    }

    await prisma.$transaction(chunks.map(chunk => prisma.chunk.update({
      where: {id: chunk.id},
      data: {metadata: normalizeChunkMetadata(chunk.metadata, chunk.flowType)}
    })))

    cursor = chunks.at(-1).id
  }
}

async function normalizeSourceMetadataInBatches(batchSize) {
  let cursor = null

  while (true) {
    const sources = await prisma.source.findMany({
      take: batchSize,
      ...(cursor ? {cursor: {id: cursor}, skip: 1} : {}),
      orderBy: {id: 'asc'},
      select: {id: true, metadata: true}
    })

    if (sources.length === 0) {
      return
    }

    await prisma.$transaction(sources.map(source => prisma.source.update({
      where: {id: source.id},
      data: {metadata: normalizeSourceMetadata(source.metadata)}
    })))

    cursor = sources.at(-1).id
  }
}

async function applyBackfill(audit, batchSize) {
  const rejectionPointIds = audit.rejectionPoints.map(point => point.id)

  await prisma.$transaction(async tx => {
    await tx.pointPrelevement.updateMany({
      data: {flowType: 'PRELEVEMENT'}
    })

    if (rejectionPointIds.length > 0) {
      await tx.pointPrelevement.updateMany({
        where: {id: {in: rejectionPointIds}},
        data: {flowType: 'REJET'}
      })
    }

    await tx.$executeRaw`
      UPDATE "Chunk" c
      SET "flowType" = p."flowType"
      FROM "PointPrelevement" p
      WHERE c."pointPrelevementId" = p.id
    `

    await tx.$executeRaw`
      UPDATE "Chunk" c
      SET "flowType" = CASE
        WHEN EXISTS (
          SELECT 1 FROM "ChunkValue" cv
          WHERE cv."chunkId" = c.id
            AND cv."metricTypeCode" = ${LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE}
        ) THEN 'REJET'::"PointFlowType"
        WHEN EXISTS (
          SELECT 1 FROM "ChunkValue" cv
          WHERE cv."chunkId" = c.id
            AND cv."metricTypeCode" IN (
              ${LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE},
              ${LEGACY_METRIC_TYPE_CODES.DEBIT_PRELEVE}
            )
        ) THEN 'PRELEVEMENT'::"PointFlowType"
        ELSE c."flowType"
      END
      WHERE c."pointPrelevementId" IS NULL
    `

    await tx.$executeRaw`
      UPDATE "ChunkValue"
      SET
        "periodEnd" = "periodStart" + interval '15 minutes',
        frequency = '15 minutes'
      WHERE "metricTypeCode" IN (
        ${METRIC_TYPE_CODES.INDEX},
        ${LEGACY_METRIC_TYPE_CODES.RELEVE_INDEX}
      )
        AND "periodEnd" <= "periodStart"
    `

    const replacements = [
      [LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE, METRIC_TYPE_CODES.VOLUME],
      [LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE, METRIC_TYPE_CODES.VOLUME],
      [LEGACY_METRIC_TYPE_CODES.DEBIT_PRELEVE, METRIC_TYPE_CODES.DEBIT],
      [LEGACY_METRIC_TYPE_CODES.RELEVE_INDEX, METRIC_TYPE_CODES.INDEX]
    ]

    for (const [legacyCode, normalizedCode] of replacements) {
      await tx.$executeRaw`
        UPDATE "ChunkValue"
        SET "metricTypeCode" = ${normalizedCode}
        WHERE "metricTypeCode" = ${legacyCode}
          AND "periodEnd" > "periodStart"
      `
      await tx.chunkValueReplacement.updateMany({
        where: {metricTypeCode: legacyCode},
        data: {metricTypeCode: normalizedCode}
      })
      await tx.resourceRule.updateMany({
        where: {parameter: legacyCode},
        data: {parameter: normalizedCode}
      })
    }
  }, BACKFILL_TRANSACTION_OPTIONS)

  await normalizeChunkMetadataInBatches(batchSize)
  await normalizeSourceMetadataInBatches(batchSize)

  const sourceIds = await prisma.source.findMany({select: {id: true}})
  for (let index = 0; index < sourceIds.length; index += batchSize) {
    await refreshVolumeMetadataForSourceIds(
      sourceIds.slice(index, index + batchSize).map(source => source.id)
    )
  }
}

async function getPostAudit() {
  const [
    nullPointFlowTypes,
    linkedChunkMismatches,
    legacyValuesReady,
    legacyValuesPendingReplay,
    legacyReplacements,
    legacyRules,
    legacyChunkMetadata,
    legacySourceMetadata
  ] = await Promise.all([
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS total
      FROM "PointPrelevement"
      WHERE "flowType" IS NULL
    `,
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS total
      FROM "Chunk" c
      JOIN "PointPrelevement" p ON p.id = c."pointPrelevementId"
      WHERE c."flowType" IS DISTINCT FROM p."flowType"
    `,
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS total
      FROM "ChunkValue"
      WHERE "metricTypeCode" IN (
        ${LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE},
        ${LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE},
        ${LEGACY_METRIC_TYPE_CODES.DEBIT_PRELEVE},
        ${LEGACY_METRIC_TYPE_CODES.RELEVE_INDEX}
      )
        AND "periodEnd" > "periodStart"
    `,
    prisma.$queryRaw`
      SELECT
        s.id AS "sourceId",
        s."declarationId",
        d.code AS "declarationCode",
        d.type AS "declarationType",
        cv."metricTypeCode",
        cv.frequency,
        COUNT(*)::int AS "valueCount",
        COUNT(DISTINCT c."pointPrelevementId")::int AS "pointCount"
      FROM "ChunkValue" cv
      JOIN "Chunk" c ON c.id = cv."chunkId"
      JOIN "Source" s ON s.id = c."sourceId"
      LEFT JOIN "Declaration" d ON d.id = s."declarationId"
      WHERE cv."metricTypeCode" IN (
        ${LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE},
        ${LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE},
        ${LEGACY_METRIC_TYPE_CODES.DEBIT_PRELEVE},
        ${LEGACY_METRIC_TYPE_CODES.RELEVE_INDEX}
      )
        AND cv."periodEnd" <= cv."periodStart"
      GROUP BY
        s.id,
        s."declarationId",
        d.code,
        d.type,
        cv."metricTypeCode",
        cv.frequency
      ORDER BY s."declarationId", cv."metricTypeCode", cv.frequency
    `,
    prisma.chunkValueReplacement.count({
      where: {
        metricTypeCode: {
          in: LEGACY_CODES_TO_NORMALIZE
        }
      }
    }),
    prisma.resourceRule.count({
      where: {parameter: {in: LEGACY_CODES_TO_NORMALIZE}}
    }),
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS total
      FROM "Chunk"
      WHERE "metadata"->>'measurementType' IN ('VOLUME_PRELEVE', 'VOLUME_REJETE')
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof("metadata"->'metrics') = 'array' THEN "metadata"->'metrics'
              ELSE '[]'::jsonb
            END
          ) metric
          WHERE metric->>'parameter' IN (
            ${LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE},
            ${LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE},
            ${LEGACY_METRIC_TYPE_CODES.DEBIT_PRELEVE},
            ${LEGACY_METRIC_TYPE_CODES.RELEVE_INDEX}
          )
        )
    `,
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS total
      FROM "Source"
      WHERE "metadata"->>'measurementType' IN ('VOLUME_PRELEVE', 'VOLUME_REJETE')
    `
  ])

  return {
    nullPointFlowTypes: nullPointFlowTypes[0]?.total ?? 0,
    linkedChunkMismatches: linkedChunkMismatches[0]?.total ?? 0,
    legacyValuesReady: legacyValuesReady[0]?.total ?? 0,
    legacyValuesPendingReplay,
    legacyReplacements,
    legacyRules,
    legacyChunkMetadata: legacyChunkMetadata[0]?.total ?? 0,
    legacySourceMetadata: legacySourceMetadata[0]?.total ?? 0
  }
}

async function main() {
  const apply = hasArg('--apply')
  const batchSize = parsePositiveInteger(getArgValue('--batch-size'), DEFAULT_BATCH_SIZE)
  const audit = await getAudit()

  console.log(JSON.stringify({mode: apply ? 'apply' : 'dry-run', batchSize, ...audit}, null, 2))
  assertSafeAudit(audit)

  if (!apply) {
    console.log('Aucune modification effectuée. Relancer avec --apply pour appliquer le backfill.')
    return
  }

  await applyBackfill(audit, batchSize)
  const postAudit = await getPostAudit()
  const migrationStatus = postAudit.legacyValuesPendingReplay.length > 0
    ? 'REPLAY_REQUIRED'
    : 'COMPLETE'
  console.log(JSON.stringify({migrationStatus, postAudit}, null, 2))

  const blockingPostAuditFields = [
    'nullPointFlowTypes',
    'linkedChunkMismatches',
    'legacyValuesReady',
    'legacyReplacements',
    'legacyRules',
    'legacyChunkMetadata',
    'legacySourceMetadata'
  ]
  if (blockingPostAuditFields.some(field => postAudit[field] !== 0)) {
    throw new Error('Le contrôle post-backfill a détecté des incohérences.')
  }

  if (postAudit.legacyValuesPendingReplay.length > 0) {
    console.warn(
      'Des volumes historiques ont une période source non reconstructible depuis ChunkValue. '
      + 'Rejouer les déclarations listées avec le parseur corrigé, puis relancer ce script.'
    )
  }
}

try {
  await main()
} finally {
  await prisma.$disconnect()
}
