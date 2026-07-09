/* eslint-disable no-await-in-loop */
import {createLogger} from '../util/logger.js'
import {prisma} from '../../db/prisma.js'
import * as Sentry from '@sentry/node'
import moment from 'moment'
import {randomUUID} from 'node:crypto'
import {computeGlobalPointMatchingStatus} from '../handlers/chunks.js'
import {METRIC_TYPE_CODES} from '../constants/metric-type-codes.js'
import {computePeriodEnd, normalizeTemporalStart} from '../util/temporal-discretization.js'
import {
  applyConflictPolicyForIncomingChunkValues,
  refreshReplacedSourcesAfterConflict,
  normalizeConflictPolicy,
  CHUNK_VALUE_CONFLICT_POLICIES
} from '../services/chunk-value-conflicts.js'
import {buildChunkActorData} from '../services/chunk-actors.js'
import {refreshMostRecentAvailableDateForDeclarantPoints} from '../services/declaration-side-effects.js'
import {getFallbackChunkWaterUse, getWaterUseRootId, resolveWaterUseInput} from '../services/sandre-water-uses.js'

function getObjectMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {}
  }

  return metadata
}

function getErrorMessage(error) {
  return error?.message || String(error)
}

function getDeclarationSourceMetadata({declaration, existingMetadata, extraMetadata = {}}) {
  const metadata = {...getObjectMetadata(existingMetadata)}
  delete metadata.parsingErrors
  delete metadata.processingError
  delete metadata.processingFailedAt

  return {
    ...metadata,
    declarationType: declaration.type,
    fileCount: declaration.files.length,
    ...extraMetadata
  }
}

function activeWindowWhere(chunkStart, chunkEnd) {
  return {
    AND: [
      {OR: [{startDate: null}, {startDate: {lte: chunkEnd}}]},
      {OR: [{endDate: null}, {endDate: {gte: chunkStart}}]}
    ]
  }
}

function normalizeDeclaredPointName(value) {
  return String(value ?? '')
    .trim()
    .replaceAll(/\s+/g, ' ')
}

function normalizePointNameForMatching(value) {
  return normalizeDeclaredPointName(value)
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('fr-FR')
}

function normalizeExternalDeclarantSiret(value) {
  const normalized = String(value ?? '').replaceAll(/\D/g, '')

  return normalized || null
}

function normalizeExternalDeclarantName(value) {
  return normalizePointNameForMatching(value)
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
}

function getExternalDeclarantFromMetadata(metadata) {
  const record = getObjectMetadata(metadata)
  const direct = getObjectMetadata(record.externalDeclarant)
  const nested = getObjectMetadata(getObjectMetadata(record.sourceMetadata).externalDeclarant)
  const externalDeclarant = Object.keys(direct).length > 0 ? direct : nested

  if (Object.keys(externalDeclarant).length === 0) {
    return null
  }

  return {
    sourceId: typeof externalDeclarant.sourceId === 'string' ? externalDeclarant.sourceId.trim() : null,
    name: typeof externalDeclarant.name === 'string' ? externalDeclarant.name.trim() : null,
    siret: normalizeExternalDeclarantSiret(externalDeclarant.siret)
  }
}

function getSeriesExternalDeclarant(series) {
  return getExternalDeclarantFromMetadata(series.metadata)
}

function getExternalDeclarantKey(externalDeclarant) {
  if (!externalDeclarant) {
    return null
  }

  return externalDeclarant.siret || externalDeclarant.sourceId || normalizeExternalDeclarantName(externalDeclarant.name)
}

function getChunkExternalDeclarant(chunk) {
  for (const series of chunk.series) {
    const externalDeclarant = getSeriesExternalDeclarant(series)

    if (externalDeclarant) {
      return externalDeclarant
    }
  }

  return null
}

function getDeclarantLabels(declarant) {
  const user = declarant?.user ?? {}

  return [
    declarant?.socialReason,
    [user.firstName, user.lastName].filter(Boolean).join(' '),
    [user.lastName, user.firstName].filter(Boolean).join(' ')
  ].filter(Boolean)
}

function externalDeclarantNameMatches(declarant, externalDeclarant) {
  const externalName = normalizeExternalDeclarantName(externalDeclarant?.name)
  if (!externalName) {
    return false
  }

  const externalTokens = new Set(externalName.split(' ').filter(token => token.length > 1))

  return getDeclarantLabels(declarant).some(label => {
    const normalizedLabel = normalizeExternalDeclarantName(label)
    if (!normalizedLabel) {
      return false
    }

    if (normalizedLabel === externalName || normalizedLabel.includes(externalName) || externalName.includes(normalizedLabel)) {
      return true
    }

    const labelTokens = new Set(normalizedLabel.split(' ').filter(token => token.length > 1))

    return externalTokens.size > 0 && [...externalTokens].every(token => labelTokens.has(token))
  })
}

function exploitationMatchesExternalDeclarant(exploitation, externalDeclarant) {
  if (!externalDeclarant) {
    return false
  }

  const {declarant} = exploitation
  if (!declarant) {
    return false
  }

  if (externalDeclarant.siret && normalizeExternalDeclarantSiret(declarant.siret) === externalDeclarant.siret) {
    return true
  }

  return externalDeclarantNameMatches(declarant, externalDeclarant)
}

function chooseExploitationCandidate(exploitations, externalDeclarant = null) {
  if (exploitations.length === 0) {
    return null
  }

  if (!externalDeclarant) {
    return exploitations[0]
  }

  const matchingExploitations = exploitations.filter(exploitation =>
    exploitationMatchesExternalDeclarant(exploitation, externalDeclarant)
  )

  if (matchingExploitations.length > 0) {
    return matchingExploitations[0]
  }

  return exploitations.length === 1 ? exploitations[0] : null
}

function getPointNameMatchStrategy(exploitation, normalizedPointName) {
  const aliases = Array.isArray(exploitation.pointPrelevementNameAliases)
    ? exploitation.pointPrelevementNameAliases
    : []

  if (aliases.some(alias => normalizePointNameForMatching(alias) === normalizedPointName)) {
    return 'DeclarantPointPrelevement.pointPrelevementNameAliases'
  }

  const officialName = normalizePointNameForMatching(exploitation.pointPrelevement?.name)
  if (officialName && officialName === normalizedPointName) {
    return 'PointPrelevement.name + DeclarantPointPrelevement'
  }

  if (officialName && normalizedPointName.length >= 3 && officialName.includes(normalizedPointName)) {
    return 'PointPrelevement.name contains + DeclarantPointPrelevement'
  }

  return null
}

async function findAccessibleExploitationForPointName({
  client = prisma,
  declarantUserId,
  declarantRole,
  pointPrelevementName,
  externalDeclarant,
  chunkStart,
  chunkEnd
}) {
  const normalizedPointName = normalizePointNameForMatching(pointPrelevementName)
  if (!normalizedPointName) {
    return null
  }

  const accessWhere = declarantRole === 'COLLECTEUR'
    ? {
      OR: [
        {declarantUserId},
        {
          collecteurs: {
            some: {collecteurUserId: declarantUserId}
          }
        }
      ]
    }
    : {declarantUserId}

  const exploitations = await client.declarantPointPrelevement.findMany({
    where: {
      ...accessWhere,
      ...activeWindowWhere(chunkStart, chunkEnd),
      pointPrelevement: {
        deletedAt: null
      }
    },
    select: {
      id: true,
      declarantUserId: true,
      pointPrelevementId: true,
      pointPrelevementNameAliases: true,
      usageId: true,
      usage: true,
      declarant: {
        select: {
          siret: true,
          socialReason: true,
          user: {
            select: {
              firstName: true,
              lastName: true
            }
          }
        }
      },
      pointPrelevement: {
        select: {
          id: true,
          name: true
        }
      }
    }
  })

  const matches = []
  for (const exploitation of exploitations) {
    const matchStrategy = getPointNameMatchStrategy(exploitation, normalizedPointName)

    if (matchStrategy) {
      matches.push({exploitation, matchStrategy})
    }
  }

  const selected = chooseExploitationCandidate(matches.map(match => match.exploitation), externalDeclarant)
  if (!selected) {
    return null
  }

  return {
    exploitation: selected,
    pointPrelevementId: selected.pointPrelevementId,
    matchStrategy: matches.find(match => match.exploitation.id === selected.id)?.matchStrategy
  }
}

async function getDeclarantRole(declarantUserId, client = prisma) {
  const declarant = await client.declarant.findUnique({
    where: {
      userId: declarantUserId
    },
    select: {
      declarantRole: true
    }
  })

  return declarant?.declarantRole ?? null
}

async function getDirectPointAccess({
  client = prisma,
  declarantUserId,
  pointId,
  chunkStart,
  chunkEnd
}) {
  const anyLink = await client.declarantPointPrelevement.findFirst({
    where: {
      declarantUserId,
      pointPrelevementId: pointId
    },
    select: {id: true, declarantUserId: true}
  })

  const linkOnWindow = await client.declarantPointPrelevement.findFirst({
    where: {
      declarantUserId,
      pointPrelevementId: pointId,
      ...activeWindowWhere(chunkStart, chunkEnd)
    },
    select: {id: true, declarantUserId: true, usageId: true, usage: true}
  })

  return {
    anyLink,
    linkOnWindow,
    matchStrategy: 'PointPrelevement.name'
  }
}

async function getCollecteurPointAccess({
  client = prisma,
  collecteurUserId,
  pointId,
  externalDeclarant,
  chunkStart,
  chunkEnd
}) {
  const anyLink = await client.declarantCollecteurExploitation.findFirst({
    where: {
      collecteurUserId,
      exploitation: {
        pointPrelevementId: pointId
      }
    },
    select: {
      id: true,
      exploitation: {
        select: {
          id: true
        }
      }
    }
  })

  const linksOnWindow = await client.declarantCollecteurExploitation.findMany({
    where: {
      collecteurUserId,
      exploitation: {
        pointPrelevementId: pointId,
        ...activeWindowWhere(chunkStart, chunkEnd)
      }
    },
    select: {
      id: true,
      exploitation: {
        select: {
          id: true,
          declarantUserId: true,
          usageId: true,
          usage: true,
          declarant: {
            select: {
              siret: true,
              socialReason: true,
              user: {
                select: {
                  firstName: true,
                  lastName: true
                }
              }
            }
          }
        }
      }
    }
  })
  const selectedExploitation = chooseExploitationCandidate(
    linksOnWindow.map(link => link.exploitation),
    externalDeclarant
  )
  const selectedLinkOnWindow = selectedExploitation
    ? linksOnWindow.find(link => link.exploitation.id === selectedExploitation.id) ?? null
    : null

  return {
    anyLink: anyLink
      ? {
        id: anyLink.exploitation.id,
        collecteurLinkId: anyLink.id
      }
      : null,
    linkOnWindow: selectedLinkOnWindow?.exploitation
      ? {
        id: selectedLinkOnWindow.exploitation.id,
        declarantUserId: selectedLinkOnWindow.exploitation.declarantUserId,
        usageId: selectedLinkOnWindow.exploitation.usageId,
        usage: selectedLinkOnWindow.exploitation.usage,
        collecteurLinkId: selectedLinkOnWindow.id
      }
      : null,
    matchStrategy: 'PointPrelevement.name + DeclarantCollecteurExploitation'
  }
}

function getSeriesBoundaryTimestamp(value) {
  const date = moment.utc(value, moment.ISO_8601, true)
  return date.isValid() ? date.valueOf() : null
}

function parseChunkBoundary(value) {
  const date = moment.utc(value, moment.ISO_8601, true)
  return date.isValid() ? date : null
}

function minSeriesDate(left, right) {
  const leftTimestamp = getSeriesBoundaryTimestamp(left)
  const rightTimestamp = getSeriesBoundaryTimestamp(right)

  if (leftTimestamp === null) {
    return right
  }

  if (rightTimestamp === null) {
    return left
  }

  return rightTimestamp < leftTimestamp ? right : left
}

function maxSeriesDate(left, right) {
  const leftTimestamp = getSeriesBoundaryTimestamp(left)
  const rightTimestamp = getSeriesBoundaryTimestamp(right)

  if (leftTimestamp === null) {
    return right
  }

  if (rightTimestamp === null) {
    return left
  }

  return rightTimestamp > leftTimestamp ? right : left
}

function getSeriesGroupKey(series) {
  const externalDeclarant = getSeriesExternalDeclarant(series)

  return JSON.stringify({
    pointPrelevement: normalizePointNameForMatching(series.pointPrelevement),
    externalDeclarant: getExternalDeclarantKey(externalDeclarant),
    usageId: series.usageId ?? null,
    usage: series.usage ?? null
  })
}

function groupSeriesIntoChunks(series) {
  const groupsByKey = new Map()

  for (const item of series) {
    const key = getSeriesGroupKey(item)
    const existingGroup = groupsByKey.get(key)

    if (!existingGroup) {
      groupsByKey.set(key, {
        pointPrelevement: normalizeDeclaredPointName(item.pointPrelevement),
        metadata: getObjectMetadata(item.metadata),
        usageId: item.usageId,
        usage: item.usage,
        minDate: item.minDate,
        maxDate: item.maxDate,
        series: [item]
      })
      continue
    }

    existingGroup.minDate = minSeriesDate(existingGroup.minDate, item.minDate)
    existingGroup.maxDate = maxSeriesDate(existingGroup.maxDate, item.maxDate)
    existingGroup.metadata = {
      ...getObjectMetadata(existingGroup.metadata),
      ...getObjectMetadata(item.metadata)
    }
    existingGroup.series.push(item)
  }

  return [...groupsByKey.values()]
}

function computeTotalWaterVolumeForSeries(series, parameterName) {
  let total = 0

  for (const item of series) {
    total += computeTotalWaterVolume(item, parameterName)
  }

  return total
}

function computeTotalWaterVolumeForValueRows(valueRows, parameterName) {
  let total = 0

  for (const valueRow of valueRows) {
    if (valueRow.metricTypeCode !== parameterName) {
      continue
    }

    const value = Number(valueRow.value)
    if (!Number.isNaN(value)) {
      total += value
    }
  }

  return total
}

function buildMetricMetadataForValueRows(series, valueRows) {
  const valueCountByKey = new Map()

  for (const valueRow of valueRows) {
    const key = `${valueRow.metricTypeCode}:${valueRow.unit}:${valueRow.frequency}`
    valueCountByKey.set(key, (valueCountByKey.get(key) ?? 0) + 1)
  }

  return series.map(item => {
    const key = `${item.parameter}:${item.unit}:${item.frequency}`

    return {
      parameter: item.parameter,
      unit: item.unit,
      frequency: item.frequency,
      valueCount: valueCountByKey.get(key) ?? 0,
      metadata: getObjectMetadata(item.metadata)
    }
  })
}

function getValueRowsBounds(valueRows, fallbackStart, fallbackEnd) {
  if (valueRows.length === 0) {
    return {
      minDate: fallbackStart,
      maxDate: fallbackEnd
    }
  }

  let minTime = Number.POSITIVE_INFINITY
  let maxTime = Number.NEGATIVE_INFINITY

  for (const valueRow of valueRows) {
    minTime = Math.min(minTime, valueRow.periodStart.getTime())
    maxTime = Math.max(maxTime, valueRow.periodEnd.getTime())
  }

  return {
    minDate: new Date(minTime),
    maxDate: new Date(maxTime)
  }
}

async function createChunksFromData(
  data,
  sourceId,
  declarantUserId,
  createdByDeclarantUserId,
  _autoValidationEnabled,
  logger,
  declarationType = null,
  client = prisma,
  {deferredReplacedSourceIds = null} = {}
) {
  const requestedConflictPolicy = data.conflictPolicy
  if (typeof requestedConflictPolicy !== 'string' || requestedConflictPolicy.trim().length === 0) {
    throw new Error(
      `data.conflictPolicy est requis. Valeurs autorisées: ${CHUNK_VALUE_CONFLICT_POLICIES.join(', ')}`
    )
  }

  const normalizedConflictPolicy = normalizeConflictPolicy(requestedConflictPolicy)
  if (normalizedConflictPolicy === null) {
    throw new Error(
      `data.conflictPolicy invalide. Valeurs autorisées: ${CHUNK_VALUE_CONFLICT_POLICIES.join(', ')}`
    )
  }

  let matchedPoints = 0
  let unmatchedPoints = 0
  let createdChunks = 0
  let createdValues = 0
  let sourceTotalWaterVolumeWithdrawn = 0
  let sourceTotalWaterVolumeDischarged = 0
  const chunkStatuses = []
  const declarantRole = await getDeclarantRole(declarantUserId, client)
  const matchedDeclarantUserIds = new Set()
  const waterUseByKey = new Map()
  const fallbackWaterUse = await getFallbackChunkWaterUse({declarationType})

  async function resolveChunkWaterUse(chunk) {
    const input = {
      usageId: chunk.usageId,
      usage: chunk.usage
    }
    const cacheKey = JSON.stringify(input)

    if (cacheKey === '{}') {
      return null
    }

    if (!waterUseByKey.has(cacheKey)) {
      waterUseByKey.set(
        cacheKey,
        await resolveWaterUseInput(input, {declaration: true, required: false})
      )
    }

    return waterUseByKey.get(cacheKey)
  }

  const chunkCandidates = groupSeriesIntoChunks(data.series)

  for (const chunk of chunkCandidates) {
    const pointPrelevementName = chunk.pointPrelevement
    const {minDate, maxDate} = chunk
    const waterUse = await resolveChunkWaterUse(chunk)
    const metricSummary = chunk.series
      .map(series => `${series.parameter}/${series.frequency}`)
      .join(', ')
    const valueCount = chunk.series.reduce((sum, series) => sum + (series.data?.length ?? 0), 0)

    logger.log(
      `Chunk: point="${pointPrelevementName}", metrics="${metricSummary}", minDate=${minDate}, maxDate=${maxDate}, values=${valueCount}`
    )

    const chunkStartDate = parseChunkBoundary(minDate)
    const chunkEndDate = parseChunkBoundary(maxDate)
    const chunkStart = chunkStartDate?.startOf('day').toDate()
    const chunkEnd = chunkEndDate?.endOf('day').toDate()

    /**
     * Identification du point de prélèvement associé
     *
     * Cas 1 : le point de prélèvement existe et le déclarant a un lien actif sur la période du chunk
     * Cas 2 : le point de prélèvement existe, une exploitation existe mais la période du chunk ne correspond pas
     * Cas 3 : le point de prélèvement existe, mais aucune exploitation n'existe pour le déclarant
     * Cas 4 : le point de prélèvement n'existe pas
     */

    let pointPrelevementId = null
    let parsingInfo = null
    let matchedDeclarantUserId = null
    let matchedExploitation = null
    const externalDeclarant = getChunkExternalDeclarant(chunk)

    const accessibleExploitationMatch = await findAccessibleExploitationForPointName({
      client,
      declarantUserId,
      declarantRole,
      pointPrelevementName,
      externalDeclarant,
      chunkStart,
      chunkEnd
    })

    if (accessibleExploitationMatch) {
      matchedExploitation = accessibleExploitationMatch.exploitation
      matchedDeclarantUserId = accessibleExploitationMatch.exploitation.declarantUserId
      matchedPoints++
      pointPrelevementId = accessibleExploitationMatch.pointPrelevementId
      parsingInfo = {
        case: 1,
        reason: 'POINT_FOUND_AND_LINK_ACTIVE_ON_WINDOW',
        pointPrelevementName,
        pointPrelevementId,
        exploitationId: accessibleExploitationMatch.exploitation.id,
        matchStrategy: accessibleExploitationMatch.matchStrategy
      }
      logger.log(
        `Point matché sur exploitation active: name="${pointPrelevementName}" -> id=${pointPrelevementId}, strategy=${accessibleExploitationMatch.matchStrategy}`
      )
    } else {
      const pointPrelevement
        = await client.pointPrelevement.findFirst({
          where: {
            name: pointPrelevementName,
            deletedAt: null
          },
          select: {id: true}
        })
        || await client.pointPrelevement.findFirst({
          where: {
            name: {
              contains: pointPrelevementName,
              mode: 'insensitive'
            },
            deletedAt: null
          },
          select: {id: true}
        })

      if (pointPrelevement?.id) {
        const pointId = pointPrelevement.id

        const directAccess = await getDirectPointAccess({
          client,
          declarantUserId,
          pointId,
          chunkStart,
          chunkEnd
        })

        let pointAccess = directAccess

        if (!directAccess.linkOnWindow && declarantRole === 'COLLECTEUR') {
          const collecteurAccess = await getCollecteurPointAccess({
            client,
            collecteurUserId: declarantUserId,
            pointId,
            externalDeclarant,
            chunkStart,
            chunkEnd
          })

          if (collecteurAccess.linkOnWindow || (!directAccess.anyLink && collecteurAccess.anyLink)) {
            pointAccess = collecteurAccess
          }
        }

        if (pointAccess.linkOnWindow?.id) {
          matchedExploitation = pointAccess.linkOnWindow
          matchedDeclarantUserId = pointAccess.linkOnWindow.declarantUserId
          matchedPoints++
          pointPrelevementId = pointId
          parsingInfo = {
            case: 1,
            reason: 'POINT_FOUND_AND_LINK_ACTIVE_ON_WINDOW',
            matchStrategy: pointAccess.matchStrategy
          }
          logger.log(
            `Point matché (lien déclarant OK sur période chunk): name="${pointPrelevementName}" -> id=${pointPrelevementId}`
          )
        } else if (pointAccess.anyLink?.id) {
          unmatchedPoints++
          parsingInfo = {
            case: 2,
            reason: 'POINT_FOUND_BUT_LINK_OUTSIDE_WINDOW',
            pointPrelevementName,
            pointPrelevementId: pointId,
            declarantUserId,
            otherExploitationId: pointAccess.anyLink.id,
            window: {from: chunkStart.toISOString(), to: chunkEnd.toISOString()},
            matchStrategy: pointAccess.matchStrategy
          }
          logger.warn(
            `Point trouvé mais lien déclarant hors période chunk: name="${pointPrelevementName}" -> id=${pointId}`
          )
        } else {
          unmatchedPoints++
          parsingInfo = {
            case: 3,
            reason: 'POINT_FOUND_BUT_NO_LINK_FOR_DECLARANT',
            pointPrelevementName,
            pointPrelevementId: pointId,
            declarantUserId,
            window: {from: chunkStart.toISOString(), to: chunkEnd.toISOString()},
            matchStrategy: 'PointPrelevement.name'
          }
          logger.warn(
            `Point trouvé mais aucun lien déclarant: name="${pointPrelevementName}" -> id=${pointId}, declarantUserId=${declarantUserId}`
          )
        }
      } else {
        unmatchedPoints++
        parsingInfo = {
          case: 4,
          reason: 'POINT_NOT_FOUND',
          pointPrelevementName,
          window: {from: chunkStart.toISOString(), to: chunkEnd.toISOString()}
        }
        logger.warn(`Point non trouvé: name="${pointPrelevementName}"`)
      }
    }

    const totalWaterVolumeWithdrawn = computeTotalWaterVolumeForSeries(chunk.series, METRIC_TYPE_CODES.VOLUME_PRELEVE)
    const totalWaterVolumeDischarged = computeTotalWaterVolumeForSeries(chunk.series, METRIC_TYPE_CODES.VOLUME_REJETE)

    const isValidated = Boolean(pointPrelevementId)
    const instructionStatus = isValidated ? 'VALIDATED' : 'PENDING'
    const chunkWaterUse = waterUse ?? matchedExploitation?.usage ?? fallbackWaterUse

    if (waterUse && matchedExploitation?.id) {
      const rootUsageId = getWaterUseRootId(waterUse)

      if (rootUsageId && matchedExploitation.usageId !== rootUsageId) {
        await client.declarantPointPrelevement.update({
          where: {id: matchedExploitation.id},
          data: {usageId: rootUsageId}
        })
      }
    }

    const actorData = await buildChunkActorData({
      preleveurUserId: declarantRole === 'COLLECTEUR' ? null : declarantUserId,
      matchedPreleveurUserId: matchedDeclarantUserId,
      submittedByDeclarantUserId: createdByDeclarantUserId || declarantUserId,
      client
    })

    const newChunk = await client.chunk.create({
      data: {
        id: randomUUID(),
        instructionStatus,
        sourceId,
        pointPrelevementName,
        pointPrelevementId,
        ...actorData,
        usageId: chunkWaterUse.id,
        minDate: chunkStart,
        maxDate: chunkEnd,
        parsingInfo,
        metadata: {
          ...getObjectMetadata(chunk.metadata),
          externalDeclarant,
          totalWaterVolumeWithdrawn,
          totalWaterVolumeDischarged,
          metrics: chunk.series.map(series => ({
            parameter: series.parameter,
            unit: series.unit,
            frequency: series.frequency,
            valueCount: series.data?.length ?? 0,
            metadata: getObjectMetadata(series.metadata)
          }))
        }
      }
    })

    createdChunks++
    chunkStatuses.push(newChunk)

    logger.log(
      `Chunk créé: id=${newChunk.id}, pointId=${newChunk.pointPrelevementId ?? 'null'}, parsingInfo=${parsingInfo?.reason ?? 'n/a'}`
    )

    const rawValues = chunk.series.flatMap(series =>
      (series.data ?? []).map(datum => ({
        datum,
        parameter: series.parameter,
        unit: series.unit,
        frequency: series.frequency
      }))
    )

    if (rawValues.length === 0) {
      logger.warn(`Chunk sans valeurs: chunkId=${newChunk.id}`)
      continue
    }

    const valueRows = rawValues
      .map(({datum, parameter, unit, frequency}) => {
        const periodStart = normalizeTemporalStart(datum.date)
        if (!periodStart) {
          return null
        }

        return {
          id: randomUUID(),
          chunkId: newChunk.id,
          metricTypeCode: parameter,
          unit,
          frequency,
          periodStart,
          periodEnd: computePeriodEnd(periodStart, frequency),
          valueKind: 'DECLARED',
          value: Number(datum.value)
        }
      })
      .filter(Boolean)

    if (valueRows.length === 0) {
      logger.warn(`Chunk sans valeur temporelle valide: chunkId=${newChunk.id}`)
      continue
    }

    const conflictResolution = await applyConflictPolicyForIncomingChunkValues({
      pointPrelevementId,
      valueRows,
      requestedPolicy: normalizedConflictPolicy,
      replaceComment: 'AUTO_REPLACED_BY_INGEST',
      replacementSourceId: sourceId,
      replacementMetadata: {
        declarationType: declarationType ?? null,
        incomingChunkId: newChunk.id
      },
      deferredReplacedSourceIds,
      client
    })

    const valueRowsToInsert = conflictResolution.valueRowsToInsert ?? valueRows
    const skippedValueCount = conflictResolution.skippedValueCount ?? 0
    const hasFilteredValues = valueRowsToInsert.length !== valueRows.length

    if (hasFilteredValues) {
      const filteredTotalWaterVolumeWithdrawn = computeTotalWaterVolumeForValueRows(
        valueRowsToInsert,
        METRIC_TYPE_CODES.VOLUME_PRELEVE
      )
      const filteredTotalWaterVolumeDischarged = computeTotalWaterVolumeForValueRows(
        valueRowsToInsert,
        METRIC_TYPE_CODES.VOLUME_REJETE
      )
      const {minDate: filteredMinDate, maxDate: filteredMaxDate} = getValueRowsBounds(
        valueRowsToInsert,
        chunkStart,
        chunkEnd
      )

      await client.chunk.update({
        where: {id: newChunk.id},
        data: {
          minDate: filteredMinDate,
          maxDate: filteredMaxDate,
          parsingInfo: {
            ...getObjectMetadata(parsingInfo),
            valuesSkipped: skippedValueCount > 0,
            conflictPolicy: normalizedConflictPolicy,
            conflictReason: 'CHUNK_VALUES_CONFLICT',
            skippedValueCount,
            insertedValueCount: valueRowsToInsert.length
          },
          metadata: {
            ...getObjectMetadata(newChunk.metadata),
            totalWaterVolumeWithdrawn: filteredTotalWaterVolumeWithdrawn,
            totalWaterVolumeDischarged: filteredTotalWaterVolumeDischarged,
            metrics: buildMetricMetadataForValueRows(chunk.series, valueRowsToInsert)
          }
        }
      })
    }

    const insertedTotalWaterVolumeWithdrawn = computeTotalWaterVolumeForValueRows(
      valueRowsToInsert,
      METRIC_TYPE_CODES.VOLUME_PRELEVE
    )
    const insertedTotalWaterVolumeDischarged = computeTotalWaterVolumeForValueRows(
      valueRowsToInsert,
      METRIC_TYPE_CODES.VOLUME_REJETE
    )

    sourceTotalWaterVolumeWithdrawn += insertedTotalWaterVolumeWithdrawn
    sourceTotalWaterVolumeDischarged += insertedTotalWaterVolumeDischarged

    if (conflictResolution.shouldSkip) {
      logger.warn(
        `Valeurs du chunk ignorées à cause d'un conflit existant: chunkId=${newChunk.id}, policy=${normalizedConflictPolicy}, skipped=${skippedValueCount}`
      )

      if (matchedDeclarantUserId) {
        matchedDeclarantUserIds.add(matchedDeclarantUserId)
      }

      continue
    }

    await client.chunkValue.createMany({
      data: valueRowsToInsert
    })
    createdValues += valueRowsToInsert.length
    matchedDeclarantUserIds.add(matchedDeclarantUserId)

    logger.log(`Valeurs insérées: chunkId=${newChunk.id}, count=${valueRowsToInsert.length}, skipped=${skippedValueCount}`)
  }

  const source = await client.source.findUnique({
    where: {id: sourceId},
    select: {metadata: true}
  })

  await client.source.update({
    where: {id: sourceId},
    data: {
      status: 'COMPLETED',
      globalInstructionStatus: computeGlobalPointMatchingStatus(chunkStatuses),
      metadata: {
        ...getObjectMetadata(source?.metadata),
        totalWaterVolumeWithdrawn: sourceTotalWaterVolumeWithdrawn,
        totalWaterVolumeDischarged: sourceTotalWaterVolumeDischarged
      }
    }
  })

  const declarantUserIdsToRefresh = [...matchedDeclarantUserIds].filter(Boolean)
  if (declarantUserIdsToRefresh.length > 0) {
    await client.declarant.updateMany({
      where: {
        userId: {
          in: declarantUserIdsToRefresh
        }
      },
      data: {
        lastDeclarationAt: new Date()
      }
    })
  }

  logger.log(`Source complétée: id=${sourceId}, status=COMPLETED`)
  logger.log(
    `Résumé: series=${data.series.length}, chunks=${createdChunks}, values=${createdValues}, matchedPoints=${matchedPoints}, unmatchedPoints=${unmatchedPoints}`
  )
}

export async function prepareDeclarationSourceForIngestion({
  declaration,
  client = prisma
}) {
  return client.$transaction(async tx => {
    const existingSource = await tx.source.findUnique({
      where: {declarationId: declaration.id},
      select: {
        id: true,
        metadata: true
      }
    })
    const metadata = getDeclarationSourceMetadata({
      declaration,
      existingMetadata: existingSource?.metadata
    })

    if (existingSource) {
      await tx.chunk.deleteMany({
        where: {sourceId: existingSource.id}
      })

      return tx.source.update({
        where: {id: existingSource.id},
        data: {
          type: 'DECLARATION',
          status: 'PROCESSING',
          globalInstructionStatus: 'TO_INSTRUCT',
          metadata
        }
      })
    }

    return tx.source.create({
      data: {
        type: 'DECLARATION',
        status: 'PROCESSING',
        declarationId: declaration.id,
        metadata
      }
    })
  })
}

export async function markDeclarationSourceIngestionFailed({
  sourceId,
  error,
  client = prisma
}) {
  const source = await client.source.findUnique({
    where: {id: sourceId},
    select: {
      metadata: true
    }
  })

  if (!source) {
    return null
  }

  return client.source.update({
    where: {id: sourceId},
    data: {
      status: 'FAILED',
      globalInstructionStatus: 'TO_INSTRUCT',
      metadata: {
        ...getObjectMetadata(source.metadata),
        processingError: getErrorMessage(error),
        processingFailedAt: new Date().toISOString()
      }
    }
  })
}

export async function ingestDeclarationSeries({
  declarationId,
  data,
  errors = [],
  logger = createLogger()
}) {
  logger.log(`Ingestion des données parsées pour la déclaration ${declarationId}`)

  const declaration = await getDeclarationWithFiles(declarationId)

  if (!declaration) {
    logger.error(`Déclaration ${declarationId} introuvable`)
    Sentry.captureException(new Error(`Déclaration ${declarationId} introuvable`))
    throw new Error(`Déclaration ${declarationId} introuvable`)
  }

  for (const error of errors) {
    logger.warn(typeof error === 'string' ? error : JSON.stringify(error))
  }

  if (!data?.series?.length) {
    logger.log('Aucune série à importer')
    return {
      sourceId: null,
      imported: false
    }
  }

  logger.log(`Séries à ingérer: ${data.series.length}`)
  const deferredReplacedSourceIds = new Set()

  const previousChunks = await prisma.chunk.findMany({
    where: {
      source: {
        declarationId: declaration.id
      },
      pointPrelevementId: {
        not: null
      }
    },
    select: {
      pointPrelevementId: true
    }
  })

  const source = await prepareDeclarationSourceForIngestion({
    declaration
  })
  logger.log(`Source préparée: id=${source.id}, type=${source.type}, status=PROCESSING`)

  try {
    await createChunksFromData(
      data,
      source.id,
      declaration.declarantUserId,
      declaration.createdByDeclarantUserId,
      declaration.autoValidationEnabled,
      logger,
      declaration.type,
      prisma,
      {deferredReplacedSourceIds}
    )
  } catch (error) {
    await markDeclarationSourceIngestionFailed({
      sourceId: source.id,
      error
    })

    throw error
  }

  await refreshReplacedSourcesAfterConflict([...deferredReplacedSourceIds])

  await refreshMostRecentAvailableDateForDeclarantPoints({
    declarantUserId: declaration.declarantUserId,
    pointPrelevementIds: previousChunks.map(chunk => chunk.pointPrelevementId)
  })

  return {
    sourceId: source.id,
    imported: true
  }
}

/**
 * Ancien point d'entrée BullMQ API.
 * Le traitement a été déplacé dans la brique d'orchestration.
 */
export async function processDeclaration(declarationId) {
  throw new Error(
    `processDeclaration(${declarationId}) ne doit plus être exécuté dans l’API PE. Le parsing est maintenant porté par la brique d’orchestration.`
  )
}

async function getDeclarationWithFiles(declarationId) {
  return prisma.declaration.findFirst({
    where: {id: declarationId},
    include: {files: true}
  })
}

function computeTotalWaterVolume(chunk, parameterName) {
  if (chunk.parameter !== parameterName) {
    return 0
  }

  let total = 0

  for (const datum of chunk.data ?? []) {
    const value = Number(datum.value)
    if (!Number.isNaN(value)) {
      total += value
    }
  }

  return total
}
