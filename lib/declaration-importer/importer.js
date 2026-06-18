/* eslint-disable no-await-in-loop */
import {createLogger} from '../util/logger.js'
import {prisma} from '../../db/prisma.js'
import * as Sentry from '@sentry/node'
import moment from 'moment'
import {randomUUID} from 'node:crypto'
import {computeGlobalInstructionStatus} from '../handlers/chunks.js'
import {METRIC_TYPE_CODES} from '../constants/metric-type-codes.js'
import {computePeriodEnd, normalizeTemporalStart} from '../util/temporal-discretization.js'
import {
  applyConflictPolicyForIncomingChunkValues,
  normalizeConflictPolicy,
  CHUNK_VALUE_CONFLICT_POLICIES
} from '../services/chunk-value-conflicts.js'

const USAGE_EAU_VALUES = [
  'INCONNU',
  'PAS_D_USAGE',
  'IRRIGATION',
  'AGRICULTURE_ELEVAGE',
  'AQUACULTURE',
  'INDUSTRIE',
  'AEP',
  'ENERGIE',
  'LOISIRS',
  'EMBOUTEILLAGE',
  'THERMALISME_THALASSO',
  'DEFENSE_INCENDIE',
  'REALIMENTATION_EAU',
  'CANAUX',
  'ETIAGE',
  'ENTRETIEN_VOIRIES',
  'ALIMENTATION_SOUTIEN_CANAL',
  'DOMESTIQUE'
]

const USAGE_EAU_SET = new Set(USAGE_EAU_VALUES)

function getUsageEauValue(value) {
  return typeof value === 'string' && USAGE_EAU_SET.has(value) ? value : null
}

function appendMissingUsage(usages = [], usage) {
  const existingUsages = Array.isArray(usages) ? usages : []

  if (!usage || existingUsages.includes(usage)) {
    return existingUsages
  }

  return [...existingUsages, usage]
}

function getObjectMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {}
  }

  return metadata
}

function activeWindowWhere(chunkStart, chunkEnd) {
  return {
    AND: [
      {OR: [{startDate: null}, {startDate: {lte: chunkEnd}}]},
      {OR: [{endDate: null}, {endDate: {gte: chunkStart}}]}
    ]
  }
}

async function getDeclarantRole(declarantUserId) {
  const declarant = await prisma.declarant.findUnique({
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
  declarantUserId,
  pointId,
  chunkStart,
  chunkEnd
}) {
  const anyLink = await prisma.declarantPointPrelevement.findFirst({
    where: {
      declarantUserId,
      pointPrelevementId: pointId
    },
    select: {id: true, declarantUserId: true}
  })

  const linkOnWindow = await prisma.declarantPointPrelevement.findFirst({
    where: {
      declarantUserId,
      pointPrelevementId: pointId,
      ...activeWindowWhere(chunkStart, chunkEnd)
    },
    select: {id: true, declarantUserId: true, usages: true}
  })

  return {
    anyLink,
    linkOnWindow,
    matchStrategy: 'PointPrelevement.name'
  }
}

async function getCollecteurPointAccess({
  collecteurUserId,
  pointId,
  chunkStart,
  chunkEnd
}) {
  const anyLink = await prisma.declarantCollecteurExploitation.findFirst({
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

  const linkOnWindow = await prisma.declarantCollecteurExploitation.findFirst({
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
          usages: true
        }
      }
    }
  })

  return {
    anyLink: anyLink
      ? {
        id: anyLink.exploitation.id,
        collecteurLinkId: anyLink.id
      }
      : null,
    linkOnWindow: linkOnWindow?.exploitation
      ? {
        id: linkOnWindow.exploitation.id,
        declarantUserId: linkOnWindow.exploitation.declarantUserId,
        usages: linkOnWindow.exploitation.usages,
        collecteurLinkId: linkOnWindow.id
      }
      : null,
    matchStrategy: 'PointPrelevement.name + DeclarantCollecteurExploitation'
  }
}

async function createChunksFromData(data, sourceId, declarantUserId, autoValidationEnabled, logger) {
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
  const declarantRole = await getDeclarantRole(declarantUserId)
  const matchedDeclarantUserIds = new Set()

  for (const chunk of data.series) {
    const pointPrelevementName = chunk.pointPrelevement
      .trim()
      .replaceAll(/\s+/g, ' ')

    const {unit, parameter, frequency, minDate, maxDate} = chunk
    const usage = getUsageEauValue(chunk.usage)

    logger.log(
      `Chunk: point="${pointPrelevementName}", metricTypeCode="${parameter}", unit="${unit}", frequency="${frequency}", minDate=${minDate}, maxDate=${maxDate}, values=${chunk.data?.length ?? 0}`
    )

    const chunkStart = moment.utc(minDate, 'YYYY-MM-DD', true).startOf('day').toDate()
    const chunkEnd = moment.utc(maxDate, 'YYYY-MM-DD', true).endOf('day').toDate()

    /**
     * Identification du point de prélèvement associé
     *
     * Cas 1 : le point de prélèvement existe et le déclarant a un lien actif sur la période du chunk
     * Cas 2 : le point de prélèvement existe, une exploitation existe mais la période du chunk ne correspond pas
     * Cas 3 : le point de prélèvement existe, mais aucune exploitation n'existe pour le déclarant
     * Cas 4 : le point de prélèvement n'existe pas
     */

    const pointPrelevement
      = await prisma.pointPrelevement.findFirst({
        where: {
          name: pointPrelevementName,
          deletedAt: null
        },
        select: {id: true}
      })
      || await prisma.pointPrelevement.findFirst({
        where: {
          name: {
            contains: pointPrelevementName,
            mode: 'insensitive'
          },
          deletedAt: null
        },
        select: {id: true}
      })

    let pointPrelevementId = null
    let parsingInfo = null
    let usageExploitation = null
    let matchedDeclarantUserId = null

    if (pointPrelevement?.id) {
      const pointId = pointPrelevement.id

      const directAccess = await getDirectPointAccess({
        declarantUserId,
        pointId,
        chunkStart,
        chunkEnd
      })

      let pointAccess = directAccess

      if (!directAccess.linkOnWindow && declarantRole === 'COLLECTEUR') {
        const collecteurAccess = await getCollecteurPointAccess({
          collecteurUserId: declarantUserId,
          pointId,
          chunkStart,
          chunkEnd
        })

        if (collecteurAccess.linkOnWindow || (!directAccess.anyLink && collecteurAccess.anyLink)) {
          pointAccess = collecteurAccess
        }
      }

      if (pointAccess.linkOnWindow?.id) {
        usageExploitation = pointAccess.linkOnWindow
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

    const totalWaterVolumeWithdrawn = computeTotalWaterVolume(chunk, METRIC_TYPE_CODES.VOLUME_PRELEVE)
    const totalWaterVolumeDischarged = computeTotalWaterVolume(chunk, METRIC_TYPE_CODES.VOLUME_REJETE)

    sourceTotalWaterVolumeWithdrawn += totalWaterVolumeWithdrawn
    sourceTotalWaterVolumeDischarged += totalWaterVolumeDischarged

    const isValidated = parsingInfo.case === 1 && autoValidationEnabled !== false
    const instructionStatus = isValidated ? 'VALIDATED' : 'PENDING'
    chunkStatuses.push(instructionStatus)

    const newChunk = await prisma.chunk.create({
      data: {
        id: randomUUID(),
        instructionStatus,
        sourceId,
        pointPrelevementName,
        pointPrelevementId,
        usage,
        minDate: chunkStart,
        maxDate: chunkEnd,
        parsingInfo,
        metadata: {
          totalWaterVolumeWithdrawn,
          totalWaterVolumeDischarged
        }
      }
    })

    createdChunks++

    logger.log(
      `Chunk créé: id=${newChunk.id}, pointId=${newChunk.pointPrelevementId ?? 'null'}, parsingInfo=${parsingInfo?.reason ?? 'n/a'}`
    )

    const rawValues = chunk.data ?? []
    if (rawValues.length === 0) {
      logger.warn(`Chunk sans valeurs: chunkId=${newChunk.id}`)
      continue
    }

    const valueRows = rawValues
      .map(d => {
        const periodStart = normalizeTemporalStart(d.date)
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
          value: Number(d.value)
        }
      })
      .filter(Boolean)

    if (valueRows.length === 0) {
      logger.warn(`Chunk sans valeur temporelle valide: chunkId=${newChunk.id}`)
      continue
    }

    let conflictResolution
    try {
      conflictResolution = await applyConflictPolicyForIncomingChunkValues({
        pointPrelevementId,
        valueRows,
        requestedPolicy: normalizedConflictPolicy,
        replaceComment: 'AUTO_REPLACED_BY_INGEST'
      })
    } catch (error) {
      await prisma.chunk.delete({where: {id: newChunk.id}})
      createdChunks--
      throw error
    }

    if (conflictResolution.shouldSkip) {
      logger.warn(
        `Chunk ignoré à cause d'un conflit existant et d'une politique SKIP_NEW_CHUNK: chunkId=${newChunk.id}`
      )
      await prisma.chunk.delete({where: {id: newChunk.id}})
      createdChunks--
      chunkStatuses.pop()
      continue
    }

    if (usageExploitation) {
      const usages = appendMissingUsage(usageExploitation.usages, usage)

      if (usages.length > (usageExploitation.usages ?? []).length) {
        await prisma.declarantPointPrelevement.update({
          where: {id: usageExploitation.id},
          data: {usages}
        })
        usageExploitation.usages = usages
      }
    }

    await prisma.chunkValue.createMany({
      data: valueRows
    })
    createdValues += valueRows.length
    matchedDeclarantUserIds.add(matchedDeclarantUserId)

    logger.log(`Valeurs insérées: chunkId=${newChunk.id}, count=${valueRows.length}`)
  }

  const source = await prisma.source.findUnique({
    where: {id: sourceId},
    select: {metadata: true}
  })

  await prisma.source.update({
    where: {id: sourceId},
    data: {
      status: 'COMPLETED',
      globalInstructionStatus: computeGlobalInstructionStatus(chunkStatuses),
      metadata: {
        ...getObjectMetadata(source?.metadata),
        totalWaterVolumeWithdrawn: sourceTotalWaterVolumeWithdrawn,
        totalWaterVolumeDischarged: sourceTotalWaterVolumeDischarged
      }
    }
  })

  const declarantUserIdsToRefresh = [...matchedDeclarantUserIds].filter(Boolean)
  if (declarantUserIdsToRefresh.length > 0) {
    await prisma.declarant.updateMany({
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

  const newSource = await prisma.$transaction(async tx => {
    await tx.source.deleteMany({
      where: {declarationId: declaration.id}
    })

    return tx.source.create({
      data: {
        type: 'DECLARATION',
        status: 'PENDING',
        declarationId: declaration.id,
        metadata: {
          declarationType: declaration.type,
          fileCount: declaration.files.length
        }
      }
    })
  })

  logger.log(`Source créée: id=${newSource.id}, type=${newSource.type}, status=PENDING`)

  await createChunksFromData(
    data,
    newSource.id,
    declaration.declarantUserId,
    declaration.autoValidationEnabled,
    logger
  )

  return {
    sourceId: newSource.id,
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
