import {createLogger} from '../util/logger.js'
import {prisma} from '../../db/prisma.js'
import * as Sentry from '@sentry/node'
import createStorageClient from '../util/s3.js'
import {DECLARATIONS_BUCKET} from '../handlers/declarations.js'
import {extractTemplateFile} from '@fabnum/prelevements-deau-timeseries-parsers'
import moment from 'moment'
import {randomUUID} from "node:crypto";

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

  const templateFile = getTemplateFileFromDeclaration(declaration)
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

  logger.log(`Source créée: id=${newSource.id}, status=PENDING`)

  let matchedPoints = 0
  let unmatchedPoints = 0
  let createdChunks = 0
  let createdValues = 0

  for (const chunk of data.series) {
    const pointPrelevementName = chunk.pointPrelevement
    const { unit, parameter, frequency, minDate, maxDate } = chunk

    logger.log(
      `Chunk: point="${pointPrelevementName}", metricTypeCode="${parameter}", unit="${unit}", frequency="${frequency}", minDate=${minDate}, maxDate=${maxDate}, values=${chunk.data?.length ?? 0}`
    )

    const pointPrelevement = await prisma.pointPrelevement.findFirst({
      where: {name: pointPrelevementName, deletedAt: null},
      select: {id: true}
    })

    if (pointPrelevement?.id) {
      matchedPoints++
      logger.log(`Point matché: name="${pointPrelevementName}" -> id=${pointPrelevement.id}`)
    } else {
      unmatchedPoints++
      logger.warn(`Point NON matché: name="${pointPrelevementName}"`)
    }

    const newChunk = await prisma.chunk.create({
      data: {
        id: randomUUID(),
        sourceId: newSource.id,
        pointPrelevementName,
        pointPrelevementId: pointPrelevement?.id ?? null,
        minDate: moment(minDate).toDate(),
        maxDate: moment(maxDate).toDate(),
        instructionStatus: 'PENDING',
      }
    })
    createdChunks++

    logger.log(`Chunk créé: id=${newChunk.id}, sourceId=${newSource.id}, pointId=${newChunk.pointPrelevementId ?? 'null'}`)

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
        value: Number(d.value) ?? 0,
      })),
    })
    createdValues += rows

    logger.log(`Valeurs insérées: chunkId=${newChunk.id}, count=${rows}`)
  }

  await prisma.source.update({
    where: {id: newSource.id},
    data: {status: 'COMPLETED'},
  })

  logger.log(`Source complétée: id=${newSource.id}, status=COMPLETED`)
  logger.log(
    `Résumé: series=${data.series.length}, chunks=${createdChunks}, values=${createdValues}, matchedPoints=${matchedPoints}, unmatchedPoints=${unmatchedPoints}`
  )
  logger.log(`Fin traitement déclaration ${declarationId}`)
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
  } catch (err) {
    logger.error(`Erreur téléchargement: ${err.message}`)
    console.error('[process-declaration] Téléchargement S3:', err)
    Sentry.captureException(err)
    throw err
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
  } catch (err) {
    logger.error(`Erreur extractTemplateFile: ${err.message}`)
    console.error('[process-declaration] extractTemplateFile:', err)
    Sentry.captureException(err)
    throw err
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
