import Joi from 'joi'
import {resourceIdSchema} from '../validation/resource-id.js'
import createHttpError from 'http-errors'
import {Prisma} from '@prisma/client'

import {prisma} from '../../db/prisma.js'
import {parametersConfig} from '../parameters-config.js'
import {withRequestPerformancePhase} from '../util/request-performance.js'
import {
  getCompatibleMetricTypeCodes,
  METRIC_TYPE_CODES,
  inferFlowTypeFromLegacyMetricTypeCode,
  normalizeMetricTypeCode
} from '../constants/metric-type-codes.js'
import {POINT_FLOW_TYPES} from '../constants/point-flow-types.js'
import {listMeterReadingSeriesOptions} from '../models/meter-reading-series.js'
import {buildAggregationChunkScope} from '../models/aggregation-scope.js'

import {
  resolvePointsForAggregation,
  scopeResolvedPointsForAggregation
} from './series-aggregation.js'

function validateUuidList(value, helpers) {
  const ids = value.split(',')
  const uuidSchema = resourceIdSchema
  for (const id of ids) {
    const {error} = uuidSchema.validate(id)
    if (error) {
      return helpers.error('any.invalid')
    }
  }

  return value
}

const optionsQuerySchema = Joi.object({
  view: Joi.string().valid('chart'),
  detail: Joi.string().valid('summary').when('view', {is: 'chart', otherwise: Joi.forbidden()}),
  exploitationId: resourceIdSchema,
  includeExploitationIndexes: Joi.boolean().optional(),
  includeMeterReadings: Joi.boolean(),
  pointIds: Joi.string()
    .custom(validateUuidList)
    .messages({
      'string.base': 'Le paramètre pointIds doit être une chaîne de caractères',
      'string.empty': 'Le paramètre pointIds ne peut pas être vide',
      'any.invalid': 'Le paramètre pointIds doit être une liste d\'UUID v4 ou v5 séparés par des virgules'
    }),

  preleveurId: resourceIdSchema
    .messages({
      'string.guid': 'Le paramètre preleveurId doit être un UUID v4 ou v5 valide'
    }),

  collecteurId: resourceIdSchema
    .messages({
      'string.guid': 'Le paramètre collecteurId doit être un UUID v4 ou v5 valide'
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

export function buildAggregationOptionsPayload({groupedBySeries, resolvedPoints, includeExploitationIndexes = false, view}) {
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
    const exploitationId = includeExploitationIndexes && metricTypeCode === METRIC_TYPE_CODES.INDEX ? g.exploitationId : null
    const k = `${metricTypeCode}:${flowType ?? ''}${exploitationId ? `:exploitation:${exploitationId}` : ''}`
    const prev = byMetric.get(k) ?? {
      id: k,
      exploitationId,
      countingCode: g.countingCode,
      pointName: g.pointName,
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
        id: item.id,
        ...(item.exploitationId ? {exploitationId: item.exploitationId, countingCode: item.countingCode ?? null} : {}),
        name: item.metricTypeCode,
        label: getParameterLabel(
          item.metricTypeCode,
          item.flowType,
          config.label ?? item.metricTypeCode
        ) + (item.exploitationId ? ` — ${item.pointName || 'Point'} — ${item.countingCode ? `Comptage ${item.countingCode}` : `Exploitation ${item.exploitationId.slice(0, 8)}`}` : ''),
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

  if (view === 'chart') {
    return {parameters}
  }

  const points = resolvedPoints.map(rp => ({
    id: rp.id,
    name: rp.point.name,
    flowType: rp.point.flowType ?? null
  }))

  return {parameters, points}
}

export function buildAggregationOptionGroupsQuery({pointIds = [], sourceId, user, preleveurId, collecteurId, exploitationId, includeExploitationIndexes = true, detail}) {
  const scope = buildAggregationChunkScope({pointIds, sourceId, user, preleveurId, collecteurId, exploitationId})
  const indexMetricCodes = Prisma.join(getCompatibleMetricTypeCodes(METRIC_TYPE_CODES.INDEX))
  const detailedIndexes = includeExploitationIndexes && detail !== 'summary'
  const exploitationColumns = detailedIndexes
    ? Prisma.sql`
      CASE WHEN cv."metricTypeCode" IN (${indexMetricCodes}) THEN c."exploitationId" END AS "exploitationId",
      CASE WHEN cv."metricTypeCode" IN (${indexMetricCodes}) THEN exploitation."countingCode" END AS "countingCode",
      CASE WHEN cv."metricTypeCode" IN (${indexMetricCodes}) THEN point.name END AS "pointName"`
    : Prisma.sql`NULL::uuid AS "exploitationId", NULL::text AS "countingCode", NULL::text AS "pointName"`

  // Un chunk appartient à un seul point et une seule exploitation. En conservant
  // la métrique brute et l'unité, DISTINCT chunkId reproduit la somme des anciens
  // groupes, y compris lorsqu'un chunk contient plusieurs unités ou alias.

  return Prisma.sql`
    ${scope.ctes === Prisma.empty ? Prisma.empty : Prisma.sql`WITH ${scope.ctes}`}
    SELECT
      cv."metricTypeCode",
      cv.unit,
      ${exploitationColumns},
      COALESCE(c."flowType", point."flowType")::text AS "flowType",
      min(CASE WHEN c."calculationStrategy" = 'METER' AND cv.frequency = 'irregular'
        THEN cv."periodStart" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Paris' ELSE cv."periodStart" END) AS "minPeriodStart",
      min(CASE WHEN c."calculationStrategy" = 'METER' AND cv.frequency = 'irregular'
        THEN cv."periodEnd" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Paris' ELSE cv."periodEnd" END) AS "minPeriodEnd",
      max(CASE WHEN c."calculationStrategy" = 'METER' AND cv.frequency = 'irregular'
        THEN cv."periodEnd" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Paris' ELSE cv."periodEnd" END) AS "maxPeriodEnd",
      count(DISTINCT cv."chunkId")::int AS "seriesCount"
    FROM "ChunkValue" cv
    JOIN "Chunk" c ON c.id = cv."chunkId"
    JOIN "Source" source ON source.id = c."sourceId"
    LEFT JOIN "PointPrelevement" point ON point.id = c."pointPrelevementId"
    ${detailedIndexes
      ? Prisma.sql`LEFT JOIN "DeclarantPointPrelevement" exploitation ON exploitation.id = c."exploitationId"`
      : Prisma.empty}
    WHERE ${scope.where}
      ${detail === 'summary' ? Prisma.sql`AND cv."metricTypeCode" NOT IN (${indexMetricCodes})` : Prisma.empty}
    GROUP BY 1, 2, 3, 4, 5, 6
    ORDER BY
      1,
      2 NULLS FIRST,
      6 NULLS FIRST
  `
}

export async function listAggregationOptionGroups({
  client = prisma,
  pointIds = [],
  sourceId,
  user,
  preleveurId,
  collecteurId,
  exploitationId,
  // Internal callers historically receive index dimensions and choose their
  // presentation later in buildAggregationOptionsPayload.
  includeExploitationIndexes = true,
  detail
}) {
  return client.$queryRaw(buildAggregationOptionGroupsQuery({pointIds, sourceId, user, preleveurId, collecteurId, exploitationId, includeExploitationIndexes, detail}))
}

/**
 * Handler Express
 */
export async function getAggregatedSeriesOptionsHandler(req, res) {
  const validated = validateOptionsQueryParams(req.query)
  const {pointIds: pointIdsStr, preleveurId, collecteurId, sourceId, exploitationId, includeExploitationIndexes, view, detail} = validated

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
      collecteurId,
      sourceId
    })
  )
  const pointIds = resolvedPoints.map(rp => rp.id)
  const hasPointBoundScope = Boolean(pointIdsStr || preleveurId || collecteurId)

  if (hasPointBoundScope && pointIds.length === 0) {
    const empty = buildAggregationOptionsPayload({groupedBySeries: [], resolvedPoints, view})
    if (detail === 'summary') empty.detailsDeferred = false
    return res.json(empty)
  }

  const groupedBySeries = await withRequestPerformancePhase(
    'aggregation_options_query',
    () => listAggregationOptionGroups({pointIds, sourceId, user: req.user, preleveurId, collecteurId, exploitationId, includeExploitationIndexes: Boolean(includeExploitationIndexes), detail})
  )
  const payload = withRequestPerformancePhase(
    'aggregation_options_serialize',
    () => buildAggregationOptionsPayload({groupedBySeries, resolvedPoints, includeExploitationIndexes, view})
  )

  if (detail === 'summary') payload.detailsDeferred = true
  if (detail !== 'summary' && validated.includeMeterReadings && req.user?.role === 'ADMIN' && !req.serviceAccount) {
    payload.parameters.push(...await listMeterReadingSeriesOptions({
      user: req.user, sourceId, pointIds, preleveurId, collecteurId, exploitationId
    }))
  }

  res.json(payload)
}
