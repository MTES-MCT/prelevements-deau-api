// Handlers/series.js
import Joi from 'joi'
import moment from 'moment'
import createHttpError from 'http-errors'
import {resourceIdSchema} from '../validation/resource-id.js'
import {prisma} from '../../db/prisma.js'

import {
  decodeSeriesId,
  listSeries,
  getSeriesById,
  getSeriesValuesInRange
} from '../models/series.js'
import {
  getChunkZoneIds,
  getDeclarantZoneIds,
  getPointZoneIds,
  getSourceZoneIds,
  hasZonePermission
} from '../services/zone-permissions.js'

async function assertSeriesScope(user, {
  chunkId,
  pointId,
  preleveurId,
  sourceId
}) {
  if (user.role === 'ADMIN') {
    return
  }

  const scopes = await Promise.all([
    chunkId ? getChunkZoneIds(chunkId) : null,
    pointId ? getPointZoneIds(pointId) : null,
    preleveurId ? getDeclarantZoneIds(preleveurId) : null,
    sourceId ? getSourceZoneIds(sourceId) : null
  ].filter(Boolean))

  const allowedScopes = await Promise.all(
    scopes.map(zoneIds => hasZonePermission(user, 'pp.volumes.read', zoneIds))
  )

  if (allowedScopes.some(allowed => !allowed)) {
    throw createHttpError(403, 'Vous ne disposez pas du droit de consulter ces mesures.')
  }
}

function validateUuid(label, value, schema = Joi.string().uuid({version: 'uuidv4'})) {
  const {error} = schema.validate(value)

  if (error) {
    throw createHttpError(400, `Paramètre ${label} invalide (UUID attendu)`)
  }

  return value
}

function validateDateParam(label, value) {
  if (!moment(value, 'YYYY-MM-DD', true).isValid()) {
    throw createHttpError(400, `Paramètre ${label} invalide (YYYY-MM-DD attendu)`)
  }

  return value
}

function parseSeriesIdOrThrow(seriesId) {
  if (!seriesId || typeof seriesId !== 'string') {
    throw createHttpError(400, 'Identifiant de série invalide')
  }

  const decoded = decodeSeriesId(seriesId)

  if (!decoded) {
    throw createHttpError(400, 'Identifiant de série invalide')
  }

  if (!decoded.chunkId || !decoded.metricTypeCode) {
    throw createHttpError(400, 'Identifiant de série invalide')
  }

  validateUuid('chunkId', decoded.chunkId)

  return decoded
}

const listSeriesQuerySchema = Joi.object({
  preleveurId: resourceIdSchema,
  pointId: resourceIdSchema,
  sourceId: Joi.string().uuid({version: 'uuidv4'}),
  metricTypeCode: Joi.string(),
  startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
  endDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
})
  .or('preleveurId', 'pointId', 'sourceId')
  .messages({
    'object.missing': 'Au moins un critère preleveurId, pointId ou sourceId est requis'
  })

export function validateListSeriesQuery(query) {
  const {error, value} = listSeriesQuerySchema.validate(query, {
    abortEarly: false,
    stripUnknown: true
  })

  if (error) {
    const messages = error.details.map(detail => detail.message)
    throw createHttpError(400, messages.join('. '))
  }

  return value
}

const seriesValuesQuerySchema = Joi.object({
  startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
  endDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
})

function validateSeriesValuesQuery(query) {
  const {error, value} = seriesValuesQuerySchema.validate(query, {
    abortEarly: false,
    stripUnknown: true
  })

  if (error) {
    const messages = error.details.map(detail => detail.message)
    throw createHttpError(400, messages.join('. '))
  }

  return value
}

function mapSeriesMetadata(series) {
  return {
    id: series.id,
    metricTypeCode: series.parameter,
    unit: series.unit,
    frequency: series.frequency,
    ...(series.compteurId ? {compteurId: series.compteurId} : {}),
    ...(series.calculationStrategy === 'METER' ? {calculationStrategy: 'METER'} : {}),
    valueType: series.valueType,
    minDate: series.minDate,
    maxDate: series.maxDate,
    hasSubDaily: false,
    pointPrelevement: series.pointPrelevement || series.computed?.point || null,
    actors: series.actors ?? null
  }
}

/**
 * GET /series?sourceId=...&pointId=...&preleveurId=...&metricTypeCode=...
 */
export async function listSeriesMetadataSearch(req, res) {
  const validated = validateListSeriesQuery(req.query)

  const {
    preleveurId,
    pointId,
    sourceId,
    metricTypeCode,
    startDate,
    endDate
  } = validated

  if (preleveurId) {
    validateUuid('preleveurId', preleveurId, resourceIdSchema)
  }

  if (pointId) {
    validateUuid('pointId', pointId, resourceIdSchema)
  }

  if (sourceId) {
    validateUuid('sourceId', sourceId)
  }

  if (startDate) {
    validateDateParam('startDate', startDate)
  }

  if (endDate) {
    validateDateParam('endDate', endDate)
  }

  if (startDate && endDate && moment(startDate).isAfter(moment(endDate))) {
    throw createHttpError(400, 'startDate doit être <= endDate')
  }

  await assertSeriesScope(req.user, {pointId, preleveurId, sourceId})

  // The legacy source check accepts any shared territory. A shared meter source
  // must nevertheless expose only the chunks inside the instructor's own zones.
  const meterPointIds = req.user.role === 'INSTRUCTOR'
    ? (await prisma.pointPrelevementZone.findMany({
      where: {zoneId: {in: req.permittedZoneIds ?? []}},
      select: {pointPrelevementId: true}, distinct: ['pointPrelevementId']
    })).map(row => row.pointPrelevementId)
    : undefined
  const series = await listSeries({
    user: req.user,
    meterPointIds,
    sourceId: sourceId || undefined,
    pointIds: pointId ? [pointId] : undefined,
    preleveurId: preleveurId || undefined,
    parameter: metricTypeCode || undefined,
    startDate: startDate || undefined,
    endDate: endDate || undefined
  })

  res.send({
    series: series.map(mapSeriesMetadata)
  })
}

/**
 * GET /series/:seriesId/values?startDate=...&endDate=...
 */
export async function getSeriesValuesHandler(req, res) {
  const {chunkId} = parseSeriesIdOrThrow(req.params.seriesId)
  await assertSeriesScope(req.user, {chunkId})

  const validated = validateSeriesValuesQuery(req.query)
  const {startDate, endDate} = validated

  if (startDate) {
    validateDateParam('startDate', startDate)
  }

  if (endDate) {
    validateDateParam('endDate', endDate)
  }

  if (startDate && endDate && moment(startDate).isAfter(moment(endDate))) {
    throw createHttpError(400, 'startDate doit être <= endDate')
  }

  const series = await getSeriesById(req.params.seriesId)
  if (!series) {
    throw createHttpError(404, 'Série introuvable')
  }

  const values = await getSeriesValuesInRange(req.params.seriesId, {startDate, endDate})

  res.send({
    series: mapSeriesMetadata(series),
    values: values.map(value => ({
      date: value.date,
      ...(value.calculationStrategy === 'METER' ? {
        periodStart: value.periodStart,
        periodEnd: value.periodEnd,
        compteurId: value.compteurId,
        calculationStrategy: 'METER'
      } : {}),
      ...value.values
    }))
  })
}

/**
 * GET /series/:seriesId
 */
export async function getSeriesMetadataHandler(req, res) {
  const {chunkId} = parseSeriesIdOrThrow(req.params.seriesId)
  await assertSeriesScope(req.user, {chunkId})

  const series = await getSeriesById(req.params.seriesId)
  if (!series) {
    throw createHttpError(404, 'Série introuvable')
  }

  res.send({
    series: mapSeriesMetadata(series)
  })
}
