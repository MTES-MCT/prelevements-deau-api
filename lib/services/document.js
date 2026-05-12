import crypto, {randomUUID} from 'node:crypto'
import path from 'node:path'
import createHttpError from 'http-errors'
import * as DocumentModel from '../models/document.js'
import * as RegleModel from '../models/regle.js'
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

export async function uploadDocumentToS3({buffer, filename, declarantUserId, s3 = createStorageClient}) {
  const cleanedFilename = safeFilename(filename)
  const objectKey = `documents/${declarantUserId}/${crypto.randomUUID()}-${cleanedFilename}`
  await s3(DOCUMENTS_BUCKET).uploadObject(objectKey, buffer, {filename: cleanedFilename})
  return {objectKey, filename: cleanedFilename}
}

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

export async function updateDocument(documentId, payload) {
  const changes = validateDocumentChanges(payload)

  if (Object.keys(changes).length === 0) {
    throw createHttpError(400, 'Aucun champ valide trouvé.')
  }

  return DocumentModel.updateDocumentById(documentId, changes)
}

export async function deleteDocument(documentId) {
  const hasRegles = await RegleModel.documentHasRegles(documentId)

  if (hasRegles) {
    throw createHttpError(400, 'Ce document est lié à une ou plusieurs règles et ne peut être supprimé.')
  }

  return DocumentModel.deleteDocument(documentId)
}

export async function decorateDocument(document, {includeRelations = false, s3 = createStorageClient} = {}) {
  if (!document) {
    return null
  }

  const documentUrl = await s3(DOCUMENTS_BUCKET).getPresignedUrl(document.storageKey)

  const decorated = {
    ...document,
    downloadUrl: documentUrl
  }

  if (includeRelations) {
    const hasRegles = await RegleModel.documentHasRegles(document.id)

    decorated.hasRegles = hasRegles
    decorated.hasExploitations = Boolean(document.declarantPointPrelevementId)
  }

  return decorated
}
