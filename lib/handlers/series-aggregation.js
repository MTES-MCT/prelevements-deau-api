import Joi from 'joi'
import createHttpError from 'http-errors'
import {getISOWeek, getISOWeekYear, parseISO} from 'date-fns'
import {min, max} from 'lodash-es'
import * as Sentry from '@sentry/node'

import {prisma} from '../../db/prisma.js'
import {NON_REJECTED_CHUNK_INSTRUCTION_STATUSES} from '../constants/chunk-statuses.js'
import {METRIC_TYPE_CODES} from '../constants/metric-type-codes.js'

import {getPointPrelevement} from '../models/point-prelevement.js'
import {getPointsFromDeclarant} from '../services/point-prelevement.js'
import {getDeclarant} from '../models/declarant.js'

import {listSeries} from '../models/series.js'

import {
  parametersConfig,
  getDefaultOperator,
  validateOperatorForParameter,
  ALL_FREQUENCIES,
  DAILY_FREQUENCY
} from '../parameters-config.js'

function validateUuidList(value, helpers) {
  const ids = value.split(',')
  const schema = Joi.string().uuid({version: 'uuidv4'})

  for (const id of ids) {
    const {error} = schema.validate(id)
    if (error) {
      return helpers.error('any.invalid')
    }
  }

  return value
}

/**
 * Schéma Joi
 */
const aggregatedSeriesQuerySchema = Joi.object({
  pointIds: Joi.string()
    .custom(validateUuidList)
    .messages({
      'string.base': 'Le paramètre pointIds doit être une chaîne de caractères',
      'string.empty': 'Le paramètre pointIds ne peut pas être vide',
      'any.invalid': 'Le paramètre pointIds doit être une liste d\'UUID v4 séparés par des virgules'
    }),

  preleveurId: Joi.string().uuid({version: 'uuidv4'}), // DeclarantUserId

  collecteurId: Joi.string().uuid({version: 'uuidv4'}), // DeclarantUserId collecteur

  sourceId: Joi.string().uuid({version: 'uuidv4'}),

  metricTypeCode: Joi.string().required().messages({
    'string.base': 'Le paramètre metricTypeCode doit être une chaîne de caractères',
    'string.empty': 'Le paramètre metricTypeCode est obligatoire',
    'any.required': 'Le paramètre metricTypeCode est obligatoire'
  }),

  spatialOperator: Joi.string().valid('sum', 'mean', 'min', 'max'),
  temporalOperator: Joi.string().valid('sum', 'mean', 'min', 'max'),

  aggregationFrequency: Joi.string()
    .valid(...ALL_FREQUENCIES)
    .default(DAILY_FREQUENCY)
    .messages({
      'string.base': 'Le paramètre aggregationFrequency doit être une chaîne de caractères',
      'any.only': `Le paramètre aggregationFrequency doit être l'un des suivants: ${ALL_FREQUENCIES.join(', ')}`
    }),

  startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
  endDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
})
  .or('pointIds', 'preleveurId', 'collecteurId', 'sourceId')
  .messages({
    'object.missing': 'Vous devez fournir au moins pointIds, preleveurId, collecteurId ou sourceId'
  })

export function validateQueryParams(query) {
  const {error, value} = aggregatedSeriesQuerySchema.validate(query, {
    abortEarly: false,
    stripUnknown: true
  })

  if (error) {
    const messages = error.details.map(d => d.message)
    throw createHttpError(400, messages.join('. '))
  }

  return value
}

function validateDate(dateString, paramName) {
  if (!dateString) {
    return null
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    throw createHttpError(400, `Le paramètre ${paramName} doit être au format YYYY-MM-DD`)
  }

  const d = new Date(dateString)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dateString) {
    throw createHttpError(400, `Le paramètre ${paramName} est une date invalide`)
  }

  return dateString
}

/**
 * Resolve points (UUID only)
 */
async function resolvePointIds(pointIds) {
  const found = []
  const notFound = []

  const results = await Promise.all(
    pointIds.map(async pointId => {
      const point = await getPointPrelevement(pointId)
      return {pointId, point}
    })
  )

  for (const {pointId, point} of results) {
    if (point) {
      found.push({id: point.id, point})
    } else {
      notFound.push(pointId)
    }
  }

  return {found, notFound}
}

async function resolveDeclarantPoints(declarantUserId) {
  const declarant = await getDeclarant(declarantUserId)
  if (!declarant) {
    throw createHttpError(404, `Déclarant non trouvé: ${declarantUserId}`)
  }

  const points = await getPointsFromDeclarant(declarant.id)
  const found = points.map(point => ({id: point.id, point}))
  return {found, notFound: []}
}

async function resolveCollecteurPoints(collecteurUserId) {
  const collecteur = await getDeclarant(collecteurUserId)
  if (!collecteur) {
    throw createHttpError(404, `Collecteur non trouvé: ${collecteurUserId}`)
  }

  const links = await prisma.declarantCollecteurExploitation.findMany({
    where: {collecteurUserId},
    select: {
      exploitation: {
        select: {
          pointPrelevement: {
            select: {
              id: true,
              name: true
            }
          }
        }
      }
    }
  })

  const pointsById = new Map()

  for (const link of links) {
    const point = link.exploitation?.pointPrelevement

    if (point?.id && !pointsById.has(point.id)) {
      pointsById.set(point.id, {id: point.id, point})
    }
  }

  return {found: [...pointsById.values()], notFound: []}
}

async function resolveSourcePoints(sourceId) {
  // Points présents dans la source via chunks liés (uniquement ceux liés à un pointPrelevementId)
  const chunks = await prisma.chunk.findMany({
    where: {
      sourceId,
      pointPrelevementId: {not: null},
      instructionStatus: {in: NON_REJECTED_CHUNK_INSTRUCTION_STATUSES},
      source: {
        status: 'COMPLETED'
      }
    },
    distinct: ['pointPrelevementId'],
    select: {pointPrelevementId: true}
  })

  const ids = chunks.map(c => c.pointPrelevementId).filter(Boolean)
  if (ids.length === 0) {
    return {found: [], notFound: []}
  }

  const points = await prisma.pointPrelevement.findMany({
    where: {id: {in: ids}, deletedAt: null},
    select: {id: true, name: true}
  })

  const found = points.map(p => ({id: p.id, point: {name: p.name}}))
  return {found, notFound: []}
}

export function filterPointsByIds(availablePoints, requestedIds) {
  const pointsById = new Map(availablePoints.map(p => [p.id, p]))
  const found = []
  const notFound = []

  for (const id of requestedIds) {
    const p = pointsById.get(id)
    if (p) {
      found.push(p)
    } else {
      notFound.push(id)
    }
  }

  return {found, notFound}
}

/**
 * Résolution des points pour agrégation
 * Supporte désormais le cas sourceId-only (sans pointIds / preleveurId)
 */
export async function resolvePointsForAggregation({pointIdsStr, preleveurId, collecteurId, sourceId}) {
  if (preleveurId && pointIdsStr) {
    const requested = pointIdsStr.split(',')
    const {found: declarantPoints} = await resolveDeclarantPoints(preleveurId)
    const {found, notFound} = filterPointsByIds(declarantPoints, requested)

    if (found.length === 0) {
      throw createHttpError(
        404,
        `Aucun point trouvé pour le déclarant ${preleveurId} avec les identifiants: ${requested.join(', ')}`
      )
    }

    return {resolvedPoints: found, notFound}
  }

  if (collecteurId && pointIdsStr) {
    const requested = pointIdsStr.split(',')
    const {found: collecteurPoints} = await resolveCollecteurPoints(collecteurId)
    const {found, notFound} = filterPointsByIds(collecteurPoints, requested)

    if (found.length === 0) {
      throw createHttpError(
        404,
        `Aucun point trouvé pour le collecteur ${collecteurId} avec les identifiants: ${requested.join(', ')}`
      )
    }

    return {resolvedPoints: found, notFound}
  }

  if (pointIdsStr) {
    const ids = pointIdsStr.split(',')
    const {found, notFound} = await resolvePointIds(ids)

    if (found.length === 0) {
      throw createHttpError(404, `Aucun point de prélèvement trouvé pour: ${ids.join(', ')}`)
    }

    return {resolvedPoints: found, notFound}
  }

  if (preleveurId) {
    const {found, notFound} = await resolveDeclarantPoints(preleveurId)
    return {resolvedPoints: found, notFound}
  }

  if (collecteurId) {
    const {found, notFound} = await resolveCollecteurPoints(collecteurId)
    return {resolvedPoints: found, notFound}
  }

  if (sourceId) {
    const {found, notFound} = await resolveSourcePoints(sourceId)
    return {resolvedPoints: found, notFound}
  }

  throw createHttpError(400, 'Vous devez fournir au moins pointIds, preleveurId, collecteurId ou sourceId')
}

function isValidValue(value) {
  return value !== null && value !== undefined && !Number.isNaN(value) && Number.isFinite(value)
}

function isIndexMetricTypeCode(metricTypeCode) {
  return metricTypeCode === METRIC_TYPE_CODES.RELEVE_INDEX || metricTypeCode === METRIC_TYPE_CODES.INDEX
}

function getSqlAggregationFunction(operator) {
  switch (operator) {
    case 'sum': {
      return 'sum'
    }

    case 'mean': {
      return 'avg'
    }

    case 'min': {
      return 'min'
    }

    case 'max': {
      return 'max'
    }

    default: {
      throw new Error(`Opérateur inconnu: ${operator}`)
    }
  }
}

function getSqlPeriodExpression(dateColumn, frequency) {
  switch (frequency) {
    case '15 minutes':
    case '1 hour':
    case '6 hours':
    case '1 day': {
      return `to_char(${dateColumn}, 'YYYY-MM-DD')`
    }

    case '1 week': {
      return `to_char(${dateColumn}, 'IYYY-"W"IW')`
    }

    case '1 month': {
      return `to_char(${dateColumn}, 'YYYY-MM')`
    }

    case '1 quarter': {
      return `concat(extract(year from ${dateColumn})::int, '-Q', extract(quarter from ${dateColumn})::int)`
    }

    case '1 year': {
      return `to_char(${dateColumn}, 'YYYY')`
    }

    default: {
      throw new Error(`Fréquence d'agrégation inconnue: ${frequency}`)
    }
  }
}

function buildDateFilter({startDate, endDate}, params) {
  const filters = []

  if (startDate) {
    params.push(startDate)
    filters.push(`cv."periodEnd" >= $${params.length}::date`)
  }

  if (endDate) {
    params.push(endDate)
    filters.push(`cv."periodEnd" < ($${params.length}::date + interval '1 day')`)
  }

  return filters.length > 0 ? ` AND ${filters.join(' AND ')}` : ''
}

function getComparableCreatedAt(item) {
  const createdAt = item?.createdAt
  if (!createdAt) {
    return 0
  }

  const parsed = createdAt instanceof Date ? createdAt : new Date(createdAt)
  const timestamp = parsed.getTime()
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function pickLatestValueItem(items) {
  return [...items].sort((a, b) => {
    const createdAtDelta = getComparableCreatedAt(b) - getComparableCreatedAt(a)
    if (createdAtDelta !== 0) {
      return createdAtDelta
    }

    return String(b.id ?? '').localeCompare(String(a.id ?? ''))
  })[0]
}

function shouldDeduplicateSamePointIndexItems(items) {
  return items.every(item =>
    isIndexMetricTypeCode(item.metricTypeCode)
    && item.pointId
    && item.createdAt
  )
}

function deduplicateSamePointIndexItems(items) {
  const latestByPointId = new Map()

  for (const item of items) {
    const previousItem = latestByPointId.get(item.pointId)
    if (!previousItem || pickLatestValueItem([previousItem, item]) === item) {
      latestByPointId.set(item.pointId, item)
    }
  }

  return [...latestByPointId.values()]
}

export function deduplicateAndLimitRemarks(remarks, limit = 10) {
  if (!Array.isArray(remarks) || remarks.length === 0) {
    return []
  }

  return [...new Set(remarks)].slice(0, limit)
}

export function extractValuesAndRemarks(items) {
  const values = []
  const remarks = []

  if (!Array.isArray(items)) {
    return {values, remarks}
  }

  for (const item of items) {
    if (typeof item === 'number') {
      if (Number.isFinite(item)) {
        values.push(item)
      }

      continue
    }

    if (item && typeof item === 'object') {
      const {value, remark, remarks: itemRemarks} = item

      if (typeof value === 'number' && Number.isFinite(value)) {
        values.push(value)
      }

      if (remark) {
        remarks.push(remark)
      }

      if (Array.isArray(itemRemarks)) {
        remarks.push(...itemRemarks)
      }
    }
  }

  return {values, remarks}
}

export function applyAggregationOperator(items, operator) {
  if (!Array.isArray(items) || items.length === 0) {
    return null
  }

  const {values, remarks: allRemarks} = extractValuesAndRemarks(items)
  if (values.length === 0) {
    return null
  }

  let aggregatedValue
  switch (operator) {
    case 'sum': {
      aggregatedValue = values.reduce((acc, v) => acc + v, 0)
      break
    }

    case 'mean': {
      const s = values.reduce((acc, v) => acc + v, 0)
      aggregatedValue = s / values.length
      break
    }

    case 'min': {
      aggregatedValue = min(values)
      break
    }

    case 'max': {
      aggregatedValue = max(values)
      break
    }

    default: {
      throw new Error(`Opérateur inconnu: ${operator}`)
    }
  }

  const result = {value: aggregatedValue}

  if (allRemarks.length > 0) {
    const uniqueRemarks = deduplicateAndLimitRemarks(allRemarks, 10)
    if (uniqueRemarks.length > 0) {
      result.remarks = uniqueRemarks
    }
  }

  return result
}

/**
 * Daily-only extraction
 */
export function extractValuesFromDocument(valueDoc) {
  const value = valueDoc?.values?.value
  const remark = valueDoc?.values?.remark
  const date = valueDoc?.date

  if (!date || !isValidValue(value)) {
    return []
  }

  const res = {period: date, value}
  if (valueDoc.id) {
    res.id = valueDoc.id
  }

  if (valueDoc.createdAt) {
    res.createdAt = valueDoc.createdAt
  }

  if (remark) {
    res.remark = remark
  }

  return [res]
}

/**
 * Agrège spatialement les valeurs d'une période.
 */
export function aggregateSpatialValues(items, period, spatialOperator, temporalOperator) {
  if (spatialOperator === null) {
    const effectiveItems = shouldDeduplicateSamePointIndexItems(items)
      ? deduplicateSamePointIndexItems(items)
      : items

    if (effectiveItems.length === 1) {
      const it = effectiveItems[0]
      const result = {date: period, value: it.value}
      if (it.remarks) {
        result.remarks = it.remarks
      }

      return result
    }

    const aggregated = applyAggregationOperator(effectiveItems, temporalOperator)
    if (aggregated !== null) {
      const result = {date: period, value: aggregated.value}
      if (aggregated.remarks) {
        result.remarks = aggregated.remarks
      }

      return result
    }

    return null
  }

  const aggregated = applyAggregationOperator(items, spatialOperator)
  if (aggregated !== null) {
    const result = {date: period, value: aggregated.value}
    if (aggregated.remarks) {
      result.remarks = aggregated.remarks
    }

    return result
  }

  return null
}

export function extractPeriod(date, frequency) {
  if (frequency === '1 month') {
    return date.slice(0, 7)
  }

  if (frequency === '1 quarter') {
    const year = date.slice(0, 4)
    const month = Number.parseInt(date.slice(5, 7), 10)
    const quarter = Math.ceil(month / 3)
    return `${year}-Q${quarter}`
  }

  if (frequency === '1 year') {
    return date.slice(0, 4)
  }

  if (frequency === '1 week') {
    // Use ISO week keys to keep weekly buckets stable across year boundaries.
    const d = parseISO(`${date.slice(0, 10)}T12:00:00.000Z`)
    if (Number.isNaN(d.getTime())) {
      return date.slice(0, 10)
    }

    const y = getISOWeekYear(d)
    const w = getISOWeek(d)
    return `${y}-W${String(w).padStart(2, '0')}`
  }

  return date
}

export function aggregateDailyValuesToPeriod(dailyValues, frequency, operator) {
  if (frequency === '1 day') {
    return dailyValues
  }

  const valuesByPeriod = new Map()
  for (const item of dailyValues) {
    const period = extractPeriod(item.date, frequency)
    if (!valuesByPeriod.has(period)) {
      valuesByPeriod.set(period, [])
    }

    valuesByPeriod.get(period).push(item)
  }

  const aggregatedValues = []
  for (const [period, items] of valuesByPeriod.entries()) {
    const aggregated = applyAggregationOperator(items, operator)
    if (aggregated !== null) {
      const result = {date: period, value: aggregated.value}
      if (aggregated.remarks) {
        result.remarks = aggregated.remarks
      }

      aggregatedValues.push(result)
    }
  }

  aggregatedValues.sort((a, b) => a.date.localeCompare(b.date))
  return aggregatedValues
}

async function hasTemporalOverlap({chunkIds, metricTypeCode, startDate, endDate}) {
  const params = [chunkIds, metricTypeCode]
  const dateFilter = buildDateFilter({startDate, endDate}, params)
  const sql = `
    SELECT EXISTS (
      SELECT 1
      FROM "ChunkValue" cv
      JOIN "Chunk" c ON c.id = cv."chunkId"
      WHERE cv."chunkId" = ANY($1::uuid[])
        AND cv."metricTypeCode" = $2
        ${dateFilter}
      GROUP BY c."pointPrelevementId", cv."periodEnd"::date
      HAVING count(*) > 1
      LIMIT 1
    ) AS "hasOverlap"
  `

  const rows = await prisma.$queryRawUnsafe(sql, ...params)
  return Boolean(rows[0]?.hasOverlap)
}

function normalizeSqlValue(row) {
  const value = typeof row.value === 'number' ? row.value : Number(row.value)

  if (!Number.isFinite(value)) {
    return null
  }

  return {
    date: row.date,
    value
  }
}

async function getAggregatedValuesFromSql({
  aggregationFrequency,
  chunkIds,
  endDate,
  metricTypeCode,
  spatialOperator,
  startDate,
  temporalOperator
}) {
  if (chunkIds.length === 0) {
    return []
  }

  const isIndexMetric = isIndexMetricTypeCode(metricTypeCode)
  const rawValuesTable = isIndexMetric ? 'deduplicated_index_values' : 'raw_values'
  const dailyOperator = getSqlAggregationFunction(spatialOperator ?? temporalOperator)
  const periodOperator = getSqlAggregationFunction(temporalOperator)
  const periodExpression = getSqlPeriodExpression('bucket_date', aggregationFrequency)
  const params = [chunkIds, metricTypeCode]
  const dateFilter = buildDateFilter({startDate, endDate}, params)

  const sql = `
    WITH raw_values AS (
      SELECT
        cv.id,
        c."pointPrelevementId" AS "pointId",
        cv."periodEnd"::date AS bucket_date,
        cv.value,
        cv."createdAt"
      FROM "ChunkValue" cv
      JOIN "Chunk" c ON c.id = cv."chunkId"
      WHERE cv."chunkId" = ANY($1::uuid[])
        AND cv."metricTypeCode" = $2
        ${dateFilter}
    ),
    deduplicated_index_values AS (
      SELECT id, "pointId", bucket_date, value, "createdAt"
      FROM (
        SELECT
          raw_values.*,
          row_number() OVER (
            PARTITION BY bucket_date, "pointId"
            ORDER BY "createdAt" DESC NULLS LAST, id DESC
          ) AS rank
        FROM raw_values
      ) ranked_values
      WHERE rank = 1
    ),
    daily_values AS (
      SELECT
        bucket_date,
        ${dailyOperator}(value)::float8 AS value
      FROM ${rawValuesTable}
      GROUP BY bucket_date
    )
    SELECT
      ${periodExpression} AS date,
      ${periodOperator}(value)::float8 AS value
    FROM daily_values
    GROUP BY date
    ORDER BY date
  `

  const rows = await prisma.$queryRawUnsafe(sql, ...params)
  return rows.map(normalizeSqlValue).filter(Boolean)
}

function buildAggregationMetadata({
  metricTypeCode,
  unit,
  spatialOperator,
  temporalOperator,
  aggregationFrequency,
  pointIdsStr,
  preleveurId,
  collecteurId,
  sourceId,
  resolvedPoints,
  notFound,
  startDate,
  endDate
}) {
  const metadata = {
    metricTypeCode,
    unit,
    spatialOperator,
    temporalOperator,
    frequency: aggregationFrequency,
    startDate: startDate || null,
    endDate: endDate || null,
    ...(sourceId ? {sourceId} : {}),
    ...(preleveurId ? {preleveurId} : {}),
    ...(collecteurId ? {collecteurId} : {})
  }

  if (pointIdsStr && notFound.length > 0) {
    metadata.pointsNotFound = notFound
  }

  metadata.points = resolvedPoints.map(rp => ({
    id: rp.id,
    name: rp.point.name
  }))

  return metadata
}

/**
 * Résout points & séries
 */
async function resolvePointsAndSeries({sourceId, pointIdsStr, preleveurId, collecteurId, metricTypeCode, startDate, endDate}) {
  const {resolvedPoints, notFound} = await resolvePointsForAggregation({pointIdsStr, preleveurId, collecteurId, sourceId})
  const pointIds = resolvedPoints.map(rp => rp.id)

  const seriesList = await listSeries({
    sourceId,
    pointIds,
    preleveurId,
    parameter: metricTypeCode,
    startDate,
    endDate
  })

  return {resolvedPoints, notFound, seriesList}
}

export async function getAggregatedSeriesHandler(req, res) {
  const validated = validateQueryParams(req.query)

  const {
    pointIds: pointIdsStr,
    preleveurId,
    collecteurId,
    sourceId,
    metricTypeCode,
    startDate: startDateStr,
    endDate: endDateStr,
    aggregationFrequency
  } = validated

  const startDate = validateDate(startDateStr, 'startDate')
  const endDate = validateDate(endDateStr, 'endDate')

  if (startDate && endDate && startDate > endDate) {
    throw createHttpError(400, 'Le paramètre startDate doit être antérieur ou égal à endDate')
  }

  const spatialOperator = validated.spatialOperator || getDefaultOperator(metricTypeCode, 'spatial')
  const temporalOperator = validated.temporalOperator || getDefaultOperator(metricTypeCode, 'temporal')

  // Validate temporal operator always
  try {
    validateOperatorForParameter(metricTypeCode, temporalOperator, 'temporal')
  } catch (error) {
    Sentry.captureException(error)
    throw createHttpError(400, error.message)
  }

  const parameterConfig = parametersConfig[metricTypeCode]
  if (!parameterConfig) {
    throw createHttpError(400, `MetricType "${metricTypeCode}" inconnu`)
  }

  const {resolvedPoints, notFound, seriesList} = await resolvePointsAndSeries({
    sourceId,
    pointIdsStr,
    preleveurId,
    collecteurId,
    metricTypeCode,
    startDate,
    endDate
  })

  // No series => empty
  if (seriesList.length === 0) {
    return res.send({
      metadata: buildAggregationMetadata({
        metricTypeCode,
        unit: parameterConfig.unit,
        spatialOperator,
        temporalOperator,
        aggregationFrequency,
        pointIdsStr,
        preleveurId,
        collecteurId,
        sourceId,
        resolvedPoints,
        notFound,
        startDate,
        endDate
      }),
      values: []
    })
  }

  // Validate spatial operator when supported
  if (validated.spatialOperator && parameterConfig.spatialOperators.length === 0) {
    throw createHttpError(
      400,
      `Le metricTypeCode "${metricTypeCode}" ne supporte pas l'agrégation spatiale.`
    )
  }

  if (parameterConfig.spatialOperators.length > 0) {
    try {
      validateOperatorForParameter(metricTypeCode, spatialOperator, 'spatial')
    } catch (error) {
      Sentry.captureException(error)
      throw createHttpError(400, error.message)
    }
  }

  const chunkIds = [...new Set(seriesList.map(series => series.computed?.chunkId).filter(Boolean))]
  const canResolveIndexOverlap = isIndexMetricTypeCode(metricTypeCode)
  const shouldRejectOverlaps = spatialOperator !== 'sum' && !canResolveIndexOverlap

  // Overlap rule: if duplicates exist and spatial op is not sum => reject
  if (shouldRejectOverlaps && await hasTemporalOverlap({
    chunkIds,
    metricTypeCode,
    startDate,
    endDate
  })) {
    throw createHttpError(
      400,
      'Agrégation spatiale impossible: des doublons existent sur les mêmes dates pour au moins un point. '
      + 'Utilisez spatialOperator=sum ou réduisez le scope (source/points/date).'
    )
  }

  const aggregatedValues = await getAggregatedValuesFromSql({
    aggregationFrequency,
    chunkIds,
    endDate,
    metricTypeCode,
    spatialOperator: parameterConfig.spatialOperators.length > 0 ? spatialOperator : null,
    startDate,
    temporalOperator
  })

  const minDate = aggregatedValues.length > 0 ? aggregatedValues[0].date : null
  const maxDate = aggregatedValues.length > 0 ? aggregatedValues.at(-1).date : null

  const metadata = buildAggregationMetadata({
    metricTypeCode,
    unit: parameterConfig.unit,
    spatialOperator,
    temporalOperator,
    aggregationFrequency,
    pointIdsStr,
    preleveurId,
    collecteurId,
    sourceId,
    resolvedPoints,
    notFound,
    startDate,
    endDate
  })

  res.send({
    metadata: {
      ...metadata,
      minDate,
      maxDate,
      seriesCount: seriesList.length,
      valuesCount: aggregatedValues.length
    },
    values: aggregatedValues
  })
}

export {ALL_FREQUENCIES, DAILY_FREQUENCY} from '../parameters-config.js'
