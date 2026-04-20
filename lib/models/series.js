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

  const separatorIndex = seriesId.indexOf(':')
  if (separatorIndex === -1) {
    return null
  }

  const chunkId = seriesId.slice(0, separatorIndex)
  const metricTypeCode = seriesId.slice(separatorIndex + 1)

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

  if (preleveurId) {
    const rows = await prisma.declarantPointPrelevement.findMany({
      where: {
        declarantUserId: preleveurId,
        ...(effectivePointIds?.length ? {pointPrelevementId: {in: effectivePointIds}} : {})
      },
      select: {pointPrelevementId: true}
    })

    effectivePointIds = rows.map(row => row.pointPrelevementId)
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

  const chunkIds = [...new Set(grouped.map(group => group.chunkId))]
  const chunks = await prisma.chunk.findMany({
    where: {id: {in: chunkIds}},
    select: {
      id: true,
      sourceId: true,
      pointPrelevementId: true,
      pointPrelevementName: true
    }
  })

  const chunkById = new Map(chunks.map(chunk => [chunk.id, chunk]))

  return grouped.map(group => {
    const chunk = chunkById.get(group.chunkId)

    return {
      id: encodeSeriesId({
        chunkId: group.chunkId,
        metricTypeCode: group.metricTypeCode
      }),
      parameter: group.metricTypeCode,
      unit: group.unit || null,
      frequency: group.frequency || '1 day',
      valueType: 'cumulative',
      originalFrequency: null,
      minDate: toYMD(group._min.date),
      maxDate: toYMD(group._max.date),
      hasSubDaily: false,
      pointPrelevement: chunk?.pointPrelevementId || null,
      extras: null,
      computed: {
        chunkId: group.chunkId,
        sourceId: chunk?.sourceId || null,
        point: chunk?.pointPrelevementId || null,
        pointName: chunk?.pointPrelevementName || null,
        preleveur: preleveurId || null
      },
      numberOfValues: group._count._all
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

  const aggregate = await prisma.chunkValue.aggregate({
    where: {
      chunkId: key.chunkId,
      metricTypeCode: key.metricTypeCode
    },
    _min: {date: true},
    _max: {date: true}
  })

  if (!aggregate._min.date || !aggregate._max.date) {
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
    minDate: toYMD(aggregate._min.date),
    maxDate: toYMD(aggregate._max.date),
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

  return rows.map(row => ({
    date: toYMD(row.date),
    values: {
      value: decimalToNumber(row.value)
    }
  }))
}
