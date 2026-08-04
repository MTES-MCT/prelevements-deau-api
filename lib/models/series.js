import {prisma} from '../../db/prisma.js'
import {NON_REJECTED_CHUNK_INSTRUCTION_STATUSES} from '../constants/chunk-statuses.js'
import {
  getCompatibleMetricTypeCodes,
  inferFlowTypeFromLegacyMetricTypeCode,
  normalizeMetricTypeCode
} from '../constants/metric-type-codes.js'
import {parametersConfig} from '../parameters-config.js'

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000

function toYMD(date) {
  if (!date) {
    return null
  }

  return date.toISOString().slice(0, 10)
}

function toLastCoveredYMD(date) {
  if (!date) {
    return null
  }

  return toYMD(new Date(date.getTime() - 1))
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

function addUtcDays(date, days) {
  return new Date(date.getTime() + (days * DAY_IN_MILLISECONDS))
}

export function buildPeriodEndRangeFilter({startDate, endDate} = {}) {
  const filter = {}
  const normalizedStartDate = normalizeDateOnly(startDate)
  const normalizedEndDate = normalizeDateOnly(endDate)

  if (normalizedStartDate) {
    filter.gte = normalizedStartDate
  }

  if (normalizedEndDate) {
    filter.lt = addUtcDays(normalizedEndDate, 1)
  }

  return Object.keys(filter).length > 0 ? filter : null
}

/**
 * Construit une fenêtre semi-ouverte [startDate, endDate + 1 jour) et conserve
 * toute valeur dont la période [periodStart, periodEnd) la chevauche.
 */
export function buildPeriodOverlapFilter({startDate, endDate} = {}) {
  const filters = []
  const normalizedStartDate = normalizeDateOnly(startDate)
  const normalizedEndDate = normalizeDateOnly(endDate)

  if (normalizedStartDate) {
    filters.push({periodEnd: {gt: normalizedStartDate}})
  }

  if (normalizedEndDate) {
    filters.push({periodStart: {lt: addUtcDays(normalizedEndDate, 1)}})
  }

  return filters.length > 0 ? filters : null
}

function isCumulativeMetricTypeCode(metricTypeCode) {
  return parametersConfig[normalizeMetricTypeCode(metricTypeCode)]?.valueType === 'cumulative'
}

function buildMetricPeriodFilter({parameter, startDate, endDate, includeOverlappingPeriods}) {
  const periodEndFilter = buildPeriodEndRangeFilter({startDate, endDate})
  if (!periodEndFilter) {
    return null
  }

  if (includeOverlappingPeriods && parameter && isCumulativeMetricTypeCode(parameter)) {
    return {AND: buildPeriodOverlapFilter({startDate, endDate})}
  }

  return {periodEnd: periodEndFilter}
}

function getSeriesPeriodMetadata({useCoveredBounds, minPeriodStart, minPeriodEnd, maxPeriodEnd}) {
  if (useCoveredBounds) {
    return {
      minDate: toYMD(minPeriodStart),
      maxDate: toLastCoveredYMD(maxPeriodEnd)
    }
  }

  return {
    minDate: toYMD(minPeriodEnd),
    maxDate: toYMD(maxPeriodEnd)
  }
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

function getDeclarantActorName(declarant) {
  if (!declarant) {
    return null
  }

  if (declarant.socialReason) {
    return declarant.socialReason
  }

  const parts = [
    declarant.civility,
    declarant.user?.firstName,
    declarant.user?.lastName
  ].filter(Boolean)

  return parts.length > 0 ? parts.join(' ') : declarant.user?.email ?? null
}

function serializeDeclarantActor(declarant) {
  if (!declarant?.userId) {
    return null
  }

  return {
    id: declarant.userId,
    name: getDeclarantActorName(declarant),
    email: declarant.user?.email ?? null,
    firstName: declarant.user?.firstName ?? null,
    lastName: declarant.user?.lastName ?? null,
    socialReason: declarant.socialReason ?? null,
    declarantRole: declarant.declarantRole ?? null,
    declarantType: declarant.declarantType ?? null
  }
}

function buildSeriesActors(chunk) {
  const preleveur = serializeDeclarantActor(chunk?.preleveur)
  const submittedBy = serializeDeclarantActor(chunk?.submittedByDeclarant)
  const explicitCollecteur = serializeDeclarantActor(chunk?.collecteur)
  const fallbackCollecteur = submittedBy?.declarantRole === 'COLLECTEUR'
    && submittedBy.id !== preleveur?.id
    ? submittedBy
    : null

  return {
    preleveur,
    submittedBy,
    collecteur: explicitCollecteur ?? fallbackCollecteur
  }
}

const CHUNK_SERIES_SELECT = {
  id: true,
  sourceId: true,
  pointPrelevementId: true,
  pointPrelevementName: true,
  flowType: true,
  pointPrelevement: {
    select: {
      flowType: true
    }
  },
  preleveurUserId: true,
  submittedByDeclarantUserId: true,
  collecteurUserId: true,
  preleveur: {
    include: {
      user: true
    }
  },
  submittedByDeclarant: {
    include: {
      user: true
    }
  },
  collecteur: {
    include: {
      user: true
    }
  }
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
  flowType,
  startDate,
  endDate,
  includeOverlappingPeriods = false
} = {}) {
  const effectivePointIds = Array.isArray(pointIds) ? pointIds : undefined
  let fallbackPreleveurPointIds = []

  if (preleveurId) {
    const rows = await prisma.declarantPointPrelevement.findMany({
      where: {
        declarantUserId: preleveurId,
        ...(effectivePointIds?.length ? {pointPrelevementId: {in: effectivePointIds}} : {})
      },
      select: {pointPrelevementId: true}
    })

    fallbackPreleveurPointIds = rows.map(row => row.pointPrelevementId)
  }

  if ((!effectivePointIds || effectivePointIds.length === 0) && !sourceId && !preleveurId) {
    return []
  }

  const metricPeriodFilter = buildMetricPeriodFilter({
    parameter,
    startDate,
    endDate,
    includeOverlappingPeriods
  })
  const chunkWhere = {
    instructionStatus: {in: NON_REJECTED_CHUNK_INSTRUCTION_STATUSES},
    ...(sourceId ? {sourceId} : {}),
    ...(effectivePointIds?.length ? {pointPrelevementId: {in: effectivePointIds}} : {}),
    AND: [
      ...(flowType
        ? [{
          OR: [
            {flowType},
            {flowType: null, pointPrelevement: {flowType}}
          ]
        }]
        : []),
      ...(preleveurId
        ? [{
          OR: [
            {preleveurUserId: preleveurId},
            ...(fallbackPreleveurPointIds.length > 0
              ? [{
                preleveurUserId: null,
                pointPrelevementId: {in: fallbackPreleveurPointIds}
              }]
              : [])
          ]
        }]
        : [])
    ],
    source: {
      status: 'COMPLETED'
    }
  }

  const where = {
    ...(parameter ? {metricTypeCode: {in: getCompatibleMetricTypeCodes(parameter)}} : {}),
    ...metricPeriodFilter,
    chunk: chunkWhere
  }

  const grouped = await prisma.chunkValue.groupBy({
    by: ['chunkId', 'metricTypeCode', 'unit', 'frequency'],
    where,
    _min: {periodStart: true, periodEnd: true},
    _max: {periodEnd: true},
    _count: {_all: true}
  })

  if (grouped.length === 0) {
    return []
  }

  const chunkIds = [...new Set(grouped.map(group => group.chunkId))]
  const chunks = await prisma.chunk.findMany({
    where: {id: {in: chunkIds}},
    select: CHUNK_SERIES_SELECT
  })

  const chunkById = new Map(chunks.map(chunk => [chunk.id, chunk]))

  return grouped.map(group => {
    const chunk = chunkById.get(group.chunkId)
    const actors = buildSeriesActors(chunk)

    const normalizedMetricTypeCode = normalizeMetricTypeCode(group.metricTypeCode)
    const useCoveredBounds = includeOverlappingPeriods
      && isCumulativeMetricTypeCode(normalizedMetricTypeCode)
    const periodMetadata = getSeriesPeriodMetadata({
      useCoveredBounds,
      minPeriodStart: group._min.periodStart,
      minPeriodEnd: group._min.periodEnd,
      maxPeriodEnd: group._max.periodEnd
    })

    return {
      id: encodeSeriesId({
        chunkId: group.chunkId,
        metricTypeCode: normalizedMetricTypeCode
      }),
      parameter: normalizedMetricTypeCode,
      flowType: chunk?.flowType
        ?? chunk?.pointPrelevement?.flowType
        ?? inferFlowTypeFromLegacyMetricTypeCode(group.metricTypeCode),
      unit: group.unit || null,
      frequency: group.frequency || '1 day',
      valueType: 'cumulative',
      originalFrequency: null,
      minDate: periodMetadata.minDate,
      maxDate: periodMetadata.maxDate,
      hasSubDaily: false,
      pointPrelevement: chunk?.pointPrelevementId || null,
      extras: null,
      computed: {
        chunkId: group.chunkId,
        sourceId: chunk?.sourceId || null,
        point: chunk?.pointPrelevementId || null,
        pointName: chunk?.pointPrelevementName || null,
        preleveur: actors.preleveur?.id ?? preleveurId ?? null
      },
      actors,
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

  const chunk = await prisma.chunk.findFirst({
    where: {
      id: key.chunkId,
      instructionStatus: {in: NON_REJECTED_CHUNK_INSTRUCTION_STATUSES},
      source: {
        status: 'COMPLETED'
      }
    },
    select: CHUNK_SERIES_SELECT
  })

  if (!chunk) {
    return null
  }

  const aggregate = await prisma.chunkValue.aggregate({
    where: {
      chunkId: key.chunkId,
      metricTypeCode: {in: getCompatibleMetricTypeCodes(key.metricTypeCode)}
    },
    _min: {periodEnd: true},
    _max: {periodEnd: true}
  })

  if (!aggregate._min.periodEnd || !aggregate._max.periodEnd) {
    return null
  }

  const first = await prisma.chunkValue.findFirst({
    where: {
      chunkId: key.chunkId,
      metricTypeCode: {in: getCompatibleMetricTypeCodes(key.metricTypeCode)}
    },
    orderBy: {periodEnd: 'asc'},
    select: {unit: true, frequency: true}
  })

  const actors = buildSeriesActors(chunk)

  return {
    id: seriesId,
    parameter: key.metricTypeCode,
    flowType: chunk.flowType
      ?? chunk.pointPrelevement?.flowType
      ?? inferFlowTypeFromLegacyMetricTypeCode(key.metricTypeCode),
    unit: first?.unit || null,
    frequency: first?.frequency || '1 day',
    valueType: 'cumulative',
    originalFrequency: null,
    minDate: toYMD(aggregate._min.periodEnd),
    maxDate: toYMD(aggregate._max.periodEnd),
    hasSubDaily: false,
    pointPrelevement: chunk.pointPrelevementId || null,
    extras: null,
    computed: {
      chunkId: chunk.id,
      sourceId: chunk.sourceId,
      point: chunk.pointPrelevementId || null,
      pointName: chunk.pointPrelevementName || null
    },
    actors
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

  const periodEndFilter = buildPeriodEndRangeFilter({startDate, endDate})

  const where = {
    chunkId: key.chunkId,
    metricTypeCode: {in: getCompatibleMetricTypeCodes(key.metricTypeCode)},
    ...(periodEndFilter ? {periodEnd: periodEndFilter} : {}),
    chunk: {
      instructionStatus: {in: NON_REJECTED_CHUNK_INSTRUCTION_STATUSES},
      source: {
        status: 'COMPLETED'
      }
    }
  }

  const rows = await prisma.chunkValue.findMany({
    where,
    orderBy: [
      {periodEnd: 'asc'},
      {createdAt: 'asc'},
      {id: 'asc'}
    ],
    select: {
      id: true,
      periodEnd: true,
      value: true,
      createdAt: true
    }
  })

  return rows.map(row => ({
    id: row.id,
    date: toYMD(row.periodEnd),
    createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
    values: {
      value: decimalToNumber(row.value)
    }
  }))
}
