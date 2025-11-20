import * as DossierModel from '../models/dossier.js'
import * as SerieService from './serie.js'
import {addJobConsolidateDossier, addJobProcessAttachment} from '../queues/jobs.js'

/**
 * Service layer pour les dossiers et attachments
 * Contient la logique métier et l'orchestration entre models
 */

/**
 * Crée un nouvel attachment et déclenche son traitement
 * @param {Object} params - Paramètres de création
 * @returns {Promise<Object>} - Attachment créé avec _id
 */
export async function createAttachment(params) {
  const attachment = await DossierModel.createAttachment(params)

  // Déclencher le traitement de l'attachment (avec debounce de 2s)
  await addJobProcessAttachment(attachment._id.toString())

  return attachment
}

/**
 * Met à jour un attachment et déclenche la consolidation si traité
 * @param {ObjectId|string} attachmentId - ID de l'attachment
 * @param {Object} changes - Modifications à apporter
 * @returns {Promise<void>}
 */
export async function updateAttachment(attachmentId, changes) {
  await DossierModel.updateAttachment(attachmentId, changes)

  // Si l'attachment a été traité, déclencher la consolidation
  if (changes.processed) {
    const attachment = await DossierModel.getAttachment(attachmentId)
    if (attachment) {
      await markDossierForReconsolidation(attachment.dossierId)
    }
  }
}

/**
 * Marque un attachment pour retraitement et déclenche le job
 * @param {ObjectId|string} attachmentId - ID de l'attachment
 * @returns {Promise<Object>} - Attachment mis à jour
 */
export async function markAttachmentForReprocessing(attachmentId) {
  const result = await DossierModel.markAttachmentForReprocessing(attachmentId)

  if (result) {
    await addJobProcessAttachment(attachmentId.toString())
  }

  return result
}

/**
 * Marque un dossier pour reconsolidation et déclenche le job
 * @param {ObjectId} dossierId - ID du dossier
 * @returns {Promise<Object>} - Dossier mis à jour
 */
export async function markDossierForReconsolidation(dossierId) {
  const result = await DossierModel.markDossierForReconsolidation(dossierId)

  if (result) {
    await addJobConsolidateDossier(dossierId.toString())
  }

  return result
}

/**
 * Supprime des attachments par storageKey et déclenche la reconsolidation
 * @param {ObjectId} dossierId - ID du dossier
 * @param {Array<string>} storageKeys - Liste des storageKeys à supprimer
 * @returns {Promise<void>}
 */
export async function removeAttachmentsByStorageKey(dossierId, storageKeys) {
  if (!storageKeys || storageKeys.length === 0) {
    return
  }

  const attachments = await DossierModel.getAttachmentsByStorageKey(dossierId, storageKeys)

  if (attachments.length === 0) {
    return
  }

  const attachmentIds = attachments.map(a => a._id)

  // Supprimer en cascade : intégrations + séries + valeurs pour chaque attachment (parallèle)
  await Promise.all(
    attachmentIds.map(async id => {
      await SerieService.deleteSeriesByAttachmentWithIntegrations(id)
    })
  )

  // Supprimer les documents attachments
  await DossierModel.deleteAttachmentsByIds(attachmentIds)

  // Marquer le dossier pour reconsolidation
  await DossierModel.markDossierForReconsolidation(dossierId)

  // Déclencher immédiatement la reconsolidation (avec debounce de 5s)
  await addJobConsolidateDossier(dossierId.toString())
}
