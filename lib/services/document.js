import crypto, {randomUUID} from 'node:crypto'
import path from 'node:path'
import createHttpError from 'http-errors'
import * as DocumentModel from '../models/document.js'
import * as RegleModel from '../models/regle.js'
import * as ExploitationModel from '../models/exploitation.js'
import {validateDocumentChanges, validateDocumentCreation} from '../validation/document-validation.js'
import createStorageClient from '../util/s3.js'
import * as Sentry from '@sentry/node'

export const DOCUMENTS_BUCKET = 'documents'

function safeFilename(filename) {
  return path.basename(filename || 'file')
    .normalize('NFC')
    .replaceAll(/[^\p{L}\p{N}._-]+/gu, '_')
    .slice(0, 180)
}

/**
 * Service layer pour les documents
 * Contient la logique métier et l'orchestration entre models
 */

/**
 * Upload un document vers S3 de manière idempotente
 * @param {Object} options
 * @param {Buffer} options.buffer - Contenu du fichier
 * @param {string} options.filename - Nom du fichier
 * @param {number} options.preleveurSeqId - ID séquentiel du préleveur (pour la clé S3)
 * @param {Function} options.s3 - Instance S3 (optionnel, pour injection dans tests)
 * @returns {Promise<{objectKey: string, skipped: boolean}>}
 */
export async function uploadDocumentToS3({buffer, filename, declarantUserId, s3 = createStorageClient}) {
  const cleanedFilename = safeFilename(filename)
  const objectKey = `documents/${declarantUserId}/${crypto.randomUUID()}-${cleanedFilename}`
  await s3(DOCUMENTS_BUCKET).uploadObject(objectKey, buffer, {filename: cleanedFilename})
  return {objectKey, filename: cleanedFilename}
}

/**
 * Crée un document (validation + upload S3 + insert MongoDB)
 * Utilisé par l'API pour créer un document unitaire
 */
export async function createDocument({payload, file, declarantUserId, declarantPointPrelevementId = null, s3 = createStorageClient}) {
  const {declarantPointPrelevementId: payloadExploitationId, ...document} = validateDocumentCreation(payload)
  const linkedExploitationId = declarantPointPrelevementId ?? payloadExploitationId ?? null
  const {originalname, buffer, mimetype, size} = file || {}

  if (!buffer) {
    throw createHttpError(400, 'Aucun fichier envoyé')
  }

  const {objectKey, filename} = await uploadDocumentToS3({
    buffer,
    filename: originalname,
    declarantUserId,
    s3
  })

  try {
    return await DocumentModel.insertDocument({
      id: randomUUID(),
      ...document,
      declarantUserId,
      declarantPointPrelevementId: linkedExploitationId,
      filename,
      mimeType: mimetype ?? null,
      size,
      storageKey: objectKey
    })
  } catch (error) {
    Sentry.captureException(error)
    await s3(DOCUMENTS_BUCKET).deleteObject(objectKey, true)
    throw error
  }
}

/**
 * Met à jour un document (validation + update MongoDB)
 */
export async function updateDocument(documentId, payload) {
  const changes = validateDocumentChanges(payload)

  if (Object.keys(changes).length === 0) {
    throw createHttpError(400, 'Aucun champ valide trouvé.')
  }

  return DocumentModel.updateDocumentById(documentId, changes)
}

/**
 * Supprime un document (vérifications + soft delete + suppression S3)
 */
export async function deleteDocument(documentId) {
  // Vérifier si le document est référencé dans des règles
  const hasRegles = await RegleModel.documentHasRegles(documentId)

  if (hasRegles) {
    throw createHttpError(400, 'Ce document est lié à une ou plusieurs règles et ne peut être supprimé.')
  }

  // Vérifier si le document est référencé dans des exploitations
  const hasExploitations = await ExploitationModel.exploitationHasDocument(documentId)

  if (hasExploitations) {
    throw createHttpError(400, 'Ce document est lié à une ou plusieurs exploitations et ne peut être supprimé.')
  }

  // Si tout est OK, supprimer le document
  return DocumentModel.deleteDocument(documentId)
}

/**
 * Ajoute l'URL de téléchargement et les informations de dépendances à un document
 * @param {Object} document - Document à décorer
 * @param {Object} options - Options de décoration
 * @param {boolean} options.includeRelations - Inclure hasRegles et hasExploitations (opt-in, coûteux)
 * @param {Function} options.s3 - Instance S3 (optionnel, pour injection dans tests)
 */
export async function decorateDocument(document, {includeRelations = false, s3 = createStorageClient} = {}) {
  const documentUrl = await s3(DOCUMENTS_BUCKET).getPresignedUrl(document.storageKey)

  const decorated = {
    ...document,
    downloadUrl: documentUrl
  }

  // Calcul coûteux : uniquement si demandé explicitement (opt-in)
  if (includeRelations) {
    const [hasRegles, hasExploitations] = await Promise.all([
      RegleModel.documentHasRegles(document.id),
      ExploitationModel.exploitationHasDocument(document.id)
    ])

    decorated.hasRegles = hasRegles
    decorated.hasExploitations = hasExploitations
  }

  return decorated
}
