import {prisma} from '../../db/prisma.js'

function toYMD(date) {
  if (!date) {
    return null
  }

  return date.toISOString().slice(0, 10)
}

function normalizeDateOnly(input) {
  if (!input) {
    return null
  }

  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) {
    return null
  }

  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function decimalToNumber(value) {
  if (value === null || value === undefined) {
    return null
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

/**
 * Series = chunkId + metricTypeCode
 */
export function encodeSeriesId({chunkId, metricTypeCode}) {
  return `${chunkId}:${metricTypeCode}`
}

export function decodeSeriesId(seriesId) {
  if (!seriesId || typeof seriesId !== 'string') {
    return null
  }

  const [chunkId, metricTypeCode] = seriesId.split(':')
  if (!chunkId || !metricTypeCode) {
    return null
  }

  return {chunkId, metricTypeCode}
}

/**
 * ListSeries
 */
export async function listSeries({
  sourceId,
  pointIds,
  preleveurId,
  parameter,
  startDate,
  endDate
} = {}) {
  let effectivePointIds = Array.isArray(pointIds) ? pointIds : undefined

  // Resolve points via declarant
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

  if ((!effectivePointIds || effectivePointIds.length === 0) && !sourceId) {
    return []
  }

  const where = {
    ...(parameter ? {metricTypeCode: parameter} : {}),
    ...(startDate ? {date: {gte: normalizeDateOnly(startDate)}} : {}),
    ...(endDate ? {date: {lte: normalizeDateOnly(endDate)}} : {}),
    chunk: {
      ...(sourceId ? {sourceId} : {}),
      ...(effectivePointIds?.length ? {pointPrelevementId: {in: effectivePointIds}} : {})
    }
  }

  const grouped = await prisma.chunkValue.groupBy({
    by: ['chunkId', 'metricTypeCode', 'unit', 'frequency'],
    where,
    _min: {date: true},
    _max: {date: true},
    _count: {_all: true}
  })

  if (grouped.length === 0) {
    return []
  }

  const chunkIds = [...new Set(grouped.map(g => g.chunkId))]
  const chunks = await prisma.chunk.findMany({
    where: {id: {in: chunkIds}},
    select: {
      id: true,
      sourceId: true,
      pointPrelevementId: true,
      pointPrelevementName: true
    }
  })

  const chunkById = new Map(chunks.map(c => [c.id, c]))

  return grouped.map(g => {
    const chunk = chunkById.get(g.chunkId)

    return {
      id: encodeSeriesId({
        chunkId: g.chunkId,
        metricTypeCode: g.metricTypeCode
      }),

      parameter: g.metricTypeCode,
      unit: g.unit || null,
      frequency: g.frequency || '1 day',
      valueType: 'cumulative',
      originalFrequency: null,

      minDate: toYMD(g._min.date),
      maxDate: toYMD(g._max.date),

      hasSubDaily: false,
      pointPrelevement: chunk?.pointPrelevementId || null,
      extras: null,

      computed: {
        chunkId: g.chunkId,
        sourceId: chunk?.sourceId || null,
        point: chunk?.pointPrelevementId || null,
        pointName: chunk?.pointPrelevementName || null,
        preleveur: preleveurId || null
      },

      numberOfValues: g._count._all
    }
  })
}

/**
 * GetSeriesById
 */
export async function getSeriesById(seriesId) {
  const key = decodeSeriesId(seriesId)
  if (!key) {
    return null
  }

  const chunk = await prisma.chunk.findUnique({
    where: {id: key.chunkId},
    select: {
      id: true,
      sourceId: true,
      pointPrelevementId: true,
      pointPrelevementName: true
    }
  })

  if (!chunk) {
    return null
  }

  const agg = await prisma.chunkValue.aggregate({
    where: {
      chunkId: key.chunkId,
      metricTypeCode: key.metricTypeCode
    },
    _min: {date: true},
    _max: {date: true}
  })

  if (!agg._min.date || !agg._max.date) {
    return null
  }

  const first = await prisma.chunkValue.findFirst({
    where: {
      chunkId: key.chunkId,
      metricTypeCode: key.metricTypeCode
    },
    orderBy: {date: 'asc'},
    select: {unit: true, frequency: true}
  })

  return {
    id: seriesId,
    parameter: key.metricTypeCode,
    unit: first?.unit || null,
    frequency: first?.frequency || '1 day',
    valueType: 'cumulative',
    originalFrequency: null,
    minDate: toYMD(agg._min.date),
    maxDate: toYMD(agg._max.date),
    hasSubDaily: false,
    pointPrelevement: chunk.pointPrelevementId || null,
    extras: null,
    computed: {
      chunkId: chunk.id,
      sourceId: chunk.sourceId,
      point: chunk.pointPrelevementId || null,
      pointName: chunk.pointPrelevementName || null
    }
  }
}

/**
 * GetSeriesValuesInRange
 */
export async function getSeriesValuesInRange(seriesId, {startDate, endDate} = {}) {
  const key = decodeSeriesId(seriesId)
  if (!key) {
    return []
  }

  const where = {
    chunkId: key.chunkId,
    metricTypeCode: key.metricTypeCode,
    ...(startDate ? {date: {gte: normalizeDateOnly(startDate)}} : {}),
    ...(endDate ? {date: {lte: normalizeDateOnly(endDate)}} : {})
  }

  const rows = await prisma.chunkValue.findMany({
    where,
    orderBy: {date: 'asc'},
    select: {date: true, value: true}
  })

  return rows.map(r => ({
    date: toYMD(r.date),
    values: {
      value: decimalToNumber(r.value)
    }
  }))
}
