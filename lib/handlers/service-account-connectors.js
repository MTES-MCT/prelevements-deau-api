import createHttpError from 'http-errors'
import {randomUUID} from 'node:crypto'
import {prisma} from '../../db/prisma.js'
import {canServiceAccountImpersonateDeclarant} from '../models/service-account-declarant.js'
import {computeGlobalInstructionStatus} from './chunks.js'
import {addJobReconstructVolumesFromIndexForPoint} from '../queues/jobs.js'
import {METRIC_TYPE_CODES} from '../constants/metric-type-codes.js'
import {
  MIN_TIME_STEP_MINUTES,
  computePeriodEnd,
  normalizeTemporalStart,
  isAlignedOnDiscreteStep,
  isDurationAlignedOnDiscreteStep
} from '../util/temporal-discretization.js'

function metricTypeToMetricTypeCode(type) {
  if (type === 'volume_preleve') {
    return METRIC_TYPE_CODES.VOLUME_PRELEVE
  }

  if (type === 'index') {
    return METRIC_TYPE_CODES.INDEX
  }

  return type
}

function hasIndexMetric(metrics) {
  return metrics.some(metric => {
    const type = typeof metric?.type === 'string' ? metric.type.trim().toLowerCase() : ''
    return type === 'index'
  })
}

function getMetricValues(metric) {
  if (!metric || !Array.isArray(metric.values)) {
    return []
  }

  return metric.values
    .map(value => {
      const periodStart = normalizeTemporalStart(value.date)
      const numberValue = Number(value.value)

      if (!periodStart || !Number.isFinite(numberValue)) {
        return null
      }

      if (!isAlignedOnDiscreteStep(periodStart, MIN_TIME_STEP_MINUTES)) {
        return null
      }

      if (!isDurationAlignedOnDiscreteStep(metric.granularity, MIN_TIME_STEP_MINUTES)) {
        return null
      }

      return {
        periodStart,
        periodEnd: computePeriodEnd(periodStart, metric.granularity),
        value: numberValue
      }
    })
    .filter(Boolean)
}

export async function ingestServiceAccountConnectorOutputHandler(req, res) {
  if (!req.serviceAccount?.id) {
    throw createHttpError(401, 'Compte de service non authentifié')
  }

  const {data, metadata, connector, serviceAccount, sourcePointId, lastRunAt} = req.body

  if (!data || typeof data !== 'object') {
    throw createHttpError(400, 'Payload data manquant')
  }

  if (!metadata || typeof metadata !== 'object') {
    throw createHttpError(400, 'Payload metadata manquant')
  }

  const pointId = metadata.point_id
  const declarantId = metadata.declarant_id
  const contextId = metadata.context_id

  if (!pointId || !declarantId || !contextId) {
    throw createHttpError(
      400,
      'metadata.point_id, metadata.declarant_id et metadata.context_id sont requis'
    )
  }

  const allowed = await canServiceAccountImpersonateDeclarant(
    req.serviceAccount.id,
    declarantId
  )

  if (!allowed) {
    throw createHttpError(
      403,
      'Ce compte de service ne peut pas ingérer pour ce déclarant'
    )
  }

  const point = await prisma.pointPrelevement.findUnique({
    where: {
      id: pointId
    },
    select: {
      id: true,
      name: true
    }
  })

  if (!point) {
    throw createHttpError(404, 'Point de prélèvement introuvable')
  }

  const metrics = Array.isArray(data.metrics) ? data.metrics : []

  if (metrics.length === 0) {
    return res.status(200).json({
      success: true,
      imported: false,
      reason: 'NO_METRICS'
    })
  }

  const allValues = metrics.flatMap(metric => getMetricValues(metric))
  const shouldReconstructVolumesFromIndex = hasIndexMetric(metrics)

  if (allValues.length === 0) {
    return res.status(200).json({
      success: true,
      imported: false,
      reason: 'NO_VALUES'
    })
  }

  const minDate = new Date(
    Math.min(...allValues.map(value => value.periodStart.getTime()))
  )

  const maxDate = new Date(
    Math.max(...allValues.map(value => (value.periodEnd ?? value.periodStart).getTime()))
  )

  const source = await prisma.source.create({
    data: {
      id: randomUUID(),
      type: 'API',
      status: 'PENDING',
      metadata: {
        connector,
        serviceAccount,
        sourcePointId,
        contextId,
        lastRunAt,
        sourceMetadata: data.source_metadata
      }
    }
  })

  const chunkStatuses = []

  // On conserve un traitement séquentiel pour maintenir un flux de création stable par métrique.
  for (const metric of metrics) {
    const values = getMetricValues(metric)

    if (values.length === 0) {
      continue
    }

    // eslint-disable-next-line no-await-in-loop
    const chunk = await prisma.chunk.create({
      data: {
        id: randomUUID(),
        sourceId: source.id,
        pointPrelevementId: point.id,
        pointPrelevementName: point.name,
        instructionStatus: 'VALIDATED',
        minDate,
        maxDate,
        parsingInfo: {
          case: 1,
          reason: 'SERVICE_ACCOUNT_API_CONNECTOR',
          connector,
          sourcePointId
        },
        metadata: {
          connector,
          sourceMetadata: data.source_metadata
        }
      }
    })

    // eslint-disable-next-line no-await-in-loop
    await prisma.chunkValue.createMany({
      data: values.map(value => ({
        id: randomUUID(),
        chunkId: chunk.id,
        metricTypeCode: metricTypeToMetricTypeCode(metric.type),
        unit: metric.unit,
        frequency: metric.granularity,
        periodStart: value.periodStart,
        periodEnd: value.periodEnd,
        valueKind: 'DECLARED',
        value: value.value
      }))
    })

    chunkStatuses.push('VALIDATED')
  }

  await prisma.source.update({
    where: {
      id: source.id
    },
    data: {
      status: 'COMPLETED',
      globalInstructionStatus: computeGlobalInstructionStatus(chunkStatuses)
    }
  })

  await prisma.declarantPointPrelevement.updateMany({
    where: {
      declarantUserId: declarantId,
      pointPrelevementId: pointId
    },
    data: {
      mostRecentAvailableDate: maxDate
    }
  })

  if (shouldReconstructVolumesFromIndex) {
    await addJobReconstructVolumesFromIndexForPoint(point.id, source.id)
  }

  res.status(200).json({
    success: true,
    imported: true,
    sourceId: source.id,
    minDate,
    maxDate
  })
}
