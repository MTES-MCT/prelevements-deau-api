import {createHash} from 'node:crypto'
import createHttpError from 'http-errors'
import * as DocumentModel from '../models/document.js'
import * as RegleModel from '../models/regle.js'
import * as ExploitationModel from '../models/exploitation.js'
import {validateDocumentChanges, validateDocumentCreation} from '../validation/document-validation.js'
import s3Default from '../util/s3.js'

/**
 * Service layer pour les documents
 * Contient la logique métier et l'orchestration entre models
 */

/**
 * Upload un document vers S3 de manière idempotente
 * @param {Object} options
 * @param {Buffer} options.buffer - Contenu du fichier
 * @param {string} options.filename - Nom du fichier
 * @param {string} options.codeTerritoire - Code territoire
 * @param {number} options.preleveurSeqId - ID séquentiel du préleveur (pour la clé S3)
 * @param {Function} options.s3 - Instance S3 (optionnel, pour injection dans tests)
 * @returns {Promise<{objectKey: string, skipped: boolean}>}
 */
export async function uploadDocumentToS3({buffer, filename, codeTerritoire, preleveurSeqId, s3 = s3Default}) {
  // Mode idempotent : hash du fichier
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 8)
  const objectKey = `${codeTerritoire}/${preleveurSeqId}/${hash}/${filename}`

  // Vérifier si existe déjà
  const exists = await s3('documents').objectExists(objectKey)
  if (exists) {
    return {objectKey, skipped: true}
  }

  await s3('documents').uploadObject(objectKey, buffer, {filename})

  return {objectKey, skipped: false}
}

/**
 * Crée un document (validation + upload S3 + insert MongoDB)
 * Utilisé par l'API pour créer un document unitaire
 */
export async function createDocument({payload, file, preleveurSeqId, preleveurObjectId, codeTerritoire, s3 = s3Default}) {
  const document = validateDocumentCreation(payload)
  const {originalname, buffer, size} = file

  if (!buffer) {
    throw createHttpError(400, 'Aucun fichier envoyé')
  }

  // Upload vers S3 (toujours avec hash pour l'idempotence)
  const {objectKey} = await uploadDocumentToS3({
    buffer,
    filename: originalname,
    codeTerritoire,
    preleveurSeqId,
    s3
  })

  document.preleveur = preleveurObjectId
  document.nom_fichier = originalname
  document.taille = size
  document.objectKey = objectKey

  try {
    return await DocumentModel.insertDocument(document, codeTerritoire)
  } catch (error) {
    // Rollback : supprimer le fichier S3 en cas d'erreur
    await s3('documents').deleteObject(objectKey, true)
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
 */
export async function decorateDocument(document, s3 = s3Default) {
  const documentUrl = await s3('documents').getPresignedUrl(document.objectKey)

  // Vérifier si le document est lié à des règles ou exploitations
  const [hasRegles, hasExploitations] = await Promise.all([
    RegleModel.documentHasRegles(document._id),
    ExploitationModel.exploitationHasDocument(document._id)
  ])

  return {
    ...document,
    downloadUrl: documentUrl,
    hasRegles,
    hasExploitations
  }
}
