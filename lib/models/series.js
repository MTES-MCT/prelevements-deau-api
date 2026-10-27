import {NATIVE_CHUNK_WHERE, NON_NATIVE_CHUNK_WHERE, isNativeTemporal, nativeBusinessDateBoundary, nativeDateTimeParts} from '../util/native-temporal.js'
import {prisma} from '../../db/prisma.js'
import {Prisma} from '@prisma/client'
import createHttpError from 'http-errors'
import {NON_REJECTED_CHUNK_INSTRUCTION_STATUSES} from '../constants/chunk-statuses.js'
import {
  getCompatibleMetricTypeCodes,
  inferFlowTypeFromLegacyMetricTypeCode,
  normalizeMetricTypeCode
} from '../constants/metric-type-codes.js'
import {parametersConfig} from '../parameters-config.js'
import {getVisibleTelemetryChunksWhere} from '../services/telemetry-source-access.js'
import {meterBusinessDateBoundary} from '../services/meter-core.js'
import {chunkValueSummaryGroupsSql} from '../services/chunk-value-summaries.js'

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000
export const MAX_NATIVE_SERIES_VALUES = 50_000

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
  if (!periodEndFilter) return null

  const native = {chunk: NATIVE_CHUNK_WHERE}
  // An instant at the beginning of a day is included. A period ending there is
  // excluded. The column reference avoids inventing a duration for observations.
  const nativePeriod = {...native,
    ...(startDate ? {OR: [
      {periodEnd: {gt: nativeBusinessDateBoundary(startDate)}},
      {periodEnd: {equals: prisma.chunkValue.fields.periodStart}, periodStart: {gte: nativeBusinessDateBoundary(startDate)}}
    ]} : {}),
    ...(endDate ? {periodStart: {lt: nativeBusinessDateBoundary(endDate, true)}} : {})}
  if (!parameter || isCumulativeMetricTypeCode(parameter)) {
    const exactMeter = {frequency: 'irregular', chunk: {calculationStrategy: 'METER'}}
    const legacy = includeOverlappingPeriods && parameter
      ? {AND: buildPeriodOverlapFilter({startDate, endDate})}
      : {periodEnd: periodEndFilter}
    return {OR: [
      {...exactMeter,
        ...(startDate ? {periodEnd: {gt: meterBusinessDateBoundary(startDate)}} : {}),
        ...(endDate ? {periodStart: {lt: meterBusinessDateBoundary(endDate, true)}} : {})},
      {NOT: exactMeter, chunk: NON_NATIVE_CHUNK_WHERE, ...legacy},
      nativePeriod
    ]}
  }

  return {OR: [nativePeriod, {chunk: NON_NATIVE_CHUNK_WHERE, periodEnd: periodEndFilter}]}
}

const parisDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'})

function getSeriesPeriodMetadata({useCoveredBounds, exactMeter, nativeMetadata, minPeriodStart, minPeriodEnd, maxPeriodEnd}) {
  if (isNativeTemporal(nativeMetadata)) {
    const hasIntervals = nativeMetadata.valueType !== 'instantaneous' && nativeMetadata.parameter !== 'index' && nativeMetadata.frequency !== 'instant'
    return {
      minDate: minPeriodStart ? nativeDateTimeParts(minPeriodStart).date : null,
      maxDate: maxPeriodEnd ? nativeDateTimeParts(new Date(maxPeriodEnd.getTime() - (hasIntervals ? 1 : 0))).date : null
    }
  }
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
  metadata: true,
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

export function getNativeSeriesChunkScope({user, pointIds = []} = {}) {
  if (user?.role !== 'INSTRUCTOR') return []
  return [{OR: [NON_NATIVE_CHUNK_WHERE, {pointPrelevementId: {in: pointIds}}]}]
}

/**
 * ListSeries
 */
async function buildSeriesWhere({
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
    return null
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
      ...getNativeSeriesChunkScope({user, pointIds: meterPointIds}),
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

  return {
    ...(parameter ? {metricTypeCode: {in: getCompatibleMetricTypeCodes(parameter)}} : {}),
    ...metricPeriodFilter,
    chunk: chunkWhere
  }
}

async function loadFullHistorySeriesGroups(where, {client}) {
  // Authorize using the same Prisma predicate as the raw-value path. Summaries
  // contain facts only and must never decide visibility or beneficiary scope.
  const chunks = await client.chunk.findMany({where: where.chunk, select: {id: true}})
  if (chunks.length === 0) return []

  const groups = await client.$queryRaw(Prisma.sql`
    SELECT c.id AS "chunkId", groups.*
    FROM unnest(${chunks.map(chunk => chunk.id)}::uuid[]) AS c(id)
    CROSS JOIN LATERAL (${chunkValueSummaryGroupsSql(Prisma.sql`c.id`)}) groups
    ${where.metricTypeCode ? Prisma.sql`WHERE groups."metricTypeCode" = ANY(${where.metricTypeCode.in}::text[])` : Prisma.empty}
  `)
  return groups.map(group => ({
    chunkId: group.chunkId,
    metricTypeCode: group.metricTypeCode,
    unit: group.unit,
    frequency: group.frequency,
    _min: {periodStart: group.minPeriodStart, periodEnd: group.minPeriodEnd},
    _max: {periodEnd: group.maxPeriodEnd},
    _count: {_all: Number(group.valueCount)}
  }))
}

// Aggregation needs the same visibility and historical fallback as listSeries,
// but never the per-series actors or date summaries. Keep the grouping contract
// so seriesCount still distinguishes legacy codes, units and frequencies.
export async function getAggregationSeriesScope(options = {}, {client = prisma} = {}) {
  const where = await buildSeriesWhere(options, {client})
  if (!where) return {chunkIds: [], seriesCount: 0}

  const groups = options.startDate || options.endDate
    ? await client.chunkValue.groupBy({
      by: ['chunkId', 'metricTypeCode', 'unit', 'frequency'],
      where
    })
    : await loadFullHistorySeriesGroups(where, {client})
  return {chunkIds: [...new Set(groups.map(group => group.chunkId))], seriesCount: groups.length}
}

export async function listSeries(options = {}, {client = prisma} = {}) {
  const {includeOverlappingPeriods = false, preleveurId} = options
  const where = await buildSeriesWhere(options, {client})
  if (!where) return []

  const grouped = options.startDate || options.endDate
    ? await client.chunkValue.groupBy({
      by: ['chunkId', 'metricTypeCode', 'unit', 'frequency'],
      where,
      _min: {periodStart: true, periodEnd: true},
      _max: {periodEnd: true},
      _count: {_all: true}
    })
    : await loadFullHistorySeriesGroups(where, {client})

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
      nativeMetadata: chunk?.metadata,
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
      valueType: isNativeTemporal(chunk?.metadata) ? chunk.metadata.valueType : 'cumulative',
      originalFrequency: isNativeTemporal(chunk?.metadata) ? group.frequency : null,
      minDate: periodMetadata.minDate,
      maxDate: periodMetadata.maxDate,
      hasSubDaily: isNativeTemporal(chunk?.metadata) && ['instant', '1 second', '1 minute', '15 minutes', '1 hour', '6 hours'].includes(group.frequency),
      pointPrelevement: chunk?.pointPrelevementId || null,
      exploitationId: chunk?.exploitationId ?? null,
      countingCode: chunk?.exploitation?.countingCode ?? null,
      extras: isNativeTemporal(chunk?.metadata) ? chunk.metadata : null,
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
    nativeMetadata: chunk.metadata,
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
    valueType: isNativeTemporal(chunk.metadata) ? chunk.metadata.valueType : 'cumulative',
    originalFrequency: isNativeTemporal(chunk.metadata) ? first?.frequency : null,
    minDate: periodMetadata.minDate,
    maxDate: periodMetadata.maxDate,
    hasSubDaily: isNativeTemporal(chunk.metadata) && ['instant', '1 second', '1 minute', '15 minutes', '1 hour', '6 hours'].includes(first?.frequency),
    pointPrelevement: chunk.pointPrelevementId || null,
    exploitationId: chunk.exploitationId ?? null,
    countingCode: chunk.exploitation?.countingCode ?? null,
    extras: isNativeTemporal(chunk.metadata) ? chunk.metadata : null,
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

  const nativeChunk = await client.chunk.findFirst({
    where: {id: key.chunkId, ...NATIVE_CHUNK_WHERE},
    select: {id: true}
  })
  const rows = await client.chunkValue.findMany({
    where,
    ...(nativeChunk ? {take: MAX_NATIVE_SERIES_VALUES + 1} : {}),
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
      metadata: true,
      remark: true,
      chunk: {select: {calculationStrategy: true, compteurId: true, metadata: true}}
    }
  })

  if (nativeChunk && rows.length > MAX_NATIVE_SERIES_VALUES) {
    throw createHttpError(400, 'Cette série dépasse 50 000 valeurs importées. Réduisez la période ou utilisez la lecture paginée des valeurs dans la déclaration.')
  }

  return rows.map(row => ({
    id: row.id,
    date: isNativeTemporal(row.chunk?.metadata) ? row.periodStart.toISOString() : row.chunk?.calculationStrategy === 'METER' && row.frequency === 'irregular'
      ? parisDate.format(new Date(row.periodEnd.getTime() - (row.periodEnd > row.periodStart ? 1 : 0)))
      : toYMD(row.periodEnd),
    createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
    ...(isNativeTemporal(row.chunk?.metadata) ? {nativeTemporal: true, periodStart: row.periodStart, periodEnd: row.periodEnd, remark: row.remark, metadata: row.metadata, timezone: row.chunk.metadata.timezone} : {}),
    ...(row.chunk?.calculationStrategy === 'METER'
      ? {
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        compteurId: row.chunk.compteurId,
        calculationStrategy: 'METER'
      }
      : {}),
    values: {
      value: isNativeTemporal(row.chunk?.metadata) ? row.value?.toString() ?? null : decimalToNumber(row.value)
    }
  }))
}
