import Joi from 'joi'
import createHttpError from 'http-errors'
import {min, max} from 'lodash-es'
import * as Sentry from '@sentry/node'

import {getPointPrelevement} from '../models/point-prelevement.js'
import {getPointsFromDeclarant} from '../services/point-prelevement.js'
import {getDeclarant} from '../models/declarant.js'

import {listSeries, getSeriesValuesInRange} from '../models/series.js'

import {
  parametersConfig,
  getDefaultOperator,
  validateOperatorForParameter
} from '../parameters-config.js'

/**
 * Fréquences supportées (daily-only + rollups)
 */
export const DAILY_FREQUENCY = '1 day'
export const ALL_FREQUENCIES = ['1 day', '1 month', '1 quarter', '1 year']
export const SUB_DAILY_FREQUENCIES = [] // plus supporté

function validateUuidList(value, helpers) {
  const ids = value.split(',')
  const schema = Joi.string().uuid({version: 'uuidv4'})

  for (const id of ids) {
    const {error} = schema.validate(id)
    if (error) return helpers.error('any.invalid')
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

  preleveurId: Joi.string().uuid({version: 'uuidv4'}), // declarantUserId

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
  .or('pointIds', 'preleveurId', 'sourceId')
  .messages({
    'object.missing': 'Vous devez fournir au moins pointIds, preleveurId ou sourceId'
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
  if (!dateString) return null

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

  const points = await getPointsFromDeclarant(declarant.userId)
  const found = points.map(point => ({id: point.id, point}))
  return {found, notFound: []}
}

export function filterPointsByIds(availablePoints, requestedIds) {
  const pointsById = new Map(availablePoints.map(p => [p.id, p]))
  const found = []
  const notFound = []

  for (const id of requestedIds) {
    const p = pointsById.get(id)
    if (p) found.push(p)
    else notFound.push(id)
  }

  return {found, notFound}
}

export async function resolvePointsForAggregation({pointIdsStr, preleveurId}) {
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

  if (pointIdsStr) {
    const ids = pointIdsStr.split(',')
    const {found, notFound} = await resolvePointIds(ids)

    if (found.length === 0) {
      throw createHttpError(404, `Aucun point de prélèvement trouvé pour: ${ids.join(', ')}`)
    }

    return {resolvedPoints: found, notFound}
  }

  const {found, notFound} = await resolveDeclarantPoints(preleveurId)
  return {resolvedPoints: found, notFound}
}

/**
 * Overlap version Metric :
 * overlap = pour un point donné, il existe >1 valeur sur la même date (startDate) dans le scope.
 * => mean/min/max spatial incohérents (mélange de contextes). sum reste OK.
 */
export function detectTemporalOverlapInSeries(seriesList) {
  // Ici "seriesList" est la liste des séries virtuelles.
  // Le vrai overlap est détecté au moment des values (plus fiable). Donc on retourne false
  // et on fait la détection sur les docs dans fetchAllSeriesValues (voir plus bas).
  return false
}

function isValidValue(value) {
  return value !== null && value !== undefined && !Number.isNaN(value) && Number.isFinite(value)
}

export function deduplicateAndLimitRemarks(remarks, limit = 10) {
  if (!Array.isArray(remarks) || remarks.length === 0) return []
  return [...new Set(remarks)].slice(0, limit)
}

export function extractValuesAndRemarks(items) {
  const values = []
  const remarks = []

  if (!Array.isArray(items)) return {values, remarks}

  for (const item of items) {
    if (typeof item === 'number') {
      if (Number.isFinite(item)) values.push(item)
      continue
    }

    if (item && typeof item === 'object') {
      const {value, remark, remarks: itemRemarks} = item

      if (typeof value === 'number' && Number.isFinite(value)) values.push(value)

      if (remark) remarks.push(remark)
      if (Array.isArray(itemRemarks)) remarks.push(...itemRemarks)
    }
  }

  return {values, remarks}
}

export function applyAggregationOperator(items, operator) {
  if (!Array.isArray(items) || items.length === 0) return null

  const {values, remarks: allRemarks} = extractValuesAndRemarks(items)
  if (values.length === 0) return null

  let aggregatedValue
  switch (operator) {
    case 'sum':
      aggregatedValue = values.reduce((acc, v) => acc + v, 0)
      break
    case 'mean': {
      const s = values.reduce((acc, v) => acc + v, 0)
      aggregatedValue = s / values.length
      break
    }
    case 'min':
      aggregatedValue = min(values)
      break
    case 'max':
      aggregatedValue = max(values)
      break
    default:
      throw new Error(`Opérateur inconnu: ${operator}`)
  }

  const result = {value: aggregatedValue}

  if (allRemarks.length > 0) {
    const uniqueRemarks = deduplicateAndLimitRemarks(allRemarks, 10)
    if (uniqueRemarks.length > 0) result.remarks = uniqueRemarks
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

  if (!date || !isValidValue(value)) return []

  const res = {period: date, value}
  if (remark) res.remark = remark
  return [res]
}

/**
 * Agrège spatialement les valeurs d'une période.
 */
export function aggregateSpatialValues(items, period, spatialOperator, temporalOperator) {
  if (spatialOperator === null) {
    if (items.length === 1) {
      const it = items[0]
      const result = {date: period, value: it.value}
      if (it.remarks) result.remarks = it.remarks
      return result
    }

    const aggregated = applyAggregationOperator(items, temporalOperator)
    if (aggregated !== null) {
      const result = {date: period, value: aggregated.value}
      if (aggregated.remarks) result.remarks = aggregated.remarks
      return result
    }

    return null
  }

  const aggregated = applyAggregationOperator(items, spatialOperator)
  if (aggregated !== null) {
    const result = {date: period, value: aggregated.value}
    if (aggregated.remarks) result.remarks = aggregated.remarks
    return result
  }

  return null
}

function aggregateValuesByDate(valuesBySeriesId, seriesList, aggregationContext) {
  const {spatialOperator, temporalOperator} = aggregationContext
  const valuesByPeriod = new Map()

  for (const series of seriesList) {
    const seriesId = series.id
    const seriesData = valuesBySeriesId.get(seriesId)
    if (!seriesData) continue

    const {values: valueDocs} = seriesData

    for (const valueDoc of valueDocs) {
      const extracted = extractValuesFromDocument(valueDoc)

      for (const item of extracted) {
        const {period} = item
        if (!valuesByPeriod.has(period)) valuesByPeriod.set(period, [])
        valuesByPeriod.get(period).push(item)
      }
    }
  }

  const aggregatedValues = []
  for (const [period, items] of valuesByPeriod.entries()) {
    const result = aggregateSpatialValues(items, period, spatialOperator, temporalOperator)
    if (result !== null) aggregatedValues.push(result)
  }

  aggregatedValues.sort((a, b) => a.date.localeCompare(b.date))
  return aggregatedValues
}

export function extractPeriod(date, frequency) {
  if (frequency === '1 month') return date.slice(0, 7)
  if (frequency === '1 quarter') {
    const year = date.slice(0, 4)
    const month = Number.parseInt(date.slice(5, 7), 10)
    const quarter = Math.ceil(month / 3)
    return `${year}-Q${quarter}`
  }
  if (frequency === '1 year') return date.slice(0, 4)
  return date
}

export function aggregateDailyValuesToPeriod(dailyValues, frequency, operator) {
  if (frequency === '1 day') return dailyValues

  const valuesByPeriod = new Map()
  for (const item of dailyValues) {
    const period = extractPeriod(item.date, frequency)
    if (!valuesByPeriod.has(period)) valuesByPeriod.set(period, [])
    valuesByPeriod.get(period).push(item)
  }

  const aggregatedValues = []
  for (const [period, items] of valuesByPeriod.entries()) {
    const aggregated = applyAggregationOperator(items, operator)
    if (aggregated !== null) {
      const result = {date: period, value: aggregated.value}
      if (aggregated.remarks) result.remarks = aggregated.remarks
      aggregatedValues.push(result)
    }
  }

  aggregatedValues.sort((a, b) => a.date.localeCompare(b.date))
  return aggregatedValues
}

/**
 * Fetch values + detect overlap (doublons sur même point+date)
 */
async function fetchAllSeriesValues(seriesList, startDate, endDate) {
  const valuesBySeriesId = new Map()

  // Pour détecter overlap: key = `${pointId}:${date}` count>1 dans le scope
  const pointDateCounts = new Map()

  await Promise.all(
    seriesList.map(async series => {
      const values = await getSeriesValuesInRange(series.id, {startDate, endDate})
      valuesBySeriesId.set(series.id, {values})

      // overlap detection
      const pointId = series?.computed?.point
      if (pointId) {
        for (const v of values) {
          const date = v.date
          if (!date) continue
          const k = `${pointId}:${date}`
          pointDateCounts.set(k, (pointDateCounts.get(k) || 0) + 1)
        }
      }
    })
  )

  const hasOverlap = [...pointDateCounts.values()].some(c => c > 1)
  return {valuesBySeriesId, hasOverlap}
}

function buildAggregationMetadata({
                                    metricTypeCode,
                                    unit,
                                    spatialOperator,
                                    temporalOperator,
                                    aggregationFrequency,
                                    pointIdsStr,
                                    preleveurId,
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
    ...(preleveurId ? {preleveurId} : {})
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
async function resolvePointsAndSeries({sourceId, pointIdsStr, preleveurId, metricTypeCode, startDate, endDate}) {
  const {resolvedPoints, notFound} = await resolvePointsForAggregation({pointIdsStr, preleveurId})
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

// eslint-disable-next-line complexity
export async function getAggregatedSeriesHandler(req, res) {
  const validated = validateQueryParams(req.query)

  const {
    pointIds: pointIdsStr,
    preleveurId,
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

  // validate temporal operator always
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
    metricTypeCode,
    startDate,
    endDate
  })

  // no series => empty
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
        sourceId,
        resolvedPoints,
        notFound,
        startDate,
        endDate
      }),
      values: []
    })
  }

  // validate spatial operator when supported
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

  // fetch values + overlap detection (per point+day duplicates)
  const {valuesBySeriesId, hasOverlap} = await fetchAllSeriesValues(seriesList, startDate, endDate)

  // overlap rule: if duplicates exist and spatial op is not sum => reject
  if (hasOverlap && spatialOperator !== 'sum') {
    throw createHttpError(
      400,
      'Agrégation spatiale impossible: des doublons existent sur les mêmes dates pour au moins un point. '
      + 'Utilisez spatialOperator=sum ou réduisez le scope (source/points/date).'
    )
  }

  const aggregatedByDay = aggregateValuesByDate(valuesBySeriesId, seriesList, {
    spatialOperator: parameterConfig.spatialOperators.length > 0 ? spatialOperator : null,
    temporalOperator
  })

  const aggregatedValues = aggregateDailyValuesToPeriod(aggregatedByDay, aggregationFrequency, temporalOperator)

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
