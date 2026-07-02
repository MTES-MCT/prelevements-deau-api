import Joi from 'joi'
import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {NON_REJECTED_CHUNK_INSTRUCTION_STATUSES} from '../constants/chunk-statuses.js'
import {parametersConfig} from '../parameters-config.js'

import {resolvePointsForAggregation} from './series-aggregation.js'

function validateUuidList(value, helpers) {
  const ids = value.split(',')
  const uuidSchema = Joi.string().uuid({version: 'uuidv4'})
  for (const id of ids) {
    const {error} = uuidSchema.validate(id)
    if (error) {
      return helpers.error('any.invalid')
    }
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

  collecteurId: Joi.string()
    .uuid({version: 'uuidv4'})
    .messages({
      'string.guid': 'Le paramètre collecteurId doit être un UUID v4 valide'
    }),

  sourceId: Joi.string()
    .uuid({version: 'uuidv4'})
    .messages({
      'string.guid': 'Le paramètre sourceId doit être un UUID v4 valide'
    })
})
  .or('pointIds', 'preleveurId', 'collecteurId', 'sourceId')
  .messages({
    'object.missing': 'Vous devez fournir au moins pointIds, preleveurId, collecteurId ou sourceId'
  })

export function validateOptionsQueryParams(query) {
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
  if (!date) {
    return null
  }

  return date.toISOString().slice(0, 10)
}

export function buildAggregationOptionsPayload({groupedBySeries, resolvedPoints}) {
  // Agréger par metricTypeCode seul pour min/max et comptage : évite des entrées
  // dupliquées (ex. unité vide vs m³) avec des plages différentes, ce qui coupait
  // la fenêtre temporelle côté front (volume prélevé déclaré vs calculé).
  const byMetric = new Map()
  for (const g of groupedBySeries) {
    const k = g.metricTypeCode
    const prev = byMetric.get(k) ?? {
      metricTypeCode: g.metricTypeCode,
      unit: g.unit ?? null,
      minDate: null,
      maxDate: null,
      seriesCount: 0
    }

    prev.seriesCount += 1

    const minD = g._min.periodEnd
    const maxD = g._max.periodEnd

    if (!prev.minDate || (minD && minD < prev.minDate)) {
      prev.minDate = minD
    }

    if (!prev.maxDate || (maxD && maxD > prev.maxDate)) {
      prev.maxDate = maxD
    }

    if (!prev.unit && g.unit) {
      prev.unit = g.unit
    }

    byMetric.set(k, prev)
  }

  const parameters = [...byMetric.values()]
    .map(item => {
      const config = parametersConfig[item.metricTypeCode]
      if (!config) {
        return null
      }

      return {
        name: item.metricTypeCode,
        label: config.label ?? item.metricTypeCode,
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
        availableFrequencies: config.availableFrequencies ?? []
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name))

  const points = resolvedPoints.map(rp => ({
    id: rp.id,
    name: rp.point.name
  }))

  return {parameters, points}
}

/**
 * Handler Express
 */
export async function getAggregatedSeriesOptionsHandler(req, res) {
  const validated = validateOptionsQueryParams(req.query)
  const {pointIds: pointIdsStr, preleveurId, collecteurId, sourceId} = validated

  // Resolve points (Prisma points) — inclut le cas sourceId-only
  const {resolvedPoints} = await resolvePointsForAggregation({pointIdsStr, preleveurId, collecteurId, sourceId})
  const pointIds = resolvedPoints.map(rp => rp.id)
  const hasPointBoundScope = Boolean(pointIdsStr || preleveurId || collecteurId)

  if (hasPointBoundScope && pointIds.length === 0) {
    return res.json(buildAggregationOptionsPayload({groupedBySeries: [], resolvedPoints}))
  }

  // Scope ChunkValue via relation chunk (sourceId + pointIds)
  const where = {
    chunk: {
      instructionStatus: {in: NON_REJECTED_CHUNK_INSTRUCTION_STATUSES},
      ...(pointIds?.length ? {pointPrelevementId: {in: pointIds}} : {}),
      ...(sourceId ? {sourceId} : {}),
      source: {
        status: 'COMPLETED'
      }
    }
  }

  /**
   * On veut :
   * - minDate / maxDate par metricTypeCode (+unit)
   * - seriesCount = nb de séries distinctes (ici: nb de chunkId distincts) pour ce metric
   *
   * => 1) groupBy (metricTypeCode, unit, chunkId) + min/max(periodEnd)
   * => 2) reduce en (metricTypeCode, unit)
   */
  const groupedBySeries = await prisma.chunkValue.groupBy({
    by: ['metricTypeCode', 'unit', 'chunkId'],
    where,
    _min: {periodEnd: true},
    _max: {periodEnd: true}
  })

  res.json(buildAggregationOptionsPayload({groupedBySeries, resolvedPoints}))
}
