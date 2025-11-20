/* eslint-disable no-await-in-loop */
import {
  extractCamionCiterne,
  extractMultiParamFile
} from '@fabnum/prelevements-deau-timeseries-parsers'

import {getAttachmentObjectKey} from '@fabnum/demarches-simplifiees'
import hashObject from 'hash-object'

import {parseObjectId} from '../../util/mongo.js'
import s3 from '../../util/s3.js'

import * as Dossier from '../../models/dossier.js'
import * as DossierService from '../../services/dossier.js'
import * as SerieService from '../../services/serie.js'
import {insertSeriesWithValues, deleteSeriesByIds, getSeriesHashesByAttachmentId} from '../../models/series.js'
import {addJobProcessAttachment} from '../../queues/jobs.js'
import {createLogger} from '../../util/logger.js'
import {normalizeSeries} from './normalize.js'

export async function processAttachmentsMaintenance(logger = createLogger()) {
  const attachments = await Dossier.getUnprocessedAttachments()
  logger.log(`Création de ${attachments.length} jobs de traitement d'attachments`)
  for (const attachment of attachments) {
    try {
      await addJobProcessAttachment(attachment._id.toString())
    } catch (error) {
      logger.error(`Erreur lors de la création du job pour l'attachment ${attachment._id}: ${error.message}`)
    }
  }
}

export async function processAttachment(attachmentId, logger = createLogger()) {
  // Conversion string → ObjectId si nécessaire
  const attachmentObjectId = typeof attachmentId === 'string' ? parseObjectId(attachmentId) : attachmentId

  if (!attachmentObjectId) {
    logger.log(`ID invalide: ${attachmentId}, abandon`)
    return
  }

  const attachment = await Dossier.getAttachment(attachmentObjectId)
  if (!attachment) {
    logger.log(`Attachment ${attachmentId} non trouvé, abandon`)
    return
  }

  if (attachment.processed) {
    logger.log(`Attachment ${attachmentId} déjà traité, abandon`)
    return
  }

  await processAttachmentInternal(attachment)
}

/**
 * Parse un buffer selon le type de prélèvement
 * @param {string} type - Type de prélèvement ('camion-citerne', 'aep-zre', 'icpe-hors-zre')
 * @param {Buffer} buffer - Buffer contenant les données du fichier
 * @returns {Promise<{errors: Array, series: Array}>} Erreurs et séries parsées
 */
export async function parseBuffer(type, buffer) {
  if (type === 'camion-citerne') {
    const {errors, data} = await extractCamionCiterne(buffer)
    return {
      errors: errors || [],
      series: data?.series || []
    }
  }

  if (type === 'aep-zre' || type === 'icpe-hors-zre') {
    const {errors, data} = await extractMultiParamFile(buffer)
    return {
      errors: errors || [],
      series: data?.series || []
    }
  }

  return {
    errors: [],
    series: []
  }
}

/**
 * Normalise les erreurs en ajoutant une severity par défaut
 * @param {Array} errors - Liste des erreurs brutes
 * @returns {Array} Liste des erreurs normalisées
 */
export function normalizeErrors(errors) {
  if (!errors || errors.length === 0) {
    return []
  }

  return errors.map(error => ({
    ...error,
    severity: error.severity || 'error'
  }))
}

/**
 * Crée un résumé des erreurs et limite à 50 erreurs max
 * @param {Array} errors - Liste des erreurs normalisées
 * @returns {{errors: Array, errorSummary: Object}} Erreurs limitées et résumé
 */
export function summarizeErrors(errors) {
  const errorSummary = errors.length > 0
    ? {
      total: errors.length,
      error: errors.filter(e => e.severity === 'error').length,
      warning: errors.filter(e => e.severity === 'warning').length
    }
    : {total: 0}

  let limitedErrors = [...errors]

  if (errors.length > 50) {
    limitedErrors = errors.slice(0, 50)
    limitedErrors.push({
      message: 'Le fichier contient plus de 50 erreurs. Les erreurs suivantes n\'ont pas été affichées.'
    })
  }

  return {
    errors: limitedErrors,
    errorSummary
  }
}

/**
 * Ajoute un hash à chaque série pour détecter les modifications
 * @param {Array} series - Liste des séries
 * @returns {Array} Liste des séries avec hash ajouté
 */
export function addHashToSeries(series) {
  if (!series || series.length === 0) {
    return []
  }

  return series.map(serie => ({
    ...serie,
    hash: hashObject(serie, {algorithm: 'sha256'}).slice(0, 12)
  }))
}

async function processAttachmentInternal(attachment) {
  const isSheetFile = isSheet(attachment.storageKey)

  if (!isSheetFile) {
    await DossierService.updateAttachment(attachment._id, {processed: true})
    return
  }

  const {ds, storageKey, territoire, typePrelevement, dossierId} = attachment

  const objectKey = getAttachmentObjectKey(
    ds.demarcheNumber,
    ds.dossierNumber,
    storageKey
  )

  let buffer

  try {
    buffer = await s3('ds').downloadObject(objectKey)
  } catch {
    await DossierService.updateAttachment(attachment._id, {
      processingError: `Unable to download file ${objectKey}`,
      processed: true
    })
  }

  const {errors: rawErrors, series} = await parseBuffer(typePrelevement, buffer)
  const normalizedSeries = normalizeSeries(series)
  const seriesWithHash = addHashToSeries(normalizedSeries)
  const errors = normalizeErrors(rawErrors)
  const {errors: limitedErrors, errorSummary} = summarizeErrors(errors)

  // Déterminer le status de validation maintenant
  let validationStatus = 'success'
  if (limitedErrors?.length > 0) {
    validationStatus = limitedErrors.some(error => error.severity === 'error') ? 'error' : 'warning'
  }

  const result = {
    errors: limitedErrors,
    series: seriesWithHash
  }

  // Récupérer les séries existantes et comparer avec les nouvelles
  const existingSeries = await getSeriesHashesByAttachmentId(attachment._id)
  const {toDelete, toCreate, unchangedCount} = SerieService.compareSeries(existingSeries, seriesWithHash)

  // Supprimer les séries obsolètes
  if (toDelete.length > 0) {
    await deleteSeriesByIds(toDelete)
  }

  // Créer uniquement les séries nouvelles ou modifiées
  let insertedSeriesIds = []

  if (toCreate.length > 0) {
    const insertResult = await insertSeriesWithValues({
      attachmentId: attachment._id,
      dossierId,
      territoire,
      series: toCreate
    })
    insertedSeriesIds = insertResult.insertedSeriesIds
  }

  const totalVolumePreleve = calculateTotalVolumePreleve(result.series)

  const attachmentMeta = {
    processed: true,
    validationStatus,
    result: {
      seriesCount: seriesWithHash.length,
      errorSummary,
      errors: result.errors,
      totalVolumePreleve,
      seriesStats: {
        created: insertedSeriesIds.length,
        deleted: toDelete.length,
        unchanged: unchangedCount
      }
    }
  }

  await DossierService.updateAttachment(attachment._id, attachmentMeta)
}

/* Helpers */

export function calculateTotalVolumePreleve(series) {
  if (!series) {
    return 0
  }

  let total = 0
  for (const s of series) {
    if (s.parameter !== 'volume prélevé' || !s.data) {
      continue
    }

    for (const dataPoint of s.data) {
      if (typeof dataPoint.value === 'number') {
        total += dataPoint.value
      }
    }
  }

  return total
}

function isSheet(filename) {
  const lcFilename = filename.toLowerCase()
  return lcFilename.endsWith('.xlsx') || lcFilename.endsWith('.xls') || lcFilename.endsWith('.ods')
}
