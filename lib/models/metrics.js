import {prisma} from '../../db/prisma.js'

export function normalizeDateOnly(d) {
  const date = d instanceof Date ? d : new Date(d)

  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

/**
 * “Series list” = metadata par (point, metricTypeCode, meterId, unit).
 * Filtrable par points, declarant, source, dates, metricTypeCode.
 */
export async function listMetricSeries({
     pointIds,
     declarantUserId,
     sourceId,
     metricTypeCode,
     startDate,
     endDate
   }) {
  let effectivePointIds = pointIds

  if (declarantUserId && (!pointIds || pointIds.length === 0)) {
    const rows = await prisma.declarantPointPrelevement.findMany({
      where: {declarantUserId},
      select: {pointPrelevementId: true}
    })
    effectivePointIds = rows.map(r => r.pointPrelevementId)
  } else if (declarantUserId && pointIds?.length) {
    // filtrer les points demandés au sein de ceux du déclarant
    const rows = await prisma.declarantPointPrelevement.findMany({
      where: {declarantUserId, pointPrelevementId: {in: pointIds}},
      select: {pointPrelevementId: true}
    })
    effectivePointIds = rows.map(r => r.pointPrelevementId)
  }

  if ((!effectivePointIds || effectivePointIds.length === 0) && !sourceId) {
    return []
  }

  const where = {
    ...(effectivePointIds?.length ? {pointPrelevementId: {in: effectivePointIds}} : {}),
    ...(sourceId ? {sourceId} : {}),
    ...(metricTypeCode ? {metricTypeCode} : {}),
    ...(startDate || endDate
      ? {
        startDate: startDate ? {gte: normalizeDateOnly(startDate)} : undefined,
        endDate: endDate ? {lte: normalizeDateOnly(endDate)} : undefined
      }
      : {})
  }

  // GroupBy Prisma : on sort les “séries”
  const grouped = await prisma.metric.groupBy({
    by: ['pointPrelevementId', 'metricTypeCode', 'meterId', 'unit'],
    where,
    _min: {startDate: true},
    _max: {endDate: true},
    _count: {_all: true}
  })

  return grouped.map(g => ({
    id: `${g.pointPrelevementId}:${g.metricTypeCode}:${g.meterId || ''}`, // id “virtuel”
    pointPrelevementId: g.pointPrelevementId,
    metricTypeCode: g.metricTypeCode,
    meterId: g.meterId || null,
    unit: g.unit || null,
    minDate: g._min.startDate,
    maxDate: g._max.endDate,
    valuesCount: g._count._all
  }))
}

/**
 * Récupérer les “values” d’une série (donc des lignes Metric).
 * seriesKey = {pointPrelevementId, metricTypeCode, meterId?}
 */
export async function getMetricValuesInRange(seriesKey, {sourceId, startDate, endDate}) {
  const where = {
    pointPrelevementId: seriesKey.pointPrelevementId,
    metricTypeCode: seriesKey.metricTypeCode,
    ...(seriesKey.meterId ? {meterId: seriesKey.meterId} : {}),
    ...(sourceId ? {sourceId} : {}),
    ...(startDate ? {startDate: {gte: normalizeDateOnly(startDate)}} : {}),
    ...(endDate ? {endDate: {lte: normalizeDateOnly(endDate)}} : {})
  }

  return prisma.metric.findMany({
    where,
    orderBy: [{startDate: 'asc'}, {endDate: 'asc'}],
    select: {
      startDate: true,
      endDate: true,
      value: true,
      unit: true,
      sourceId: true,
      quality: true
    }
  })
}
