import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'

function defaultInclude() {
  return {
    exploitations: {
      include: {
        declarantPointPrelevement: true
      },
      orderBy: {createdAt: 'asc'}
    }
  }
}

function splitExploitationIds(payload) {
  const data = {...payload}
  const declarantPointPrelevementIds = Object.hasOwn(data, 'declarantPointPrelevementIds')
    ? [...new Set(data.declarantPointPrelevementIds ?? [])]
    : undefined

  delete data.declarantPointPrelevementIds

  return {data, declarantPointPrelevementIds}
}

export async function insertDocument(document) {
  const {data, declarantPointPrelevementIds = []} = splitExploitationIds(document)

  return prisma.resourceDocument.create({
    data: {
      ...data,
      exploitations: {
        create: declarantPointPrelevementIds.map(declarantPointPrelevementId => ({
          declarantPointPrelevementId
        }))
      }
    },
    include: defaultInclude()
  })
}

export async function getDocument(documentId) {
  return prisma.resourceDocument.findFirst({
    where: {id: documentId, deletedAt: null},
    include: defaultInclude()
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

  const {data, declarantPointPrelevementIds} = splitExploitationIds(changes)

  return prisma.resourceDocument.update({
    where: {id: documentId},
    data: {
      ...data,
      ...(declarantPointPrelevementIds
        ? {
          exploitations: {
            deleteMany: {},
            create: declarantPointPrelevementIds.map(declarantPointPrelevementId => ({
              declarantPointPrelevementId
            }))
          }
        }
        : {})
    },
    include: defaultInclude()
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
    include: defaultInclude(),
    orderBy: {createdAt: 'desc'}
  })
}

export async function getExploitationDocuments(exploitationId) {
  return prisma.resourceDocument.findMany({
    where: {
      OR: [
        {declarantPointPrelevementId: exploitationId},
        {
          exploitations: {
            some: {declarantPointPrelevementId: exploitationId}
          }
        }
      ],
      deletedAt: null
    },
    include: defaultInclude(),
    orderBy: {createdAt: 'desc'}
  })
}
