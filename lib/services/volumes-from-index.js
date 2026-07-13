import {randomUUID} from 'node:crypto'
import {Prisma} from '@prisma/client'
import {prisma} from '../../db/prisma.js'
import {NON_REJECTED_CHUNK_INSTRUCTION_STATUSES} from '../constants/chunk-statuses.js'
import {
  LEGACY_METRIC_TYPE_CODES,
  METRIC_TYPE_CODES,
  getCompatibleMetricTypeCodes
} from '../constants/metric-type-codes.js'
import {refreshVolumeMetadataForSourceIds} from './volume-totals.js'

/** Séries d’index telles qu’ingérées par l’API déclaration ou le connecteur compte de service. */
export const INDEX_METRIC_TYPE_CODES = [METRIC_TYPE_CODES.INDEX, LEGACY_METRIC_TYPE_CODES.RELEVE_INDEX]

export const VOLUME_METRIC_CODE = METRIC_TYPE_CODES.VOLUME
const VOLUME_METRIC_CODES = getCompatibleMetricTypeCodes(VOLUME_METRIC_CODE)

const RECONSTRUCTION_LOCK_NAMESPACE = 'volumes-from-index'
const RECONSTRUCTION_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 60_000
}
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

async function reconstructVolumesForChunks(chunks, client) {
  const chunkStates = new Map()
  const pointIds = [...new Set(chunks.map(chunk => chunk.pointPrelevementId).filter(Boolean))]
  if (pointIds.length !== 1) {
    throw new Error('reconstructVolumesForChunks requires chunks from a single point')
  }

  const pointId = pointIds[0]

  for (const chunk of chunks) {
    const declared = chunk.chunkValues.filter(v => v.valueKind === 'DECLARED')
    const declaredMetricCodes = [...new Set(declared.map(v => v.metricTypeCode))]
    const hasDeclaredVolume = declared.some(v => VOLUME_METRIC_CODES.includes(v.metricTypeCode))
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

  const computedRows = await client.$queryRaw`
    WITH eligible_chunks AS (
      SELECT c.id, c."preleveurUserId"
      FROM "Chunk" c
      JOIN "Source" s ON s.id = c."sourceId"
      WHERE c."pointPrelevementId" = ${pointId}::uuid
        AND s.status = 'COMPLETED'
        AND c."instructionStatus" IN (${Prisma.join(NON_REJECTED_CHUNK_INSTRUCTION_STATUSES)})
        AND NOT EXISTS (
          SELECT 1
          FROM "ChunkValue" v
          WHERE v."chunkId" = c.id
            AND v."valueKind" = 'DECLARED'
            AND v."metricTypeCode" IN (${Prisma.join(VOLUME_METRIC_CODES)})
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
        v.id,
        v."chunkId",
        ec."preleveurUserId",
        v."periodEnd" AS date,
        v.value::numeric AS value,
        COALESCE(v.unit, 'm³') AS unit,
        v.frequency,
        v."createdAt"
      FROM "ChunkValue" v
      JOIN eligible_chunks ec ON ec.id = v."chunkId"
      WHERE v."valueKind" = 'DECLARED'
        AND v."metricTypeCode" IN (${Prisma.join(INDEX_METRIC_TYPE_CODES)})
    ),
    dedup AS (
      SELECT DISTINCT ON ("preleveurUserId", date)
        "preleveurUserId",
        date,
        value,
        "chunkId",
        unit,
        frequency
      FROM raw_idx
      ORDER BY "preleveurUserId", date, "createdAt" DESC, id DESC
    ),
    calc AS (
      SELECT
        "chunkId",
        LAG(date) OVER (PARTITION BY "preleveurUserId" ORDER BY date) AS "periodStart",
        date AS "periodEnd",
        CASE
          WHEN LAG(value) OVER (PARTITION BY "preleveurUserId" ORDER BY date) IS NULL THEN NULL
          WHEN value - LAG(value) OVER (PARTITION BY "preleveurUserId" ORDER BY date) >= 0
            THEN value - LAG(value) OVER (PARTITION BY "preleveurUserId" ORDER BY date)
          ELSE value
        END AS volume,
        unit,
        frequency
      FROM dedup
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

  if (eligibleChunkIds.length > 0) {
    await client.chunkValue.deleteMany({
      where: {
        chunkId: {in: eligibleChunkIds},
        metricTypeCode: VOLUME_METRIC_CODE,
        valueKind: 'COMPUTED'
      }
    })

    if (computedRows.length > 0) {
      await client.chunkValue.createMany({
        data: computedRows.map(row => ({
          id: randomUUID(),
          chunkId: row.chunkId,
          metricTypeCode: VOLUME_METRIC_CODE,
          unit: row.unit ?? 'm³',
          frequency: row.frequency,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          valueKind: 'COMPUTED',
          value: Number(row.volume)
        }))
      })
    }
  }

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
  const transactionResult = await prisma.$transaction(async tx => {
    await lockPointForReconstruction(tx, pointId)

    const chunks = await tx.chunk.findMany({
      where: {
        pointPrelevementId: pointId,
        instructionStatus: {in: NON_REJECTED_CHUNK_INSTRUCTION_STATUSES},
        source: {status: 'COMPLETED'}
      },
      select: {
        id: true,
        sourceId: true,
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

    if (chunks.length === 0) {
      return {
        pointId,
        sourceIds: [],
        chunksConsidered: 0,
        chunksUpdated: 0,
        volumesCreated: 0,
        details: []
      }
    }

    const result = await reconstructVolumesForChunks(chunks, tx)
    return {
      pointId,
      sourceIds: [...new Set(chunks.map(chunk => chunk.sourceId))],
      ...result
    }
  }, RECONSTRUCTION_TRANSACTION_OPTIONS)

  await refreshVolumeMetadataForSourceIds(transactionResult.sourceIds)

  const {sourceIds, ...result} = transactionResult
  return result
}
