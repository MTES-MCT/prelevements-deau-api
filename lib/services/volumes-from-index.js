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

// A reported change has no known replacement date. Keep the declared readings,
// but never bridge across their campaign interval, even through other sources.
function campaignBlockedWindows(where) {
  return Prisma.sql`
    SELECT c."pointPrelevementId", c."preleveurUserId", c."exploitationId", c."compteurId",
      MIN(v."periodEnd") AS "blockedStart", MAX(v."periodEnd") AS "blockedEnd"
    FROM "Chunk" c JOIN "Source" s ON s.id = c."sourceId"
    JOIN "ChunkValue" v ON v."chunkId" = c.id
    WHERE c.metadata->>'campaignMeterChangeBlocked' = 'true'
      AND c.metadata->>'collectionCampaignId' IS NOT NULL
      AND s.status = 'COMPLETED' AND c."instructionStatus" <> 'REJECTED'
      AND v."valueKind" = 'DECLARED' AND v."metricTypeCode" IN (${Prisma.join(INDEX_METRIC_TYPE_CODES)})
      ${where}
    GROUP BY c."pointPrelevementId", c."preleveurUserId", c."exploitationId", c."compteurId", c."sourceId"
  `
}

export async function suppressCampaignMeterVolumes(tx, campaignId, compteurIds) {
  if (!compteurIds.length) return
  const rows = await tx.$queryRaw`
    WITH blocked AS (${campaignBlockedWindows(Prisma.sql`AND c.metadata->>'collectionCampaignId' = ${campaignId}
      AND c."compteurId" IN (${Prisma.join(compteurIds.map(id => Prisma.sql`${id}::uuid`))})`)})
    SELECT v.id, c."sourceId" FROM "ChunkValue" v JOIN "Chunk" c ON c.id = v."chunkId"
    WHERE c."calculationStrategy" = 'GENERIC' AND v."valueKind" = 'COMPUTED'
      AND v."metricTypeCode" IN (${Prisma.join(VOLUME_METRIC_CODES)})
      AND EXISTS (SELECT 1 FROM blocked b WHERE b."pointPrelevementId" = c."pointPrelevementId"
        AND b."preleveurUserId" IS NOT DISTINCT FROM c."preleveurUserId"
        AND b."exploitationId" IS NOT DISTINCT FROM c."exploitationId" AND b."compteurId" = c."compteurId"
        AND v."periodStart" < b."blockedEnd" AND v."periodEnd" > b."blockedStart")
  `
  if (!rows.length) return
  await tx.chunkValue.deleteMany({where: {id: {in: rows.map(row => row.id)}, valueKind: 'COMPUTED'}})
  await refreshVolumeMetadataForSourceIds([...new Set(rows.map(row => row.sourceId))], tx)
}

const RECONSTRUCTION_LOCK_NAMESPACE = 'volumes-from-index'
const RECONSTRUCTION_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 60_000
}
export async function lockPointForReconstruction(tx, pointId) {
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

export async function reconstructVolumesForChunks(chunks, client, scope = {}) {
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
    const reason = chunk.autoCalculateVolumes === false
      ? 'MANUAL_PUBLICATION_REQUIRED'
      : chunk.calculationStrategy !== 'GENERIC'
        ? 'NON_GENERIC_CALCULATION'
        : getChunkSkipReason({hasDeclaredVolume, onlyIndexDeclared})

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
    WITH blocked AS (${campaignBlockedWindows(Prisma.sql`AND c."pointPrelevementId" = ${pointId}::uuid`)}), eligible_chunks AS (
      SELECT c.id, c."preleveurUserId", c."exploitationId", c."compteurId"
      FROM "Chunk" c
      JOIN "Source" s ON s.id = c."sourceId"
      WHERE c."pointPrelevementId" = ${pointId}::uuid
        AND s.status = 'COMPLETED'
        AND c."calculationStrategy" = 'GENERIC'
        AND c."autoCalculateVolumes" = true
        ${scope.exploitationId ? Prisma.sql`AND c."exploitationId" = ${scope.exploitationId}::uuid` : Prisma.empty}
        ${scope.compteurIds?.length ? Prisma.sql`AND c."compteurId" IN (${Prisma.join(scope.compteurIds.map(id => Prisma.sql`${id}::uuid`))})` : Prisma.empty}
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
        ec."exploitationId",
        ec."compteurId",
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
      SELECT DISTINCT ON ("preleveurUserId", "exploitationId", "compteurId", date)
        "preleveurUserId",
        "exploitationId",
        "compteurId",
        date,
        value,
        "chunkId",
        unit,
        frequency
      FROM raw_idx
      ORDER BY "preleveurUserId", "exploitationId", "compteurId", date, "createdAt" DESC, id DESC
    ),
    calc AS (
      SELECT
        "chunkId",
        "preleveurUserId",
        "exploitationId", "compteurId",
        LAG(date) OVER (PARTITION BY "preleveurUserId", "exploitationId", "compteurId" ORDER BY date) AS "periodStart",
        date AS "periodEnd",
        CASE
          WHEN LAG(value) OVER (PARTITION BY "preleveurUserId", "exploitationId", "compteurId" ORDER BY date) IS NULL THEN NULL
          WHEN value - LAG(value) OVER (PARTITION BY "preleveurUserId", "exploitationId", "compteurId" ORDER BY date) >= 0
            THEN value - LAG(value) OVER (PARTITION BY "preleveurUserId", "exploitationId", "compteurId" ORDER BY date)
          ELSE value
        END AS volume,
        unit,
        frequency
      FROM dedup
    )
    SELECT "chunkId", "periodStart", "periodEnd", volume, unit, frequency
    FROM calc
    WHERE "periodStart" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM blocked b WHERE b."preleveurUserId" IS NOT DISTINCT FROM calc."preleveurUserId"
        AND b."exploitationId" IS NOT DISTINCT FROM calc."exploitationId" AND b."compteurId" = calc."compteurId"
        AND calc."periodStart" < b."blockedEnd" AND calc."periodEnd" > b."blockedStart")
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
export async function reconstructVolumesFromIndexInTransaction(tx, pointId, scope = {}) {
  await lockPointForReconstruction(tx, pointId)

  const chunks = await tx.chunk.findMany({
    where: {
      pointPrelevementId: pointId,
      ...(scope.exploitationId ? {exploitationId: scope.exploitationId} : {}),
      ...(scope.compteurIds?.length ? {compteurId: {in: scope.compteurIds}} : {}),
      instructionStatus: {in: NON_REJECTED_CHUNK_INSTRUCTION_STATUSES},
      source: {status: 'COMPLETED'}
    },
    select: {
      id: true,
      sourceId: true,
      calculationStrategy: true,
      autoCalculateVolumes: true,
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

  const reconstruction = await reconstructVolumesForChunks(chunks, tx, scope)
  const transactionResult = {
    pointId,
    sourceIds: [...new Set(chunks.map(chunk => chunk.sourceId))],
    ...reconstruction
  }
  await refreshVolumeMetadataForSourceIds(transactionResult.sourceIds, tx)

  const {sourceIds, ...result} = transactionResult
  return result
}

export async function reconstructVolumesFromIndexForPoint(pointId) {
  return prisma.$transaction(tx => reconstructVolumesFromIndexInTransaction(tx, pointId), RECONSTRUCTION_TRANSACTION_OPTIONS)
}
