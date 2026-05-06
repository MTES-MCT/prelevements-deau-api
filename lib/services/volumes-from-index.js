import {randomUUID} from 'node:crypto'
import {Prisma} from '@prisma/client'
import {prisma} from '../../db/prisma.js'
import {METRIC_TYPE_CODES} from '../constants/metric-type-codes.js'

/** Séries d’index telles qu’ingérées par l’API déclaration ou le connecteur compte de service. */
export const INDEX_METRIC_TYPE_CODES = [METRIC_TYPE_CODES.RELEVE_INDEX, METRIC_TYPE_CODES.INDEX]

export const VOLUME_PRELEVE_METRIC_CODE = METRIC_TYPE_CODES.VOLUME_PRELEVE

const RECONSTRUCTION_LOCK_NAMESPACE = 'volumes-from-index'
async function lockPointForReconstruction(tx, pointId) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${RECONSTRUCTION_LOCK_NAMESPACE}),
      hashtext(${pointId})
    )
  `
}

function isIndexMetricCode(code) {
  return INDEX_METRIC_TYPE_CODES.includes(code)
}

function getChunkSkipReason({hasDeclaredVolume, onlyIndexDeclared}) {
  if (hasDeclaredVolume) {
    return 'DECLARED_VOLUME_PRESENT'
  }

  if (!onlyIndexDeclared) {
    return 'NOT_INDEX_ONLY_DECLARED'
  }

  return null
}

async function reconstructVolumesForChunks(chunks) {
  const chunkStates = new Map()
  const pointIds = [...new Set(chunks.map(chunk => chunk.pointPrelevementId).filter(Boolean))]
  if (pointIds.length !== 1) {
    throw new Error('reconstructVolumesForChunks requires chunks from a single point')
  }

  const pointId = pointIds[0]

  for (const chunk of chunks) {
    const declared = chunk.chunkValues.filter(v => v.valueKind === 'DECLARED')
    const declaredMetricCodes = [...new Set(declared.map(v => v.metricTypeCode))]
    const hasDeclaredVolume = declared.some(v => v.metricTypeCode === VOLUME_PRELEVE_METRIC_CODE)
    const onlyIndexDeclared
      = declaredMetricCodes.length > 0 && declaredMetricCodes.every(isIndexMetricCode)
    const reason = getChunkSkipReason({hasDeclaredVolume, onlyIndexDeclared})

    const state = {
      chunkId: chunk.id,
      eligible: reason === null,
      reason,
      created: 0
    }
    chunkStates.set(chunk.id, state)

    if (!state.eligible) {
      continue
    }
  }

  const eligibleChunkIds = [...chunkStates.values()]
    .filter(state => state.eligible)
    .map(state => state.chunkId)

  const computedRows = await prisma.$queryRaw`
    WITH eligible_chunks AS (
      SELECT c.id
      FROM "Chunk" c
      JOIN "Source" s ON s.id = c."sourceId"
      WHERE c."pointPrelevementId" = ${pointId}::uuid
        AND s.status = 'COMPLETED'
        AND NOT EXISTS (
          SELECT 1
          FROM "ChunkValue" v
          WHERE v."chunkId" = c.id
            AND v."valueKind" = 'DECLARED'
            AND v."metricTypeCode" = ${VOLUME_PRELEVE_METRIC_CODE}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "ChunkValue" v
          WHERE v."chunkId" = c.id
            AND v."valueKind" = 'DECLARED'
            AND v."metricTypeCode" NOT IN (${Prisma.join(INDEX_METRIC_TYPE_CODES)})
        )
    ),
    raw_idx AS (
      SELECT
        v."chunkId",
        v."periodEnd" AS date,
        v.value::numeric AS value,
        COALESCE(v.unit, 'm³') AS unit,
        v.frequency
      FROM "ChunkValue" v
      JOIN eligible_chunks ec ON ec.id = v."chunkId"
      WHERE v."valueKind" = 'DECLARED'
        AND v."metricTypeCode" IN (${Prisma.join(INDEX_METRIC_TYPE_CODES)})
    ),
    dedup AS (
      SELECT
        date,
        MAX(value) AS value
      FROM raw_idx
      GROUP BY date
    ),
    dedup_with_chunk AS (
      SELECT DISTINCT ON (r.date)
        r.date,
        d.value,
        r."chunkId",
        r.unit,
        r.frequency
      FROM raw_idx r
      JOIN dedup d ON d.date = r.date AND d.value = r.value
      ORDER BY r.date, r.value DESC, r."chunkId"
    ),
    calc AS (
      SELECT
        "chunkId",
        LAG(date) OVER (ORDER BY date) AS "periodStart",
        date AS "periodEnd",
        CASE
          WHEN LAG(value) OVER (ORDER BY date) IS NULL THEN NULL
          WHEN value - LAG(value) OVER (ORDER BY date) >= 0
            THEN value - LAG(value) OVER (ORDER BY date)
          ELSE value
        END AS volume,
        unit,
        frequency
      FROM dedup_with_chunk
    )
    SELECT "chunkId", "periodStart", "periodEnd", volume, unit, frequency
    FROM calc
    WHERE "periodStart" IS NOT NULL
  `

  const rowsByChunkId = new Map()
  for (const row of computedRows) {
    const rows = rowsByChunkId.get(row.chunkId) ?? []
    rows.push(row)
    rowsByChunkId.set(row.chunkId, rows)
  }

  await prisma.$transaction(async tx => {
    if (eligibleChunkIds.length === 0) {
      return
    }

    await tx.chunkValue.deleteMany({
      where: {
        chunkId: {in: eligibleChunkIds},
        metricTypeCode: VOLUME_PRELEVE_METRIC_CODE,
        valueKind: 'COMPUTED'
      }
    })

    if (computedRows.length === 0) {
      return
    }

    await tx.chunkValue.createMany({
      data: computedRows.map(row => ({
        id: randomUUID(),
        chunkId: row.chunkId,
        metricTypeCode: VOLUME_PRELEVE_METRIC_CODE,
        unit: row.unit ?? 'm³',
        frequency: row.frequency,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        valueKind: 'COMPUTED',
        value: Number(row.volume)
      }))
    })
  })

  for (const state of chunkStates.values()) {
    if (!state.eligible) {
      continue
    }

    const created = (rowsByChunkId.get(state.chunkId) ?? []).length
    state.created = created
    state.reason = created === 0 ? 'NO_INTERVAL_ENDING_IN_CHUNK' : null
  }

  const chunksUpdated = eligibleChunkIds.length
  const volumesCreated = computedRows.length

  const details = chunks.map(chunk => {
    const state = chunkStates.get(chunk.id)
    return {
      chunkId: chunk.id,
      created: state?.created ?? 0,
      skipped: !state?.eligible,
      reason: state?.reason ?? null
    }
  })

  return {chunksConsidered: chunks.length, chunksUpdated, volumesCreated, details}
}

/**
 * Reconstruit les volumes à partir des index pour tous les chunks rattachés à un point.
 *
 * @param {string} pointId
 * @returns {Promise<{ pointId: string, chunksConsidered: number, chunksUpdated: number, volumesCreated: number, details: Array<{ chunkId: string, created: number, skipped?: boolean, reason?: string }> }>}
 */
export async function reconstructVolumesFromIndexForPoint(pointId) {
  return prisma.$transaction(async tx => {
    await lockPointForReconstruction(tx, pointId)

    const chunks = await prisma.chunk.findMany({
      where: {
        pointPrelevementId: pointId,
        source: {status: 'COMPLETED'}
      },
      select: {
        id: true,
        pointPrelevementId: true,
        chunkValues: {
          select: {
            metricTypeCode: true,
            valueKind: true,
            periodStart: true,
            periodEnd: true,
            value: true,
            unit: true,
            frequency: true
          }
        }
      }
    })

    const result = await reconstructVolumesForChunks(chunks)
    return {
      pointId,
      ...result
    }
  })
}
