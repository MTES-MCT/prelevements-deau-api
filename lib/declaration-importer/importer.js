/**
 * Import des déclarations (template-file) : extraction → staging (StageMetric) → ingestion (Metric) si point matché.
 */

import {createLogger} from '../util/logger.js'
import {prisma} from '../../db/prisma.js'
import * as Sentry from '@sentry/node'
import createStorageClient from '../util/s3.js'
import {DECLARATIONS_BUCKET} from '../handlers/declarations.js'
import {extractTemplateFile} from '@fabnum/prelevements-deau-timeseries-parsers'

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function processDeclaration(declarationId, logger = createLogger()) {
  logger.log(`Traitement de la déclaration ${declarationId}`)

  const declaration = await getDeclarationWithFiles(declarationId)
  if (!declaration) {
    logger.error(`Déclaration ${declarationId} introuvable`)
    Sentry.captureException(new Error(`Déclaration ${declarationId} introuvable`))
    return
  }

  if (declaration.type !== 'template-file') {
    logger.log(`Type ${declaration.type} non supporté, abandon`)
    return
  }

  const templateFile = getTemplateFileFromDeclaration(declaration)
  if (!templateFile) {
    logger.error('Aucun fichier template-file à traiter')
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

  const pointIdByName = await resolvePointPrelevementIdsByName(
    data.series.map(s => s.pointPrelevement).filter(Boolean),
    logger
  )

  const stageMetricRows = buildStageMetricRowsFromSeries(data.series, pointIdByName)
  if (stageMetricRows.length === 0) {
    logger.log('Aucune valeur à insérer')
    return
  }

  await persistSourceStageMetricsAndIngestedMetrics(declaration, stageMetricRows, logger)
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
  return declaration.files.find(f => f.type === 'template-file') ?? declaration.files[0] ?? null
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
  if (!errors?.length) return
  for (const e of errors) {
    logger.warn(typeof e === 'string' ? e : JSON.stringify(e))
  }
}

// ---------------------------------------------------------------------------
// Matching points de prélèvement (nom → id)
// ---------------------------------------------------------------------------

/**
 * Résout les noms de points en IDs. Retourne une Map(nom → id).
 * Les noms sans point trouvé en base sont loggés en warning (données resteront en staging pour instruction).
 */
async function resolvePointPrelevementIdsByName(pointNames, logger) {
  const uniqueNames = [...new Set(pointNames)]
  const points = await prisma.pointPrelevement.findMany({
    where: {name: {in: uniqueNames}, deletedAt: null},
    select: {id: true, name: true}
  })
  const pointIdByName = new Map(points.map(p => [p.name, p.id]))
  for (const name of uniqueNames) {
    if (!pointIdByName.has(name)) {
      logger.warn(`Point non trouvé: "${name}" → métriques en attente d'instruction`)
    }
  }
  return pointIdByName
}

// ---------------------------------------------------------------------------
// Construction des lignes staging (StageMetric)
// ---------------------------------------------------------------------------

/**
 * Construit les lignes pour StageMetric à partir des séries extraites.
 * Chaque point (date, value) devient une ligne avec startDate/endDate = date (valeur ponctuelle).
 */
function buildStageMetricRowsFromSeries(series, pointIdByName) {
  const rows = []
  for (const serie of series) {
    const pointName = serie.pointPrelevement ?? null
    const pointPrelevementId = pointName ? pointIdByName.get(pointName) ?? null : null
    const metricTypeCode = serie.parameter ?? 'volume prélevé'
    const unit = serie.unit ?? null

    for (const point of serie.data ?? []) {
      const date = typeof point.date === 'string' ? new Date(point.date) : point.date
      if (Number.isNaN(date.getTime())) continue
      rows.push({
        pointPrelevementId,
        pointPrelevementName: pointName,
        metricTypeCode,
        unit,
        startDate: date,
        endDate: date,
        value: Number(point.value) ?? 0
      })
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// Persistance : Source + StageMetric + Metric (si point matché)
// ---------------------------------------------------------------------------

/**
 * En une transaction : crée la Source, insère toutes les lignes en StageMetric,
 * et ingère dans Metric uniquement les lignes dont le point a été matché.
 */
async function persistSourceStageMetricsAndIngestedMetrics(declaration, stageMetricRows, logger) {
  const matchedCount = stageMetricRows.filter(r => r.pointPrelevementId != null).length
  const unmatchedCount = stageMetricRows.length - matchedCount
  logger.log(
    `${stageMetricRows.length} ligne(s) en staging, ${matchedCount} point(s) matché(s), ${unmatchedCount} en attente d'instruction`
  )

  try {
    const source = await prisma.$transaction(async tx => {
      const newSource = await tx.source.create({
        data: {
          type: 'DECLARATION',
          status: 'COMPLETED',
          declarationId: declaration.id,
          start: declaration.startMonth,
          end: declaration.endMonth,
          metadata: {
            declarationType: declaration.type,
            fileCount: declaration.files.length
          }
        }
      })

      await tx.stageMetric.createMany({
        data: stageMetricRows.map(row => ({...row, sourceId: newSource.id}))
      })

      if (matchedCount > 0) {
        const metricRows = stageMetricRows
          .filter(row => row.pointPrelevementId != null)
          .map(row => ({
            pointPrelevementId: row.pointPrelevementId,
            pointPrelevementName: row.pointPrelevementName,
            metricTypeCode: row.metricTypeCode,
            unit: row.unit,
            startDate: row.startDate,
            endDate: row.endDate,
            value: row.value,
            sourceId: newSource.id
          }))
        await tx.metric.createMany({data: metricRows})
      }

      return newSource
    })

    logger.log(`Source ${source.id}: ${stageMetricRows.length} en staging, ${matchedCount} ingéré(s) dans Metric`)
  } catch (err) {
    const message = err?.message ?? String(err)
    const stack = err?.stack ?? ''
    logger.error(`Erreur: ${message}`)
    if (stack) logger.error(stack)
    console.error('[process-declaration] Erreur:', err)
    Sentry.captureException(err)
    throw err
  }
}
