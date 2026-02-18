// series-aggregation-options.js
import Joi from 'joi'
import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {parametersConfig} from '../parameters-config.js'

import {
  resolvePointsForAggregation
} from './series-aggregation.js'

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

function normalizeDateOnly(input) {
  const d = input instanceof Date ? input : new Date(input)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/**
 * Handler Express
 */
export async function getAggregatedSeriesOptionsHandler(req, res) {
  const validated = validateQueryParams(req.query)
  const {pointIds: pointIdsStr, preleveurId, sourceId} = validated

  // resolve points (Prisma points)
  const {resolvedPoints} = await resolvePointsForAggregation({pointIdsStr, preleveurId})
  const pointIds = resolvedPoints.map(rp => rp.id)

  // group metrics by metricTypeCode + unit within scope
  const where = {
    ...(pointIds?.length ? {pointPrelevementId: {in: pointIds}} : {}),
    ...(sourceId ? {sourceId} : {})
  }

  const grouped = await prisma.metric.groupBy({
    by: ['metricTypeCode', 'unit'],
    where,
    _min: {startDate: true},
    _max: {endDate: true},
    _count: {_all: true}
  })

  const parameters = grouped
    .map(g => {
      const config = parametersConfig[g.metricTypeCode]
      if (!config) return null

      return {
        name: g.metricTypeCode,
        unit: g.unit || config.unit || null,
        valueType: config.valueType,
        spatialOperators: config.spatialOperators,
        temporalOperators: config.temporalOperators,
        defaultSpatialOperator: config.defaultSpatialOperator,
        defaultTemporalOperator: config.defaultTemporalOperator,
        warning: config.warning,
        hasTemporalOverlap: false, // overlap est géré au moment de l'agrégation
        minDate: toYMD(g._min.startDate),
        maxDate: toYMD(g._max.endDate),
        seriesCount: g._count._all,
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
