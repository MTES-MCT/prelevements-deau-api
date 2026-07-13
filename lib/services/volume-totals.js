import {Prisma} from '@prisma/client'

import {prisma} from '../../db/prisma.js'
import {
  LEGACY_METRIC_TYPE_CODES,
  METRIC_TYPE_CODES,
  inferFlowTypeFromLegacyMetricTypeCode,
  isVolumeMetricTypeCode
} from '../constants/metric-type-codes.js'
import {POINT_FLOW_TYPES} from '../constants/point-flow-types.js'

function getObjectMetadata(metadata) {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
}

function toNumber(value) {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

export function resolveValueFlowType(flowType, metricTypeCode) {
  return flowType ?? inferFlowTypeFromLegacyMetricTypeCode(metricTypeCode)
}

export function computeChunkVolumeTotals(chunkValues = [], flowType = null) {
  let totalWaterVolume = 0
  let totalWaterVolumeWithdrawn = 0
  let totalWaterVolumeDischarged = 0

  for (const value of chunkValues) {
    if (!isVolumeMetricTypeCode(value.metricTypeCode)) {
      continue
    }

    const numericValue = toNumber(value.value)
    const valueFlowType = resolveValueFlowType(flowType, value.metricTypeCode)
    totalWaterVolume += numericValue

    if (valueFlowType === POINT_FLOW_TYPES.REJET) {
      totalWaterVolumeDischarged += numericValue
    } else if (valueFlowType === POINT_FLOW_TYPES.PRELEVEMENT) {
      totalWaterVolumeWithdrawn += numericValue
    }
  }

  return {
    totalWaterVolume,
    totalWaterVolumeWithdrawn,
    totalWaterVolumeDischarged
  }
}

export async function refreshVolumeMetadataForSourceIds(sourceIds, client = prisma) {
  const uniqueSourceIds = [...new Set(sourceIds.filter(Boolean))]
  if (uniqueSourceIds.length === 0) {
    return
  }

  const [sources, chunks, totals] = await Promise.all([
    client.source.findMany({
      where: {id: {in: uniqueSourceIds}},
      select: {id: true, metadata: true}
    }),
    client.chunk.findMany({
      where: {sourceId: {in: uniqueSourceIds}},
      select: {id: true, sourceId: true, metadata: true}
    }),
    client.$queryRaw`
      SELECT
        c.id AS "chunkId",
        c."sourceId",
        c."instructionStatus"::text AS "instructionStatus",
        COALESCE(SUM(CASE
          WHEN cv."metricTypeCode" IN (
            ${METRIC_TYPE_CODES.VOLUME},
            ${LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE},
            ${LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE}
          ) THEN cv.value
          ELSE 0
        END), 0) AS "totalWaterVolume",
        COALESCE(SUM(CASE
          WHEN cv."metricTypeCode" IN (
            ${METRIC_TYPE_CODES.VOLUME},
            ${LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE},
            ${LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE}
          )
            AND COALESCE(
              c."flowType",
              p."flowType",
              CASE
                WHEN cv."metricTypeCode" = ${LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE}
                  THEN 'REJET'::"PointFlowType"
                ELSE 'PRELEVEMENT'::"PointFlowType"
              END
            ) = 'PRELEVEMENT'::"PointFlowType"
          THEN cv.value
          ELSE 0
        END), 0) AS "totalWaterVolumeWithdrawn",
        COALESCE(SUM(CASE
          WHEN cv."metricTypeCode" IN (
            ${METRIC_TYPE_CODES.VOLUME},
            ${LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE},
            ${LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE}
          )
            AND COALESCE(
              c."flowType",
              p."flowType",
              CASE
                WHEN cv."metricTypeCode" = ${LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE}
                  THEN 'REJET'::"PointFlowType"
                ELSE 'PRELEVEMENT'::"PointFlowType"
              END
            ) = 'REJET'::"PointFlowType"
          THEN cv.value
          ELSE 0
        END), 0) AS "totalWaterVolumeDischarged"
      FROM "Chunk" c
      LEFT JOIN "PointPrelevement" p ON p.id = c."pointPrelevementId"
      LEFT JOIN "ChunkValue" cv ON cv."chunkId" = c.id
      WHERE c."sourceId" IN (${Prisma.join(uniqueSourceIds.map(sourceId => Prisma.sql`${sourceId}::uuid`))})
      GROUP BY c.id, c."sourceId", c."instructionStatus"
    `
  ])

  const totalsByChunkId = new Map(totals.map(row => [row.chunkId, {
    totalWaterVolume: toNumber(row.totalWaterVolume),
    totalWaterVolumeWithdrawn: toNumber(row.totalWaterVolumeWithdrawn),
    totalWaterVolumeDischarged: toNumber(row.totalWaterVolumeDischarged)
  }]))
  const sourceTotals = new Map(uniqueSourceIds.map(sourceId => [sourceId, {
    totalWaterVolumeWithdrawn: 0,
    totalWaterVolumeDischarged: 0
  }]))

  for (const row of totals) {
    if (row.instructionStatus === 'REJECTED') {
      continue
    }

    const sourceTotal = sourceTotals.get(row.sourceId)
    sourceTotal.totalWaterVolumeWithdrawn += toNumber(row.totalWaterVolumeWithdrawn)
    sourceTotal.totalWaterVolumeDischarged += toNumber(row.totalWaterVolumeDischarged)
  }

  await Promise.all([
    ...chunks.map(chunk => client.chunk.update({
      where: {id: chunk.id},
      data: {
        metadata: {
          ...getObjectMetadata(chunk.metadata),
          ...(totalsByChunkId.get(chunk.id) ?? {
            totalWaterVolume: 0,
            totalWaterVolumeWithdrawn: 0,
            totalWaterVolumeDischarged: 0
          })
        }
      }
    })),
    ...sources.map(source => client.source.update({
      where: {id: source.id},
      data: {
        metadata: {
          ...getObjectMetadata(source.metadata),
          ...sourceTotals.get(source.id)
        }
      }
    }))
  ])
}
