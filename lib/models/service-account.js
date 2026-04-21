import {prisma} from '../../db/prisma.js'

export async function getServiceAccountById(id) {
  return prisma.serviceAccount.findUnique({
    where: {id}
  })
}

export async function getActiveServiceAccountById(id) {
  return prisma.serviceAccount.findFirst({
    where: {
      id,
      isActive: true,
      deletedAt: null
    }
  })
}
