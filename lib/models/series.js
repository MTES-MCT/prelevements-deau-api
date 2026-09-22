import {prisma} from '../../db/prisma.js'
import {NON_REJECTED_CHUNK_INSTRUCTION_STATUSES} from '../constants/chunk-statuses.js'
import {
  getCompatibleMetricTypeCodes,
  inferFlowTypeFromLegacyMetricTypeCode,
  normalizeMetricTypeCode
} from '../constants/metric-type-codes.js'
import {parametersConfig} from '../parameters-config.js'
import {getVisibleTelemetryChunksWhere} from '../services/telemetry-source-access.js'
import {meterBusinessDateBoundary} from '../services/meter-core.js'

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

  if (!parameter || isCumulativeMetricTypeCode(parameter)) {
    const exactMeter = {frequency: 'irregular', chunk: {calculationStrategy: 'METER'}}
    const legacy = includeOverlappingPeriods && parameter
      ? {AND: buildPeriodOverlapFilter({startDate, endDate})}
      : {periodEnd: periodEndFilter}
    return {OR: [
      {...exactMeter,
        ...(startDate ? {periodEnd: {gt: meterBusinessDateBoundary(startDate)}} : {}),
        ...(endDate ? {periodStart: {lt: meterBusinessDateBoundary(endDate, true)}} : {})},
      {NOT: exactMeter, ...legacy}
    ]}
  }

  return {periodEnd: periodEndFilter}
}

const parisDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'})

function getSeriesPeriodMetadata({useCoveredBounds, exactMeter, minPeriodStart, minPeriodEnd, maxPeriodEnd}) {
  if (exactMeter) return {
    minDate: minPeriodStart ? parisDate.format(minPeriodStart) : null,
    maxDate: maxPeriodEnd ? parisDate.format(new Date(maxPeriodEnd.getTime() - 1)) : null
  }
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
  exploitationId: true,
  exploitation: {select: {countingCode: true}},
  sourceId: true,
  pointPrelevementId: true,
  pointPrelevementName: true,
  flowType: true,
  compteurId: true,
  calculationStrategy: true,
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

// Authentication scope and requested filters intersect. A point association
// alone must not expose another beneficiary's allocated meter volume.
// Ordinary series deliberately keep their existing point-level contract.
export function getMeterSeriesChunkScope({user, pointIds, preleveurId, collecteurId} = {}) {
  return [
    ...(user ? [getVisibleTelemetryChunksWhere({user, pointIds})] : []),
    ...(preleveurId ? [{OR: [{calculationStrategy: {not: 'METER'}}, {calculationStrategy: 'METER', preleveurUserId: preleveurId}]}] : []),
    ...(collecteurId ? [{OR: [{calculationStrategy: {not: 'METER'}}, {calculationStrategy: 'METER',
      chunkValues: {some: {meterContributions: {some: {allocationVersion: {allocation: {exploitation: {
        collecteurs: {some: {collecteurUserId: collecteurId}}
      }}}}}}}
    }]}] : [])
  ]
}

/**
 * ListSeries
 */
export async function listSeries({
  sourceId,
  exploitationId,
  pointIds,
  meterPointIds = pointIds,
  preleveurId,
  collecteurId,
  user,
  parameter,
  flowType,
  startDate,
  endDate,
  includeOverlappingPeriods = false
} = {}, {client = prisma} = {}) {
  const effectivePointIds = Array.isArray(pointIds) ? pointIds : undefined
  let fallbackPreleveurPointIds = []

  if (preleveurId) {
    const rows = await client.declarantPointPrelevement.findMany({
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
    ...(exploitationId ? {exploitationId} : {}),
    ...(effectivePointIds?.length ? {pointPrelevementId: {in: effectivePointIds}} : {}),
    AND: [
      ...getMeterSeriesChunkScope({user, pointIds: meterPointIds, preleveurId, collecteurId}),
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

  const grouped = await client.chunkValue.groupBy({
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
  const chunks = await client.chunk.findMany({
    where: {id: {in: chunkIds}},
    select: CHUNK_SERIES_SELECT
  })

  const chunkById = new Map(chunks.map(chunk => [chunk.id, chunk]))

  return grouped.map(group => {
    const chunk = chunkById.get(group.chunkId)
    const actors = buildSeriesActors(chunk)

    const normalizedMetricTypeCode = normalizeMetricTypeCode(group.metricTypeCode)
    const useCoveredBounds = (includeOverlappingPeriods || chunk?.calculationStrategy === 'METER')
      && isCumulativeMetricTypeCode(normalizedMetricTypeCode)
    const periodMetadata = getSeriesPeriodMetadata({
      useCoveredBounds,
      exactMeter: chunk?.calculationStrategy === 'METER' && group.frequency === 'irregular',
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
      ...(chunk?.compteurId ? {compteurId: chunk.compteurId} : {}),
      ...(chunk?.calculationStrategy === 'METER' ? {calculationStrategy: 'METER'} : {}),
      valueType: 'cumulative',
      originalFrequency: null,
      minDate: periodMetadata.minDate,
      maxDate: periodMetadata.maxDate,
      hasSubDaily: false,
      pointPrelevement: chunk?.pointPrelevementId || null,
      exploitationId: chunk?.exploitationId ?? null,
      countingCode: chunk?.exploitation?.countingCode ?? null,
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
export async function getSeriesById(seriesId, client = prisma) {
  const key = decodeSeriesId(seriesId)
  if (!key) {
    return null
  }

  const chunk = await client.chunk.findFirst({
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

  const aggregate = await client.chunkValue.aggregate({
    where: {
      chunkId: key.chunkId,
      metricTypeCode: {in: getCompatibleMetricTypeCodes(key.metricTypeCode)}
    },
    _min: {periodStart: true, periodEnd: true},
    _max: {periodEnd: true}
  })

  if (!aggregate._min.periodEnd || !aggregate._max.periodEnd) {
    return null
  }

  const first = await client.chunkValue.findFirst({
    where: {
      chunkId: key.chunkId,
      metricTypeCode: {in: getCompatibleMetricTypeCodes(key.metricTypeCode)}
    },
    orderBy: {periodEnd: 'asc'},
    select: {unit: true, frequency: true}
  })

  const actors = buildSeriesActors(chunk)
  const periodMetadata = getSeriesPeriodMetadata({
    useCoveredBounds: chunk.calculationStrategy === 'METER' && isCumulativeMetricTypeCode(key.metricTypeCode),
    exactMeter: chunk.calculationStrategy === 'METER' && first?.frequency === 'irregular',
    minPeriodStart: aggregate._min.periodStart,
    minPeriodEnd: aggregate._min.periodEnd,
    maxPeriodEnd: aggregate._max.periodEnd
  })

  return {
    id: seriesId,
    parameter: key.metricTypeCode,
    flowType: chunk.flowType
      ?? chunk.pointPrelevement?.flowType
      ?? inferFlowTypeFromLegacyMetricTypeCode(key.metricTypeCode),
    unit: first?.unit || null,
    frequency: first?.frequency || '1 day',
    ...(chunk.compteurId ? {compteurId: chunk.compteurId} : {}),
    ...(chunk.calculationStrategy === 'METER' ? {calculationStrategy: 'METER'} : {}),
    valueType: 'cumulative',
    originalFrequency: null,
    minDate: periodMetadata.minDate,
    maxDate: periodMetadata.maxDate,
    hasSubDaily: false,
    pointPrelevement: chunk.pointPrelevementId || null,
    exploitationId: chunk.exploitationId ?? null,
    countingCode: chunk.exploitation?.countingCode ?? null,
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
export async function getSeriesValuesInRange(seriesId, {startDate, endDate} = {}, client = prisma) {
  const key = decodeSeriesId(seriesId)
  if (!key) {
    return []
  }

  const periodFilter = buildMetricPeriodFilter({parameter: key.metricTypeCode, startDate, endDate})

  const where = {
    chunkId: key.chunkId,
    metricTypeCode: {in: getCompatibleMetricTypeCodes(key.metricTypeCode)},
    ...periodFilter,
    chunk: {
      instructionStatus: {in: NON_REJECTED_CHUNK_INSTRUCTION_STATUSES},
      source: {
        status: 'COMPLETED'
      }
    }
  }

  const rows = await client.chunkValue.findMany({
    where,
    orderBy: [
      {periodEnd: 'asc'},
      {createdAt: 'asc'},
      {id: 'asc'}
    ],
    select: {
      id: true,
      periodStart: true,
      periodEnd: true,
      frequency: true,
      value: true,
      createdAt: true,
      chunk: {select: {calculationStrategy: true, compteurId: true}}
    }
  })

  return rows.map(row => ({
    id: row.id,
    date: row.chunk?.calculationStrategy === 'METER' && row.frequency === 'irregular'
      ? parisDate.format(new Date(row.periodEnd.getTime() - (row.periodEnd > row.periodStart ? 1 : 0)))
      : toYMD(row.periodEnd),
    createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
    ...(row.chunk?.calculationStrategy === 'METER'
      ? {
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        compteurId: row.chunk.compteurId,
        calculationStrategy: 'METER'
      }
      : {}),
    values: {
      value: decimalToNumber(row.value)
    }
  }))
}
