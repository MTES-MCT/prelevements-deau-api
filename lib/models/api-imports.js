import {prisma} from '../../db/prisma.js'

export async function createApiImport({
  declarantUserId,
  rawPayload,
  status = 'PENDING'
}) {
  return prisma.apiImport.create({
    data: {
      declarantUserId,
      rawPayload,
      status
    }
  })
}

export async function getApiImportById(id) {
  return prisma.apiImport.findUnique({
    where: {id}
  })
}

export async function updateApiImport(id, data) {
  return prisma.apiImport.update({
    where: {id},
    data
  })
}

export async function listPendingApiImports() {
  return prisma.apiImport.findMany({
    where: {
      status: 'PENDING'
    },
    orderBy: {
      createdAt: 'asc'
    }
  })
}
