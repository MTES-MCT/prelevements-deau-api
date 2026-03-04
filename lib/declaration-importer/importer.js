/* eslint-disable no-await-in-loop */
import {createLogger} from '../util/logger.js'
import {prisma} from '../../db/prisma.js'
import * as Sentry from '@sentry/node'
import createStorageClient from '../util/s3.js'
import {DECLARATIONS_BUCKET} from '../handlers/declarations.js'
import {extractTemplateFile} from '@fabnum/prelevements-deau-timeseries-parsers'
import moment from 'moment'
import {randomUUID} from 'node:crypto'

async function createChunksFromData(data, sourceId, declarantUserId, logger) {
  let matchedPoints = 0
  let unmatchedPoints = 0
  let createdChunks = 0
  let createdValues = 0
  let sourceTotalWaterVolumeWithdrawn = 0
  let sourceTotalWaterVolumeDischarged = 0

  for (const chunk of data.series) {
    const pointPrelevementName = chunk.pointPrelevement
    const {unit, parameter, frequency, minDate, maxDate} = chunk

    logger.log(
      `Chunk: point="${pointPrelevementName}", metricTypeCode="${parameter}", unit="${unit}", frequency="${frequency}", minDate=${minDate}, maxDate=${maxDate}, values=${chunk.data?.length ?? 0}`
    )

    const chunkStart = moment(minDate).startOf('day').toDate()
    const chunkEnd = moment(maxDate).endOf('day').toDate()

    /**
     * Identification du point de prélèvement associé
     *
     * Cas 1 : le point de prélèvement existe et le déclarant a un lien actif sur la période du chunk -> chunk lié au point de prélèvement + chunk.parsingInfo avec un message d'explication qui explique comment a été initialement trouvé le point associé
     * Cas 2 : le point de prélèvement existe, une exploitation existe mais la période du chunk ne correspond pas aux dates de l'exploitation -> chunk non lié + chunk.parsingInfo avec un message d'explication dédié
     * Cas 3 : le point de prélèvement existe, mais aucune exploitation n'existe pour le déclarant -> chunk non lié + chunk.parsingInfo avec un message d'explication dédié
     * Cas 4 : le point de prélèvement n'existe pas -> chunk non lié + chunk.parsingInfo avec un message d'explication dédié
     */

    const pointPrelevement = await prisma.pointPrelevement.findFirst({
      where: {name: pointPrelevementName, deletedAt: null},
      select: {id: true}
    })

    let pointPrelevementId = null
    let parsingInfo = null

    if (pointPrelevement?.id) {
      const pointId = pointPrelevement.id
      // Cas 2 vs Cas 3 : y a-t-il AU MOINS un lien (peu importe dates) ?
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
      logger.warn(
        `Point non trouvé: name="${pointPrelevementName}"`
      )
    }

    const totalWaterVolumeWithdrawn = computeTotalWaterVolume(chunk, 'volume prélevé')
    const totalWaterVolumeDischarged = computeTotalWaterVolume(chunk, 'volume rejeté')

    sourceTotalWaterVolumeWithdrawn += totalWaterVolumeWithdrawn
    sourceTotalWaterVolumeDischarged += totalWaterVolumeDischarged

    const newChunk = await prisma.chunk.create({
      data: {
        id: randomUUID(),
        instructionStatus: 'PENDING',
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
        date: moment(d.date).toDate(),
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

export async function processDeclaration(declarationId, logger = createLogger()) {
  logger.log(`Traitement de la déclaration ${declarationId}`)

  const declaration = await getDeclarationWithFiles(declarationId)
  if (!declaration) {
    logger.error(`Déclaration ${declarationId} introuvable`)
    Sentry.captureException(new Error(`Déclaration ${declarationId} introuvable`))
    return
  }

  // TODO: handle other types
  if (declaration.type !== 'template-file') {
    logger.log(`Type ${declaration.type} non supporté, abandon`)
    return
  }

  const templateFile = declaration.files.find(f => f.type === 'template-file')
  if (!templateFile) {
    logger.error('Aucun fichier template-file à traiter')
    Sentry.captureException(new Error(`Déclaration ${declarationId} : aucun fichier template-file trouvé`))
    return
  }

  logger.log(`Déclaration type=${declaration.type}, ${declaration.files.length} fichier(s)`)

  const buffer = await downloadFileFromStorage(templateFile.storageKey, logger)
  const {errors, data} = await extractSeriesFromTemplateFile(buffer, logger)

  logExtractionErrors(errors, logger)
  if (!data?.series?.length) {
    logger.log('Aucune série à importer')
    return
  }

  logger.log(`Séries extraites: ${data.series.length}`)

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

  const {declarantUserId} = declaration
  logger.log(`Source créée: id=${newSource.id}, type=${newSource.type}, status=PENDING`)

  await createChunksFromData(data, newSource.id, declarantUserId, logger)
}

// ---------------------------------------------------------------------------
// Lecture déclaration et fichier
// ---------------------------------------------------------------------------

async function getDeclarationWithFiles(declarationId) {
  return prisma.declaration.findFirst({
    where: {id: declarationId},
    include: {files: true}
  })
}

function getTemplateFileFromDeclaration(declaration) {
  return declaration.files.find(f => f.type === 'template-file')
}

async function downloadFileFromStorage(storageKey, logger) {
  const storage = createStorageClient(DECLARATIONS_BUCKET)
  logger.log(`Téléchargement ${storageKey}...`)
  try {
    const buffer = await storage.downloadObject(storageKey)
    logger.log(`Fichier téléchargé (${buffer?.length ?? 0} octets)`)
    return buffer
  } catch (error) {
    logger.error(`Erreur téléchargement: ${error.message}`)
    console.error('[process-declaration] Téléchargement S3:', error)
    Sentry.captureException(error)
    throw error
  }
}

// ---------------------------------------------------------------------------
// Extraction template-file (parser)
// ---------------------------------------------------------------------------

async function extractSeriesFromTemplateFile(buffer, logger) {
  logger.log('Extraction template-file en cours...')
  try {
    const result = await extractTemplateFile(buffer)
    logger.log(
      `Extraction terminée: ${result.errors?.length ?? 0} erreur(s), données: ${result.data ? 'oui' : 'non'}`
    )
    return {errors: result.errors ?? [], data: result.data}
  } catch (error) {
    logger.error(`Erreur extractTemplateFile: ${error.message}`)
    console.error('[process-declaration] extractTemplateFile:', error)
    Sentry.captureException(error)
    throw error
  }
}

function logExtractionErrors(errors, logger) {
  if (!errors?.length) {
    return
  }

  for (const e of errors) {
    logger.warn(e)
  }
}

function computeTotalWaterVolume(chunk, parameterName) {
  if (chunk.parameter !== parameterName) {
    return 0
  }

  return (chunk.data ?? []).reduce((total, d) => {
    const value = Number(d.value)
    return Number.isNaN(value) ? total : total + value
  }, 0)
}
