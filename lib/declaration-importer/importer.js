/* eslint-disable no-await-in-loop */
import {createLogger} from '../util/logger.js'
import {prisma} from '../../db/prisma.js'
import * as Sentry from '@sentry/node'
import moment from 'moment'
import {randomUUID} from 'node:crypto'
import {computeGlobalInstructionStatus} from '../handlers/chunks.js'

async function createChunksFromData(data, sourceId, declarantUserId, autoValidationEnabled, logger) {
  let matchedPoints = 0
  let unmatchedPoints = 0
  let createdChunks = 0
  let createdValues = 0
  let sourceTotalWaterVolumeWithdrawn = 0
  let sourceTotalWaterVolumeDischarged = 0
  const chunkStatuses = []

  for (const chunk of data.series) {
    const pointPrelevementName = chunk.pointPrelevement
      .trim()
      .replaceAll(/\s+/g, ' ')

    const {unit, parameter, frequency, minDate, maxDate} = chunk

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

    if (pointPrelevement?.id) {
      const pointId = pointPrelevement.id

      const anyLink = await prisma.declarantPointPrelevement.findFirst({
        where: {
          declarantUserId,
          pointPrelevementId: pointId
        },
        select: {id: true}
      })

      // Cas 1 : y a-t-il un lien QUI OVERLAP la fenêtre du chunk ?
      const linkOnWindow = await prisma.declarantPointPrelevement.findFirst({
        where: {
          declarantUserId,
          pointPrelevementId: pointId,
          AND: [
            {OR: [{startDate: null}, {startDate: {lte: chunkEnd}}]},
            {OR: [{endDate: null}, {endDate: {gte: chunkStart}}]}
          ]
        },
        select: {id: true}
      })

      if (linkOnWindow?.id) {
        matchedPoints++
        pointPrelevementId = pointId
        parsingInfo = {
          case: 1,
          reason: 'POINT_FOUND_AND_LINK_ACTIVE_ON_WINDOW'
        }
        logger.log(
          `Point matché (lien déclarant OK sur période chunk): name="${pointPrelevementName}" -> id=${pointPrelevementId}`
        )
      } else if (anyLink?.id) {
        unmatchedPoints++
        parsingInfo = {
          case: 2,
          reason: 'POINT_FOUND_BUT_LINK_OUTSIDE_WINDOW',
          pointPrelevementName,
          pointPrelevementId: pointId,
          declarantUserId,
          otherExploitationId: anyLink.id,
          window: {from: chunkStart.toISOString(), to: chunkEnd.toISOString()},
          matchStrategy: 'PointPrelevement.name'
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

    const totalWaterVolumeWithdrawn = computeTotalWaterVolume(chunk, 'volume prélevé')
    const totalWaterVolumeDischarged = computeTotalWaterVolume(chunk, 'volume rejeté')

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

    const rows = chunk.data?.length ?? 0
    if (!rows) {
      logger.warn(`Chunk sans valeurs: chunkId=${newChunk.id}`)
      continue
    }

    await prisma.chunkValue.createMany({
      data: chunk.data.map(d => ({
        id: randomUUID(),
        chunkId: newChunk.id,
        metricTypeCode: parameter,
        unit,
        frequency,
        date: moment.utc(d.date, 'YYYY-MM-DD', true).hour(12).toDate(),
        value: Number(d.value)
      }))
    })
    createdValues += rows

    logger.log(`Valeurs insérées: chunkId=${newChunk.id}, count=${rows}`)
  }

  await prisma.source.update({
    where: {id: sourceId},
    data: {
      status: 'COMPLETED',
      globalInstructionStatus: computeGlobalInstructionStatus(chunkStatuses),
      metadata: {
        totalWaterVolumeWithdrawn: sourceTotalWaterVolumeWithdrawn,
        totalWaterVolumeDischarged: sourceTotalWaterVolumeDischarged
      }
    }
  })

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
