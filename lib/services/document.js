import crypto, {randomUUID} from 'node:crypto'
import path from 'node:path'
import createHttpError from 'http-errors'
import * as DocumentModel from '../models/document.js'
import * as RegleModel from '../models/regle.js'
import {prisma} from '../../db/prisma.js'
import {validateDocumentChanges, validateDocumentCreation} from '../validation/document-validation.js'
import createStorageClient from '../util/s3.js'
import * as Sentry from '@sentry/node'
import {getPermissionZoneIdsForUser} from './zone-permissions.js'

export const DOCUMENTS_BUCKET = 'documents'

export async function assertExploitationsBelongToDeclarant(
  exploitationIds,
  declarantUserId,
  {client = prisma} = {}
) {
  const uniqueIds = [...new Set(exploitationIds.filter(Boolean))]
  if (uniqueIds.length === 0) {
    return
  }

  const exploitations = await client.declarantPointPrelevement.findMany({
    where: {id: {in: uniqueIds}},
    select: {id: true, declarantUserId: true}
  })
  const exploitationsById = new Map(exploitations.map(exploitation => [exploitation.id, exploitation]))

  for (const exploitationId of uniqueIds) {
    const exploitation = exploitationsById.get(exploitationId)

    if (!exploitation) {
      throw createHttpError(400, `L’exploitation ${exploitationId} est introuvable.`)
    }

    if (exploitation.declarantUserId !== declarantUserId) {
      throw createHttpError(400, `L’exploitation ${exploitationId} n’est pas rattachée à ce déclarant.`)
    }
  }
}

export async function assertCanLinkDocumentExploitations(
  user,
  exploitationIds,
  {
    client = prisma,
    now = new Date(),
    permission = 'declarant.document.update'
  } = {}
) {
  const uniqueIds = [...new Set(exploitationIds.filter(Boolean))]
  if (uniqueIds.length === 0 || user?.role === 'ADMIN') {
    return
  }

  if (user?.role !== 'INSTRUCTOR') {
    throw createHttpError(403, 'Droits insuffisants.')
  }

  const permittedZoneIds = await getPermissionZoneIdsForUser(
    user,
    permission,
    {client, now}
  )
  if (permittedZoneIds.length === 0) {
    throw createHttpError(403, 'Droits insuffisants.')
  }

  const coveredExploitationCount = await client.declarantPointPrelevement.count({
    where: {
      id: {in: uniqueIds},
      pointPrelevement: {
        zones: {
          some: {zoneId: {in: permittedZoneIds}}
        }
      }
    }
  })

  if (coveredExploitationCount !== uniqueIds.length) {
    throw createHttpError(
      403,
      'Une ou plusieurs exploitations ne sont pas couvertes par vos zones autorisées pour la modification de documents.'
    )
  }
}

function getDocumentExploitationIds(document) {
  return [...new Set([
    document.declarantPointPrelevementId,
    ...(document.exploitations ?? []).map(link => link.declarantPointPrelevementId)
  ].filter(Boolean))]
}

export function getExploitationDocumentsFromRelations(exploitation) {
  const documentsById = new Map()

  for (const document of exploitation?.documents ?? []) {
    if (!document.deletedAt) {
      documentsById.set(document.id, document)
    }
  }

  for (const link of exploitation?.documentLinks ?? []) {
    const document = link.resourceDocument
    if (document && !document.deletedAt) {
      documentsById.set(document.id, document)
    }
  }

  return [...documentsById.values()].sort((left, right) =>
    new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
}

function safeFilename(filename) {
  return path.basename(filename || 'file')
    .normalize('NFC')
    .replaceAll(/[^\p{L}\p{N}._-]+/gu, '_')
    .slice(0, 180)
}

export async function uploadDocumentToS3({buffer, filename, type, declarantUserId, s3 = createStorageClient}) {
  const cleanedFilename = safeFilename(filename)
  const objectKey = `documents/${declarantUserId}/${crypto.randomUUID()}-${cleanedFilename}`

  await s3(DOCUMENTS_BUCKET).uploadObject(objectKey, buffer, {type})
  return {objectKey, filename: cleanedFilename}
}

export async function createDocument({
  payload,
  file,
  declarantUserId,
  declarantPointPrelevementId = null,
  user,
  client = prisma,
  now = new Date(),
  s3 = createStorageClient
}) {
  const validatedPayload = validateDocumentCreation(payload)
  const {
    declarantPointPrelevementId: payloadExploitationId,
    declarantPointPrelevementIds: payloadExploitationIds,
    ...document
  } = validatedPayload
  const linkedExploitationIds = Object.hasOwn(validatedPayload, 'declarantPointPrelevementIds')
    ? payloadExploitationIds
    : [declarantPointPrelevementId ?? payloadExploitationId].filter(Boolean)
  const {originalname, buffer, mimetype, size} = file || {}

  if (!buffer) {
    throw createHttpError(400, 'Aucun fichier envoyé')
  }

  await assertExploitationsBelongToDeclarant(linkedExploitationIds, declarantUserId, {client})
  await assertCanLinkDocumentExploitations(user, linkedExploitationIds, {
    client,
    now,
    permission: 'declarant.document.create'
  })

  const {objectKey, filename} = await uploadDocumentToS3({
    buffer,
    filename: originalname,
    type: mimetype,
    declarantUserId,
    s3
  })

  try {
    return await DocumentModel.insertDocument({
      id: randomUUID(),
      ...document,
      declarantUserId,
      declarantPointPrelevementId: linkedExploitationIds[0] ?? null,
      declarantPointPrelevementIds: linkedExploitationIds,
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

export async function updateDocument(
  documentId,
  payload,
  declarantUserId,
  {user, client = prisma, now = new Date()} = {}
) {
  const changes = validateDocumentChanges(payload)

  if (Object.keys(changes).length === 0) {
    throw createHttpError(400, 'Aucun champ valide trouvé.')
  }

  const updatesExploitationIds = Object.hasOwn(changes, 'declarantPointPrelevementIds')
    || Object.hasOwn(changes, 'declarantPointPrelevementId')

  if (updatesExploitationIds) {
    const linkedExploitationIds = Object.hasOwn(changes, 'declarantPointPrelevementIds')
      ? changes.declarantPointPrelevementIds
      : [changes.declarantPointPrelevementId].filter(Boolean)

    await assertExploitationsBelongToDeclarant(linkedExploitationIds, declarantUserId, {client})
    await assertCanLinkDocumentExploitations(user, linkedExploitationIds, {client, now})
    changes.declarantPointPrelevementIds = linkedExploitationIds
    changes.declarantPointPrelevementId = linkedExploitationIds[0] ?? null
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

  const documentUrl = await s3(DOCUMENTS_BUCKET).getPresignedUrl(document.storageKey, {
    filename: document.filename,
    type: document.mimeType
  })

  const documentFields = {...document}
  delete documentFields.exploitations
  const declarantPointPrelevementIds = getDocumentExploitationIds(document)
  const decorated = {
    ...documentFields,
    declarantPointPrelevementIds,
    downloadUrl: documentUrl
  }

  if (includeRelations) {
    const hasRegles = await RegleModel.documentHasRegles(document.id)

    decorated.hasRegles = hasRegles
    decorated.hasExploitations = declarantPointPrelevementIds.length > 0
  }

  return decorated
}
