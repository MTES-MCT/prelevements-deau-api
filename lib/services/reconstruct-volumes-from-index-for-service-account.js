import {randomUUID} from 'node:crypto'
import {prisma} from '../../db/prisma.js'
import {listActiveDeclarantsForServiceAccount} from '../models/service-account-declarant.js'

/** Séries d’index telles qu’ingérées par l’API déclaration ou le connecteur compte de service. */
export const INDEX_METRIC_TYPE_CODES = ['relevé d\'index', 'index']

export const VOLUME_PRELEVE_METRIC_CODE = 'volume prélevé'

/**
 * À partir de relevés d’index triables par date, produit des volumes (écart entre relevés consécutifs).
 * Même logique métier que le parseur Aquasys : dédoublonnage par date (max), remise à zéro si Δ &lt; 0.
 *
 * @param {Array<{ date: Date, value: number }>} readings
 * @param {number} [coefficient]
 * @returns {Array<{ periodStart: Date, periodEnd: Date, value: number }>}
 */
export function computeVolumeRowsFromIndexReadings(readings, coefficient = 1) {
  const byDateMs = new Map()

  for (const row of readings) {
    if (row.value === null || row.value === undefined) {
      continue
    }

    const num = Number(row.value)
    if (!Number.isFinite(num)) {
      continue
    }

    const t = row.date.getTime()
    if (Number.isNaN(t)) {
      continue
    }

    const existing = byDateMs.get(t)
    if (!existing || num > existing.value) {
      byDateMs.set(t, {date: row.date, value: num})
    }
  }

  const uniqueRows = [...byDateMs.values()].sort((a, b) => a.date.getTime() - b.date.getTime())
  const coef = Number.isFinite(coefficient) ? coefficient : 1
  const out = []

  for (let i = 1; i < uniqueRows.length; i++) {
    const prev = uniqueRows[i - 1]
    const curr = uniqueRows[i]
    const diff = curr.value - prev.value
    const volume = diff >= 0 ? diff * coef : curr.value * coef

    if (!Number.isFinite(volume)) {
      continue
    }

    out.push({
      periodStart: prev.date,
      periodEnd: curr.date,
      value: volume
    })
  }

  return out
}

function isIndexMetricCode(code) {
  return INDEX_METRIC_TYPE_CODES.includes(code)
}

/**
 * Supprime les volumes calculés existants, recalcule à partir des index déclarés, insère les nouveaux volumes calculés.
 *
 * @param {string} chunkId
 * @param {Array<{ metricTypeCode: string, valueKind: string, date: Date, value: unknown, unit: string | null, frequency: string }>} chunkValues
 */
export async function reconstructComputedVolumesForChunk(chunkId, chunkValues) {
  const declared = chunkValues.filter(v => v.valueKind === 'DECLARED')
  const declaredMetricCodes = [...new Set(declared.map(v => v.metricTypeCode))]

  const hasDeclaredVolume = declared.some(v => v.metricTypeCode === VOLUME_PRELEVE_METRIC_CODE)
  if (hasDeclaredVolume) {
    return {skipped: true, reason: 'DECLARED_VOLUME_PRESENT', created: 0}
  }

  const onlyIndexDeclared
    = declaredMetricCodes.length > 0 && declaredMetricCodes.every(isIndexMetricCode)
  if (!onlyIndexDeclared) {
    return {skipped: true, reason: 'NOT_INDEX_ONLY_DECLARED', created: 0}
  }

  const indexRows = declared
    .filter(v => isIndexMetricCode(v.metricTypeCode))
    .map(v => ({
      date: v.date,
      value: typeof v.value === 'number' ? v.value : Number(v.value)
    }))

  const volumeRows = computeVolumeRowsFromIndexReadings(indexRows, 1)
  if (volumeRows.length === 0) {
    await prisma.chunkValue.deleteMany({
      where: {
        chunkId,
        metricTypeCode: VOLUME_PRELEVE_METRIC_CODE,
        valueKind: 'COMPUTED'
      }
    })
    return {skipped: false, reason: 'NO_INTERVALS', created: 0}
  }

  const template = declared[0]

  await prisma.$transaction([
    prisma.chunkValue.deleteMany({
      where: {
        chunkId,
        metricTypeCode: VOLUME_PRELEVE_METRIC_CODE,
        valueKind: 'COMPUTED'
      }
    }),
    prisma.chunkValue.createMany({
      data: volumeRows.map(row => ({
        id: randomUUID(),
        chunkId,
        metricTypeCode: VOLUME_PRELEVE_METRIC_CODE,
        unit: template.unit ?? 'm³',
        // Volumes dérivés d’index : une valeur par intervalle entre relevés → maille journalière côté produit.
        frequency: '1 day',
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        date: row.periodEnd,
        valueKind: 'COMPUTED',
        value: row.value
      }))
    })
  ])

  return {skipped: false, reason: null, created: volumeRows.length}
}

/**
 * Reconstruit les volumes à partir des index pour tous les chunks des points liés aux déclarants
 * actifs rattachés au compte de service.
 *
 * @param {string} serviceAccountId
 * @param {object} [options]
 * @param {Date} [options.now]
 * @returns {Promise<{ declarants: number, points: number, chunksConsidered: number, chunksUpdated: number, volumesCreated: number, details: Array<{ chunkId: string, created: number, skipped?: boolean, reason?: string }> }>}
 */
export async function reconstructVolumesFromIndexForServiceAccount(serviceAccountId, options = {}) {
  const now = options.now ?? new Date()

  const links = await listActiveDeclarantsForServiceAccount(serviceAccountId, now)
  const declarantUserIds = [...new Set(links.map(l => l.declarantUserId))]

  if (declarantUserIds.length === 0) {
    return {
      declarants: 0,
      points: 0,
      chunksConsidered: 0,
      chunksUpdated: 0,
      volumesCreated: 0,
      details: []
    }
  }

  const pointLinks = await prisma.declarantPointPrelevement.findMany({
    where: {declarantUserId: {in: declarantUserIds}},
    select: {pointPrelevementId: true}
  })
  const pointIds = [...new Set(pointLinks.map(p => p.pointPrelevementId))]

  if (pointIds.length === 0) {
    return {
      declarants: declarantUserIds.length,
      points: 0,
      chunksConsidered: 0,
      chunksUpdated: 0,
      volumesCreated: 0,
      details: []
    }
  }

  const chunks = await prisma.chunk.findMany({
    where: {
      pointPrelevementId: {in: pointIds},
      source: {status: 'COMPLETED'}
    },
    select: {
      id: true,
      chunkValues: {
        select: {
          metricTypeCode: true,
          valueKind: true,
          date: true,
          value: true,
          unit: true,
          frequency: true
        }
      }
    }
  })

  const details = []
  let chunksUpdated = 0
  let volumesCreated = 0

  for (const chunk of chunks) {
    // eslint-disable-next-line no-await-in-loop
    const result = await reconstructComputedVolumesForChunk(chunk.id, chunk.chunkValues)
    details.push({
      chunkId: chunk.id,
      created: result.created,
      skipped: result.skipped,
      reason: result.reason
    })
    if (!result.skipped) {
      chunksUpdated++
      volumesCreated += result.created
    }
  }

  return {
    declarants: declarantUserIds.length,
    points: pointIds.length,
    chunksConsidered: chunks.length,
    chunksUpdated,
    volumesCreated,
    details
  }
}
