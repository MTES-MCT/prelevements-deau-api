import {prisma} from '../../db/prisma.js'

/**
 * Convertit Date -> 'YYYY-MM-DD' (date-only)
 */
function toYMD(date) {
  if (!date) return null
  return date.toISOString().slice(0, 10)
}

function normalizeDateOnly(input) {
  const d = input instanceof Date ? input : new Date(input)
  // clamp to UTC date
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function decimalToNumber(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value)

  // Prisma Decimal (decimal.js)
  if (typeof value === 'object' && typeof value.toNumber === 'function') {
    return value.toNumber()
  }

  return Number(value)
}

/**
 * On encode une "seriesId" virtuelle :
 *   seriesId = `${pointPrelevementId}:${metricTypeCode}:${meterId||''}:${sourceId||''}`
 *
 * - sourceId est inclus si tu listes des séries "par source", sinon vide
 * - meterId peut être vide
 */
export function encodeSeriesId({pointPrelevementId, metricTypeCode, meterId, sourceId}) {
  return [
    pointPrelevementId,
    metricTypeCode,
    meterId || '',
    sourceId || ''
  ].join(':')
}

export function decodeSeriesId(seriesId) {
  if (!seriesId || typeof seriesId !== 'string') return null
  const parts = seriesId.split(':')
  if (parts.length < 2) {
    return null
  }

  const [pointPrelevementId, metricTypeCode, meterId = '', sourceId = ''] = parts
  if (!pointPrelevementId || !metricTypeCode) return null

  return {
    pointPrelevementId,
    metricTypeCode,
    meterId: meterId || null,
    sourceId: sourceId || null
  }
}

/**
 * listSeries (Prisma)
 * Remplace la liste des "Series" Mongo par des séries virtuelles groupées depuis Metric.
 *
 * API compatible (mêmes options) mais :
 * - attachmentId n'existe plus (utilise sourceId via "preleveurId" / "pointIds" côté appelant)
 * - onlyIntegratedDays ignoré (on filtre sur startDate/endDate des Metric)
 * - includeExtras ignoré
 */
export async function listSeries({
                                   // new world:
                                   sourceId,
                                   pointIds,
                                   preleveurId, // declarantUserId
                                   parameter, // metricTypeCode
                                   startDate,
                                   endDate,
                                   onlyIntegratedDays = false, // ignored
                                   includeExtras = false // ignored
                                 } = {}) {
  let effectivePointIds = Array.isArray(pointIds) ? pointIds : undefined

  // preleveurId = declarantUserId => resolve points via pivot
  if (preleveurId) {
    const rows = await prisma.declarantPointPrelevement.findMany({
      where: {
        declarantUserId: preleveurId,
        ...(effectivePointIds?.length ? {pointPrelevementId: {in: effectivePointIds}} : {})
      },
      select: {pointPrelevementId: true}
    })
    effectivePointIds = rows.map(r => r.pointPrelevementId)
  }

  // Sécurité : si aucun filtre exploitable => []
  if ((!effectivePointIds || effectivePointIds.length === 0) && !sourceId) {
    return []
  }

  const where = {
    ...(effectivePointIds?.length ? {pointPrelevementId: {in: effectivePointIds}} : {}),
    ...(sourceId ? {sourceId} : {}),
    ...(parameter ? {metricTypeCode: parameter} : {}),
    ...(startDate ? {startDate: {gte: normalizeDateOnly(startDate)}} : {}),
    ...(endDate ? {endDate: {lte: normalizeDateOnly(endDate)}} : {})
  }

  const grouped = await prisma.metric.groupBy({
    by: ['pointPrelevementId', 'metricTypeCode', 'meterId', 'unit', 'sourceId'],
    where,
    _min: {startDate: true},
    _max: {endDate: true},
    _count: {_all: true}
  })

  // Shape proche de l'ancien "Series"
  return grouped.map(g => ({
    id: encodeSeriesId({
      pointPrelevementId: g.pointPrelevementId,
      metricTypeCode: g.metricTypeCode,
      meterId: g.meterId,
      sourceId: g.sourceId
    }),

    // "parameter" = metricTypeCode
    parameter: g.metricTypeCode,
    unit: g.unit || null,

    // on est daily-only dans ce modèle
    frequency: '1 day',
    valueType: 'cumulative', // si tu as une vraie table de types, tu peux mapper autrement
    originalFrequency: null,

    minDate: toYMD(g._min.startDate),
    maxDate: toYMD(g._max.endDate),

    // pour compat éventuelle
    hasSubDaily: false,
    pointPrelevement: null,
    extras: null,

    computed: {
      point: g.pointPrelevementId,
      preleveur: preleveurId || null,
      sourceId: g.sourceId
    },

    numberOfValues: g._count._all
  }))
}

export async function getSeriesById(seriesId) {
  const key = decodeSeriesId(seriesId)
  if (!key) return null

  // On reconstruit des métadonnées depuis Metric
  const where = {
    pointPrelevementId: key.pointPrelevementId,
    metricTypeCode: key.metricTypeCode,
    ...(key.meterId ? {meterId: key.meterId} : {}),
    ...(key.sourceId ? {sourceId: key.sourceId} : {})
  }

  const agg = await prisma.metric.aggregate({
    where,
    _min: {startDate: true},
    _max: {endDate: true}
  })

  // Si aucune métrique => série inexistante
  if (!agg._min.startDate || !agg._max.endDate) {
    return null
  }

  // Reprend le shape listSeries
  const first = await prisma.metric.findFirst({
    where,
    select: {unit: true, sourceId: true},
    orderBy: {startDate: 'asc'}
  })

  return {
    id: seriesId,
    parameter: key.metricTypeCode,
    unit: first?.unit || null,
    frequency: '1 day',
    valueType: 'cumulative',
    originalFrequency: null,
    minDate: toYMD(agg._min.startDate),
    maxDate: toYMD(agg._max.endDate),
    hasSubDaily: false,
    pointPrelevement: key.pointPrelevementId,
    extras: null,
    computed: {
      point: key.pointPrelevementId,
      sourceId: first?.sourceId || key.sourceId || null
    }
  }
}

/**
 * getSeriesValuesInRange (Prisma)
 * Retourne des "valueDocs" compatibles avec l'ancien extractor :
 *   [{date:'YYYY-MM-DD', values:{value:number, remark?}}]
 */
export async function getSeriesValuesInRange(seriesId, {startDate, endDate, useAggregates = false} = {}) {
  const key = typeof seriesId === 'string' ? decodeSeriesId(seriesId) : null
  if (!key) return []

  const where = {
    pointPrelevementId: key.pointPrelevementId,
    metricTypeCode: key.metricTypeCode,
    ...(key.meterId ? {meterId: key.meterId} : {}),
    ...(key.sourceId ? {sourceId: key.sourceId} : {}),
    ...(startDate ? {startDate: {gte: normalizeDateOnly(startDate)}} : {}),
    ...(endDate ? {endDate: {lte: normalizeDateOnly(endDate)}} : {})
  }

  const rows = await prisma.metric.findMany({
    where,
    orderBy: [{startDate: 'asc'}, {endDate: 'asc'}],
    select: {
      startDate: true,
      value: true,
      quality: true
    }
  })

  // daily-only => useAggregates ignoré
  return rows.map(r => ({
    date: toYMD(r.startDate),
    values: {
      value: decimalToNumber(r.value),
      ...(r.quality ? {remark: `quality:${r.quality}`} : {})
    }
  }))
}
