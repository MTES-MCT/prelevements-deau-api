import Joi from 'joi'
import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {parametersConfig} from '../parameters-config.js'

import {resolvePointsForAggregation} from './series-aggregation.js'

function validateUuidList(value, helpers) {
  const ids = value.split(',')
  const uuidSchema = Joi.string().uuid({version: 'uuidv4'})
  for (const id of ids) {
    const {error} = uuidSchema.validate(id)
    if (error) return helpers.error('any.invalid')
  }
  return value
}

const optionsQuerySchema = Joi.object({
  pointIds: Joi.string()
    .custom(validateUuidList)
    .messages({
      'string.base': 'Le paramètre pointIds doit être une chaîne de caractères',
      'string.empty': 'Le paramètre pointIds ne peut pas être vide',
      'any.invalid': 'Le paramètre pointIds doit être une liste d\'UUID v4 séparés par des virgules'
    }),

  preleveurId: Joi.string()
    .uuid({version: 'uuidv4'})
    .messages({
      'string.guid': 'Le paramètre preleveurId doit être un UUID v4 valide'
    }),

  sourceId: Joi.string()
    .uuid({version: 'uuidv4'})
    .messages({
      'string.guid': 'Le paramètre sourceId doit être un UUID v4 valide'
    })
})
  .or('pointIds', 'preleveurId', 'sourceId')
  .messages({
    'object.missing': 'Vous devez fournir au moins pointIds, preleveurId ou sourceId'
  })

function validateQueryParams(query) {
  const {error, value} = optionsQuerySchema.validate(query, {
    abortEarly: false,
    stripUnknown: true
  })

  if (error) {
    const messages = error.details.map(d => d.message)
    throw createHttpError(400, messages.join('. '))
  }

  return value
}

function toYMD(date) {
  if (!date) return null
  return date.toISOString().slice(0, 10)
}

/**
 * Handler Express
 */
export async function getAggregatedSeriesOptionsHandler(req, res) {
  const validated = validateQueryParams(req.query)
  const {pointIds: pointIdsStr, preleveurId, sourceId} = validated

  // resolve points (Prisma points) — inclut le cas sourceId-only
  const {resolvedPoints} = await resolvePointsForAggregation({pointIdsStr, preleveurId, sourceId})
  const pointIds = resolvedPoints.map(rp => rp.id)

  // Scope ChunkValue via relation chunk (sourceId + pointIds)
  const where = {
    chunk: {
      ...(pointIds?.length ? {pointPrelevementId: {in: pointIds}} : {}),
      ...(sourceId ? {sourceId} : {})
    }
  }

  /**
   * On veut :
   * - minDate / maxDate par metricTypeCode (+unit)
   * - seriesCount = nb de séries distinctes (ici: nb de chunkId distincts) pour ce metric
   *
   * => 1) groupBy (metricTypeCode, unit, chunkId) + min/max(date)
   * => 2) reduce en (metricTypeCode, unit)
   */
  const groupedBySeries = await prisma.chunkValue.groupBy({
    by: ['metricTypeCode', 'unit', 'chunkId'],
    where,
    _min: {date: true},
    _max: {date: true}
  })

  const byMetric = new Map()
  for (const g of groupedBySeries) {
    const k = `${g.metricTypeCode}||${g.unit ?? ''}`
    const prev = byMetric.get(k) ?? {
      metricTypeCode: g.metricTypeCode,
      unit: g.unit ?? null,
      minDate: null,
      maxDate: null,
      seriesCount: 0
    }

    prev.seriesCount += 1

    const minD = g._min.date
    const maxD = g._max.date

    if (!prev.minDate || (minD && minD < prev.minDate)) {
      prev.minDate = minD
    }
    if (!prev.maxDate || (maxD && maxD > prev.maxDate)) {
      prev.maxDate = maxD
    }

    byMetric.set(k, prev)
  }

  const parameters = [...byMetric.values()]
    .map(item => {
      const config = parametersConfig[item.metricTypeCode]
      if (!config) return null

      return {
        name: item.metricTypeCode,
        unit: item.unit || config.unit || null,
        valueType: config.valueType,
        spatialOperators: config.spatialOperators,
        temporalOperators: config.temporalOperators,
        defaultSpatialOperator: config.defaultSpatialOperator,
        defaultTemporalOperator: config.defaultTemporalOperator,
        warning: config.warning,
        hasTemporalOverlap: false,
        minDate: toYMD(item.minDate),
        maxDate: toYMD(item.maxDate),
        seriesCount: item.seriesCount,
        availableFrequencies: ['1 day', '1 month', '1 quarter', '1 year']
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name))

  const points = resolvedPoints.map(rp => ({
    id: rp.id,
    name: rp.point.name
  }))

  res.json({parameters, points})
}
