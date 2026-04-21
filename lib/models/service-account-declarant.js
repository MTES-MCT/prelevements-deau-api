import {prisma} from '../../db/prisma.js'

export function getServiceAccountDeclarantActiveWhere(now = new Date()) {
  return {
    startDate: {lte: now},
    OR: [
      {endDate: null},
      {endDate: {gte: now}}
    ]
  }
}

export async function listActiveDeclarantsForServiceAccount(serviceAccountId, now = new Date()) {
  return prisma.serviceAccountDeclarant.findMany({
    where: {
      serviceAccountId,
      ...getServiceAccountDeclarantActiveWhere(now)
    },
    include: {
      declarant: {
        include: {
          user: true
        }
      }
    },
    orderBy: [
      {startDate: 'asc'},
      {declarantUserId: 'asc'}
    ]
  })
}

export async function canServiceAccountImpersonateDeclarant(serviceAccountId, declarantUserId, now = new Date()) {
  const link = await prisma.serviceAccountDeclarant.findFirst({
    where: {
      serviceAccountId,
      declarantUserId,
      ...getServiceAccountDeclarantActiveWhere(now)
    },
    select: {
      id: true
    }
  })

  return Boolean(link)
}
