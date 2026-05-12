import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'

export async function insertDocument(document) {
  return prisma.resourceDocument.create({data: document})
}

export async function getDocument(documentId) {
  return prisma.resourceDocument.findFirst({
    where: {id: documentId, deletedAt: null}
  })
}

export async function updateDocumentById(documentId, changes) {
  if (!changes || typeof changes !== 'object') {
    throw createHttpError(400, 'Les modifications doivent être un objet.')
  }

  const existing = await prisma.resourceDocument.findFirst({
    where: {id: documentId, deletedAt: null},
    select: {id: true}
  })

  if (!existing) {
    throw createHttpError(404, 'Ce document est introuvable.')
  }

  return prisma.resourceDocument.update({
    where: {id: documentId},
    data: changes
  })
}

export async function deleteDocument(documentId) {
  const existing = await prisma.resourceDocument.findFirst({
    where: {id: documentId, deletedAt: null},
    select: {id: true}
  })

  if (!existing) {
    throw createHttpError(404, 'Document introuvable')
  }

  return prisma.resourceDocument.update({
    where: {id: documentId},
    data: {deletedAt: new Date()}
  })
}

export async function getPreleveurDocuments(declarantUserId) {
  return prisma.resourceDocument.findMany({
    where: {
      declarantUserId,
      deletedAt: null
    },
    orderBy: {createdAt: 'desc'}
  })
}

export async function getExploitationDocuments(exploitationId) {
  return prisma.resourceDocument.findMany({
    where: {
      declarantPointPrelevementId: exploitationId,
      deletedAt: null
    },
    orderBy: {createdAt: 'desc'}
  })
}
