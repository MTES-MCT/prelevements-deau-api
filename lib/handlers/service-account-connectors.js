import createHttpError from 'http-errors'
import {randomUUID} from 'node:crypto'
import {prisma} from '../../db/prisma.js'
import {canServiceAccountAccessDeclarant} from '../models/service-account-declarant.js'
import {computeGlobalInstructionStatus} from './chunks.js'
import {addJobReconstructVolumesFromIndexForPoint} from '../queues/jobs.js'
import {
  METRIC_TYPE_CODES,
  inferFlowTypeFromLegacyMetricTypeCode,
  normalizeMetricTypeCode
} from '../constants/metric-type-codes.js'
import {POINT_FLOW_TYPES, normalizePointFlowType} from '../constants/point-flow-types.js'
import {
  applyConflictPolicyForIncomingChunkValues,
  normalizeConflictPolicy,
  CHUNK_VALUE_CONFLICT_POLICIES
} from '../services/chunk-value-conflicts.js'
import {
  MIN_TIME_STEP_MINUTES,
  isAlignedOnDiscreteStep,
  isDurationAlignedOnDiscreteStep,
  resolveTemporalPeriod
} from '../util/temporal-discretization.js'
import {getFallbackChunkWaterUse, getWaterUseRootId, resolveWaterUseInput} from '../services/sandre-water-uses.js'
import {buildChunkActorData} from '../services/chunk-actors.js'
import {POINT_ASSOCIATION_ORIGINS} from '../services/chunk-point-associations.js'
import {syncDeclarantZonesFromPoint} from '../services/zone-permissions.js'
import {refreshSourceDeclarantsLastDeclarationAt} from '../models/declarant.js'

const CHUNK_VALUE_INSERT_BATCH_SIZE = 1000

function metricTypeToMetricTypeCode(type) {
  if (type === 'volume' || type === 'volume_preleve' || type === 'volume_rejete') {
    return METRIC_TYPE_CODES.VOLUME
  }

  if (type === 'debit' || type === 'debit_preleve') {
    return METRIC_TYPE_CODES.DEBIT
  }

  if (type === 'index') {
    return METRIC_TYPE_CODES.INDEX
  }

  return normalizeMetricTypeCode(type)
}

function getMetricFlowType(metricType) {
  if (metricType === 'volume_rejete') {
    return POINT_FLOW_TYPES.REJET
  }

  if (metricType === 'volume_preleve' || metricType === 'debit_preleve') {
    return POINT_FLOW_TYPES.PRELEVEMENT
  }

  return inferFlowTypeFromLegacyMetricTypeCode(metricType)
}

function resolveIncomingFlowType(data, metrics, pointFlowType) {
  const hints = new Set([
    normalizePointFlowType(data?.flow_type),
    ...metrics.map(metric => getMetricFlowType(metric?.type))
  ].filter(Boolean))

  if (hints.size > 1) {
    throw createHttpError(400, 'Le payload contient à la fois des mesures de prélèvement et de rejet.')
  }

  const [sourceFlowType] = hints
  const resolvedPointFlowType = pointFlowType ?? POINT_FLOW_TYPES.PRELEVEMENT

  if (sourceFlowType && sourceFlowType !== resolvedPointFlowType) {
    const error = createHttpError(
      409,
      'Le type de point indiqué par la source ne correspond pas à celui du point associé.'
    )
    error.data = {
      reason: 'POINT_FLOW_TYPE_MISMATCH',
      sourceFlowType,
      pointFlowType: resolvedPointFlowType
    }
    throw error
  }

  return {
    flowType: resolvedPointFlowType,
    sourceFlowType: sourceFlowType ?? null
  }
}

function hasIndexMetric(metrics) {
  return metrics.some(metric => {
    const type = typeof metric?.type === 'string' ? metric.type.trim().toLowerCase() : ''
    return type === 'index'
  })
}

function normalizeConnectorRate(rate) {
  const normalizedRate = Number(rate ?? 100)

  if (!Number.isFinite(normalizedRate) || normalizedRate < 0 || normalizedRate > 100) {
    throw createHttpError(400, 'Le taux de répartition du connecteur doit être compris entre 0 et 100.')
  }

  return normalizedRate
}

function getSourcePointIdFromConnector(connector) {
  const parameters = connector?.connectorParameters

  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return null
  }

  const {sourcePointId} = parameters

  return typeof sourcePointId === 'string' ? sourcePointId : null
}

async function getAuthorizedConnector({declarantId, pointId, connectorType, sourcePointId, connectorId}) {
  const exploitation = await prisma.declarantPointPrelevement.findFirst({
    where: {
      declarantUserId: declarantId,
      pointPrelevementId: pointId,
      connectors: {
        some: connectorId ? {id: connectorId} : {connectorType}
      }
    },
    include: {
      connectors: {
        where: connectorId ? {id: connectorId} : {connectorType},
        orderBy: {
          createdAt: 'asc'
        }
      }
    }
  })

  if (!exploitation) {
    throw createHttpError(403, 'Ce connecteur n’est pas autorisé pour cette exploitation.')
  }

  const candidates = exploitation.connectors.filter(candidate => {
    if (candidate.connectorType !== connectorType) {
      return false
    }

    const candidateSourcePointId = getSourcePointIdFromConnector(candidate)

    return !candidateSourcePointId || !sourcePointId || candidateSourcePointId === sourcePointId
  })

  if (candidates.length === 0) {
    throw createHttpError(403, 'Ce compteur source n’est pas autorisé pour cette exploitation.')
  }

  if (candidates.length > 1 && !connectorId) {
    throw createHttpError(
      400,
      'Plusieurs connecteurs correspondent à cette exploitation. metadata.connector_id est requis.'
    )
  }

  const connector = candidates[0]

  return {
    exploitationId: exploitation.id,
    usageId: exploitation.usageId,
    connector,
    rate: normalizeConnectorRate(connector.rate)
  }
}

function getMetricValues(metric, rateCoefficient = 1) {
  if (!metric || !Array.isArray(metric.values)) {
    return {values: [], rejectionStats: {INVALID_METRIC_VALUES_ARRAY: 1}}
  }

  const metricTypeCode = metricTypeToMetricTypeCode(metric.type)
  const rejectionStats = {}
  const values = metric.values
    .map(rawValue => {
      const value = rawValue
      const numberValue = Number(value.value)
      const {
        error: periodError,
        hasExplicitPeriodEnd,
        periodEnd,
        periodStart
      } = resolveTemporalPeriod(value, metric.granularity)

      if (periodError || !Number.isFinite(numberValue)) {
        if (periodError) {
          rejectionStats[periodError] = (rejectionStats[periodError] ?? 0) + 1
        }

        if (!Number.isFinite(numberValue)) {
          rejectionStats.NON_FINITE_VALUE = (rejectionStats.NON_FINITE_VALUE ?? 0) + 1
        }

        return null
      }

      if (
        !isAlignedOnDiscreteStep(periodStart, MIN_TIME_STEP_MINUTES)
        || !isAlignedOnDiscreteStep(periodEnd, MIN_TIME_STEP_MINUTES)
      ) {
        rejectionStats.MISALIGNED_PERIOD = (rejectionStats.MISALIGNED_PERIOD ?? 0) + 1
        return null
      }

      if (
        !hasExplicitPeriodEnd
        && !isDurationAlignedOnDiscreteStep(metric.granularity, MIN_TIME_STEP_MINUTES)
      ) {
        rejectionStats.MISALIGNED_GRANULARITY = (rejectionStats.MISALIGNED_GRANULARITY ?? 0) + 1
        return null
      }

      return {
        metricTypeCode,
        periodStart,
        periodEnd,
        value: numberValue * rateCoefficient
      }
    })
    .filter(Boolean)

  return {values, rejectionStats}
}

async function createChunkValuesInBatches(chunkValues) {
  for (let index = 0; index < chunkValues.length; index += CHUNK_VALUE_INSERT_BATCH_SIZE) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.chunkValue.createMany({
      data: chunkValues.slice(index, index + CHUNK_VALUE_INSERT_BATCH_SIZE)
    })
  }
}

function resolveMetricConflictPolicy(metric) {
  const requestedConflictPolicy = metric?.conflictPolicy
  if (typeof requestedConflictPolicy !== 'string' || requestedConflictPolicy.trim().length === 0) {
    throw createHttpError(
      400,
      `metrics[].conflictPolicy est requis. Valeurs autorisées: ${CHUNK_VALUE_CONFLICT_POLICIES.join(', ')}`
    )
  }

  const normalizedConflictPolicy = normalizeConflictPolicy(requestedConflictPolicy)
  if (normalizedConflictPolicy === null) {
    throw createHttpError(
      400,
      `metrics[].conflictPolicy invalide. Valeurs autorisées: ${CHUNK_VALUE_CONFLICT_POLICIES.join(', ')}`
    )
  }

  return normalizedConflictPolicy
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
  const connectorId = metadata.connector_id

  if (!pointId || !declarantId || !contextId) {
    throw createHttpError(
      400,
      'metadata.point_id, metadata.declarant_id et metadata.context_id sont requis'
    )
  }

  if (!connector || typeof connector !== 'string') {
    throw createHttpError(400, 'Le type de connecteur est requis.')
  }

  if (connectorId && typeof connectorId !== 'string') {
    throw createHttpError(400, 'metadata.connector_id doit être une chaîne de caractères.')
  }

  const allowed = await canServiceAccountAccessDeclarant(
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
      name: true,
      flowType: true
    }
  })

  if (!point) {
    throw createHttpError(404, 'Point de prélèvement introuvable')
  }

  const authorizedConnector = await getAuthorizedConnector({
    declarantId,
    pointId,
    connectorType: connector,
    sourcePointId,
    connectorId
  })

  const connectorRate = authorizedConnector.rate
  const rateCoefficient = connectorRate / 100

  const metrics = Array.isArray(data.metrics) ? data.metrics : []
  const {flowType, sourceFlowType} = resolveIncomingFlowType(data, metrics, point.flowType)

  if (metrics.length === 0) {
    return res.status(200).json({
      success: true,
      imported: false,
      reason: 'NO_METRICS'
    })
  }

  const metricAnalyses = metrics.map(metric => ({
    metric,
    analysis: getMetricValues(metric, rateCoefficient)
  }))
  const allValues = metricAnalyses.flatMap(item => item.analysis.values)
  const incomingHasIndexMetric = hasIndexMetric(metrics)
  console.log(
    `[service-account-connectors] ingest summary pointId=${pointId} `
    + `declarantId=${declarantId} connectorId=${authorizedConnector.connector.id} `
    + `connectorRate=${connectorRate} metrics=${metrics.length} values=${allValues.length} `
    + `hasIndexMetric=${incomingHasIndexMetric}`
  )

  if (allValues.length === 0) {
    console.log(
      `[service-account-connectors] ingest skipped (NO_VALUES) pointId=${pointId} declarantId=${declarantId} connectorId=${authorizedConnector.connector.id}`
    )
    return res.status(200).json({
      success: true,
      imported: false,
      reason: 'NO_VALUES'
    })
  }

  const importableMetricAnalyses = []
  const declaredRootUsageIds = new Set()
  const fallbackWaterUse = await getFallbackChunkWaterUse()
  let skippedByConflictCount = 0
  let skippedValueCount = 0

  // On résout les conflits avant de créer la source afin de ne pas persister
  // une source vide lorsque toutes les valeurs sont ignorées.
  for (const {metric, analysis} of metricAnalyses) {
    const {values, rejectionStats = {}} = analysis
    // eslint-disable-next-line no-await-in-loop
    const waterUse = await resolveWaterUseInput(metric, {declaration: true, required: false})

    if (values.length === 0) {
      if (Object.keys(rejectionStats).length > 0) {
        console.log(
          `[service-account-connectors] metric rejected pointId=${pointId} `
          + `connectorId=${authorizedConnector.connector.id} type=${metric.type} `
          + `granularity=${metric.granularity} reasons=${JSON.stringify(rejectionStats)}`
        )
      }

      continue
    }

    const metricConflictPolicy = resolveMetricConflictPolicy(metric)

    // eslint-disable-next-line no-await-in-loop
    const conflictResolution = await applyConflictPolicyForIncomingChunkValues({
      pointPrelevementId: point.id,
      preleveurUserId: declarantId,
      valueRows: values,
      requestedPolicy: metricConflictPolicy,
      replaceComment: 'AUTO_REPLACED_BY_CONNECTOR_INGEST',
      replacementMetadata: {
        connector,
        connectorId: authorizedConnector.connector.id,
        contextId,
        sourcePointId,
        metricType: metric.type,
        granularity: metric.granularity
      }
    })

    if (conflictResolution.shouldSkip) {
      skippedByConflictCount++
      skippedValueCount += conflictResolution.skippedValueCount ?? values.length
      continue
    }

    const valuesToInsert = conflictResolution.valueRowsToInsert ?? values
    skippedValueCount += conflictResolution.skippedValueCount ?? 0

    importableMetricAnalyses.push({
      metric,
      usageId: waterUse?.id ?? authorizedConnector.usageId ?? fallbackWaterUse.id,
      values: valuesToInsert
    })

    const rootUsageId = getWaterUseRootId(waterUse)
    if (rootUsageId) {
      declaredRootUsageIds.add(rootUsageId)
    }
  }

  if (importableMetricAnalyses.length === 0) {
    console.log(
      '[service-account-connectors] ingest skipped (ALL_METRICS_SKIPPED_BY_CONFLICT) '
      + `pointId=${pointId} declarantId=${declarantId} connectorId=${authorizedConnector.connector.id} `
      + `skippedMetrics=${skippedByConflictCount}`
    )

    return res.status(200).json({
      success: true,
      imported: false,
      reason: 'ALL_METRICS_SKIPPED_BY_CONFLICT',
      skippedMetrics: skippedByConflictCount,
      skippedValues: skippedValueCount
    })
  }

  const importableValues = importableMetricAnalyses.flatMap(item => item.values)
  const minDate = new Date(
    Math.min(...importableValues.map(value => value.periodStart.getTime()))
  )

  const maxDate = new Date(
    Math.max(...importableValues.map(value => (value.periodEnd ?? value.periodStart).getTime()))
  )
  const actorData = await buildChunkActorData({
    preleveurUserId: declarantId,
    submittedByDeclarantUserId: declarantId
  })

  const source = await prisma.source.create({
    data: {
      id: randomUUID(),
      type: 'API',
      status: 'PENDING',
      metadata: {
        connector,
        connectorId: authorizedConnector.connector.id,
        connectorRate,
        declarantId,
        pointId,
        serviceAccount,
        sourcePointId,
        contextId,
        lastRunAt,
        sourceMetadata: data.source_metadata
      }
    }
  })

  const chunkStatuses = []
  const shouldReconstructVolumesFromIndex = hasIndexMetric(
    importableMetricAnalyses.map(item => item.metric)
  )

  await syncDeclarantZonesFromPoint({
    declarantUserIds: [
      declarantId,
      actorData.preleveurUserId,
      actorData.submittedByDeclarantUserId,
      actorData.collecteurUserId
    ],
    pointPrelevementId: point.id,
    source: 'DECLARATION'
  })

  // On conserve un traitement séquentiel pour maintenir un flux de création stable par métrique.
  for (const {metric, usageId, values} of importableMetricAnalyses) {
    // eslint-disable-next-line no-await-in-loop
    const chunk = await prisma.chunk.create({
      data: {
        id: randomUUID(),
        sourceId: source.id,
        pointPrelevementId: point.id,
        pointPrelevementName: point.name,
        flowType,
        ...actorData,
        usageId,
        instructionStatus: 'VALIDATED',
        minDate,
        maxDate,
        parsingInfo: {
          case: 1,
          reason: 'SERVICE_ACCOUNT_API_CONNECTOR',
          pointAssociationOrigin: POINT_ASSOCIATION_ORIGINS.AUTOMATIC,
          connector,
          connectorId: authorizedConnector.connector.id,
          connectorRate,
          sourcePointId,
          flowType
        },
        metadata: {
          connector,
          connectorId: authorizedConnector.connector.id,
          connectorRate,
          flowType,
          sourceFlowType,
          sourceMetadata: data.source_metadata
        }
      }
    })

    const chunkValues = values.map(value => ({
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

    // eslint-disable-next-line no-await-in-loop
    await createChunkValuesInBatches(chunkValues)

    chunkStatuses.push('VALIDATED')
  }

  const nextExploitationUsageId = declaredRootUsageIds.size > 0
    ? [...declaredRootUsageIds].at(-1)
    : authorizedConnector.usageId

  await prisma.$transaction(async tx => {
    await tx.source.update({
      where: {
        id: source.id
      },
      data: {
        status: 'COMPLETED',
        globalInstructionStatus: computeGlobalInstructionStatus(chunkStatuses)
      }
    })

    await tx.declarantPointPrelevement.update({
      where: {
        id: authorizedConnector.exploitationId
      },
      data: {
        ...(nextExploitationUsageId ? {usageId: nextExploitationUsageId} : {}),
        mostRecentAvailableDate: maxDate
      }
    })

    await refreshSourceDeclarantsLastDeclarationAt(source.id, {client: tx})
  })

  if (shouldReconstructVolumesFromIndex) {
    console.log(
      `[service-account-connectors] enqueue reconstruction pointId=${point.id} sourceId=${source.id} connectorId=${authorizedConnector.connector.id}`
    )
    await addJobReconstructVolumesFromIndexForPoint(point.id, source.id)
  } else {
    console.log(
      `[service-account-connectors] no reconstruction enqueued pointId=${point.id} sourceId=${source.id} connectorId=${authorizedConnector.connector.id} reason=NO_INDEX_METRIC`
    )
  }

  res.status(200).json({
    success: true,
    imported: true,
    sourceId: source.id,
    minDate,
    maxDate,
    skippedValues: skippedValueCount
  })
}
