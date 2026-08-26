import Joi from 'joi'
import createHttpError from 'http-errors'
import {Prisma} from '@prisma/client'

import {prisma} from '../../db/prisma.js'
import {NON_REJECTED_CHUNK_INSTRUCTION_STATUSES} from '../constants/chunk-statuses.js'
import {parametersConfig} from '../parameters-config.js'
import {withRequestPerformancePhase} from '../util/request-performance.js'
import {
  METRIC_TYPE_CODES,
  inferFlowTypeFromLegacyMetricTypeCode,
  normalizeMetricTypeCode
} from '../constants/metric-type-codes.js'
import {POINT_FLOW_TYPES} from '../constants/point-flow-types.js'

import {
  resolvePointsForAggregation,
  scopeResolvedPointsForAggregation
} from './series-aggregation.js'

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

function toLastCoveredYMD(date) {
  if (!date) {
    return null
  }

  return toYMD(new Date(date.getTime() - 1))
}

function getParameterLabel(metricTypeCode, flowType, fallbackLabel) {
  if (!flowType) {
    return fallbackLabel
  }

  const isRejection = flowType === POINT_FLOW_TYPES.REJET
  if (metricTypeCode === METRIC_TYPE_CODES.VOLUME) {
    return `Volume ${isRejection ? 'rejeté' : 'prélevé'}`
  }

  if (metricTypeCode === METRIC_TYPE_CODES.DEBIT) {
    return `Débit ${isRejection ? 'rejeté' : 'prélevé'}`
  }

  if (metricTypeCode === METRIC_TYPE_CODES.INDEX) {
    return `Index de ${isRejection ? 'rejet' : 'prélèvement'}`
  }

  return fallbackLabel
}

function getAggregationGroupSummary(group, isCumulative) {
  const seriesCount = Number(group.seriesCount ?? 1)
  const minPeriodStart = group.minPeriodStart ?? group._min?.periodStart
  const minPeriodEnd = group.minPeriodEnd ?? group._min?.periodEnd

  return {
    maxDate: group.maxPeriodEnd ?? group._max?.periodEnd,
    minDate: isCumulative ? minPeriodStart : minPeriodEnd,
    seriesCount: Number.isFinite(seriesCount) ? seriesCount : 0
  }
}

export function buildAggregationOptionsPayload({groupedBySeries, resolvedPoints}) {
  // Agréger par type de mesure et type de point pour ne pas confondre
  // prélèvements et rejets portant le même type de mesure.
  // dupliquées (ex. unité vide vs m³) avec des plages différentes, ce qui coupait
  // la fenêtre temporelle côté front (volume prélevé déclaré vs calculé).
  const byMetric = new Map()
  for (const g of groupedBySeries) {
    const metricTypeCode = normalizeMetricTypeCode(g.metricTypeCode)
    const config = parametersConfig[metricTypeCode]
    const isCumulative = config?.valueType === 'cumulative'
    const flowType = g.flowType ?? inferFlowTypeFromLegacyMetricTypeCode(g.metricTypeCode)
    const k = `${metricTypeCode}:${flowType ?? ''}`
    const prev = byMetric.get(k) ?? {
      metricTypeCode,
      flowType,
      unit: g.unit ?? null,
      minDate: null,
      maxDate: null,
      isCumulative,
      seriesCount: 0
    }

    const summary = getAggregationGroupSummary(g, isCumulative)
    prev.seriesCount += summary.seriesCount

    if (!prev.minDate || (summary.minDate && summary.minDate < prev.minDate)) {
      prev.minDate = summary.minDate
    }

    if (!prev.maxDate || (summary.maxDate && summary.maxDate > prev.maxDate)) {
      prev.maxDate = summary.maxDate
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
        id: `${item.metricTypeCode}:${item.flowType ?? ''}`,
        name: item.metricTypeCode,
        label: getParameterLabel(
          item.metricTypeCode,
          item.flowType,
          config.label ?? item.metricTypeCode
        ),
        flowType: item.flowType,
        unit: item.unit || config.unit || null,
        valueType: config.valueType,
        spatialOperators: config.spatialOperators,
        temporalOperators: config.temporalOperators,
        defaultSpatialOperator: config.defaultSpatialOperator,
        defaultTemporalOperator: config.defaultTemporalOperator,
        warning: config.warning,
        hasTemporalOverlap: false,
        minDate: toYMD(item.minDate),
        maxDate: item.isCumulative
          ? toLastCoveredYMD(item.maxDate)
          : toYMD(item.maxDate),
        seriesCount: item.seriesCount,
        availableFrequencies: config.availableFrequencies ?? []
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name))

  const points = resolvedPoints.map(rp => ({
    id: rp.id,
    name: rp.point.name,
    flowType: rp.point.flowType ?? null
  }))

  return {parameters, points}
}

function getUuidListSql(ids) {
  return Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))
}

function getPointScopeSql(pointIds) {
  return pointIds.length > 0
    ? Prisma.sql`AND c."pointPrelevementId" IN (${getUuidListSql(pointIds)})`
    : Prisma.sql``
}

function getSourceScopeSql(sourceId) {
  return sourceId
    ? Prisma.sql`AND c."sourceId" = ${sourceId}::uuid`
    : Prisma.sql``
}

export function buildAggregationOptionGroupsQuery({pointIds = [], sourceId}) {
  const instructionStatuses = Prisma.join(
    NON_REJECTED_CHUNK_INSTRUCTION_STATUSES.map(status =>
      Prisma.sql`${status}::"ChunkInstructionStatus"`
    )
  )

  return Prisma.sql`
    SELECT
      cv."metricTypeCode",
      cv.unit,
      COALESCE(c."flowType", point."flowType")::text AS "flowType",
      min(cv."periodStart") AS "minPeriodStart",
      min(cv."periodEnd") AS "minPeriodEnd",
      max(cv."periodEnd") AS "maxPeriodEnd",
      count(DISTINCT cv."chunkId")::int AS "seriesCount"
    FROM "ChunkValue" cv
    JOIN "Chunk" c ON c.id = cv."chunkId"
    JOIN "Source" source ON source.id = c."sourceId"
    LEFT JOIN "PointPrelevement" point ON point.id = c."pointPrelevementId"
    WHERE c."instructionStatus" IN (${instructionStatuses})
      AND source.status = 'COMPLETED'::"SourceStatus"
      ${getPointScopeSql(pointIds)}
      ${getSourceScopeSql(sourceId)}
    GROUP BY
      cv."metricTypeCode",
      cv.unit,
      COALESCE(c."flowType", point."flowType")
    ORDER BY
      cv."metricTypeCode",
      cv.unit NULLS FIRST,
      COALESCE(c."flowType", point."flowType") NULLS FIRST
  `
}

export async function listAggregationOptionGroups({
  client = prisma,
  pointIds = [],
  sourceId
}) {
  return client.$queryRaw(buildAggregationOptionGroupsQuery({pointIds, sourceId}))
}

/**
 * Handler Express
 */
export async function getAggregatedSeriesOptionsHandler(req, res) {
  const validated = validateOptionsQueryParams(req.query)
  const {pointIds: pointIdsStr, preleveurId, collecteurId, sourceId} = validated

  // Resolve points (Prisma points) — inclut le cas sourceId-only
  const {resolvedPoints: allResolvedPoints} = await withRequestPerformancePhase(
    'aggregation_options_resolve',
    () => resolvePointsForAggregation({pointIdsStr, preleveurId, collecteurId, sourceId})
  )
  const resolvedPoints = await withRequestPerformancePhase(
    'aggregation_options_scope',
    () => scopeResolvedPointsForAggregation({
      user: req.user,
      resolvedPoints: allResolvedPoints,
      permittedZoneIds: req.permittedZoneIds,
      pointIdsStr,
      preleveurId,
      collecteurId
    })
  )
  const pointIds = resolvedPoints.map(rp => rp.id)
  const hasPointBoundScope = Boolean(pointIdsStr || preleveurId || collecteurId)

  if (hasPointBoundScope && pointIds.length === 0) {
    return res.json(buildAggregationOptionsPayload({groupedBySeries: [], resolvedPoints}))
  }

  const groupedBySeries = await withRequestPerformancePhase(
    'aggregation_options_query',
    () => listAggregationOptionGroups({pointIds, sourceId})
  )
  const payload = withRequestPerformancePhase(
    'aggregation_options_serialize',
    () => buildAggregationOptionsPayload({groupedBySeries, resolvedPoints})
  )

  res.json(payload)
}
