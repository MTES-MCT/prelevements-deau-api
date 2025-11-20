import * as SeriesModel from '../models/series.js'
import * as IntegrationModel from '../models/integration-journaliere.js'

/**
 * Service layer pour les séries temporelles
 * Contient la logique métier et l'orchestration entre models
 */

/**
 * Supprime les séries d'un attachment ainsi que les intégrations associées
 * @param {ObjectId|string} attachmentId - ID de l'attachment
 * @returns {Promise<{deletedSeries: number, deletedValues: number, deletedIntegrations: number}>}
 */
export async function deleteSeriesByAttachmentWithIntegrations(attachmentId) {
  // Supprimer les intégrations d'abord
  const {deletedCount: deletedIntegrations} = await IntegrationModel.deleteIntegrationsByAttachment(attachmentId)

  // Puis supprimer les séries et leurs valeurs
  const {deletedSeries, deletedValues} = await SeriesModel.deleteSeriesByAttachmentId(attachmentId)

  return {deletedSeries, deletedValues, deletedIntegrations}
}

/**
 * Compare les séries existantes avec les nouvelles séries (par hash)
 * @param {Array} existingSeries - Séries existantes avec leur hash
 * @param {Array} newSeries - Nouvelles séries avec leur hash
 * @returns {{toDelete: Array<ObjectId>, toCreate: Array, unchangedCount: number}}
 */
export function compareSeries(existingSeries, newSeries) {
  const existingHashes = new Map(existingSeries.map(s => [s.hash, s._id]))
  const newHashes = new Set(newSeries.map(s => s.hash))

  const toDelete = existingSeries
    .filter(s => !newHashes.has(s.hash))
    .map(s => s._id)

  const toCreate = newSeries
    .filter(s => !existingHashes.has(s.hash))

  const unchangedCount = newSeries.filter(s => existingHashes.has(s.hash)).length

  return {toDelete, toCreate, unchangedCount}
}
