import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {randomUUID} from 'node:crypto'
import {activeWindowWhere} from './point-prelevement.js'

function userWhere(includeDeleted) {
  return includeDeleted ? {} : {deletedAt: null}
}

export async function getDeclarant(declarantUserId, includeDeleted = false) {
  return prisma.user.findFirst({
    where: {
      id: declarantUserId,
      role: 'DECLARANT',
      ...userWhere(includeDeleted)
    },
    include: {declarant: true}
  })
}

export async function getDeclarantsByInstructor(instructorId, includeDeleted = false, now = new Date()) {
  const instructorZoneActiveWhere = {
    instructorUserId: instructorId,
    ...activeWindowWhere(now, {startNullable: false, endNullable: true})
  }

  return prisma.user.findMany({
    where: {
      role: 'DECLARANT',
      ...userWhere(includeDeleted),
      declarant: {
        pointPrelevements: {
          some: {
            pointPrelevement: {
              zones: {
                some: {
                  zone: {
                    instructorZones: {
                      some: instructorZoneActiveWhere
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    include: {
      declarant: {
        include: {
          _count: {
            select: {
              pointPrelevements: true
            }
          },
          user: true
        }
      }
    },
    orderBy: {createdAt: 'asc'}
  })
}

export async function getDeclarantById(declarantId) {
  return prisma.declarant.findUnique({
    where: {
      userId: declarantId
    },
    include: {
      user: true,
      pointPrelevements: {
        include: {
          pointPrelevement: {
            include: {
              zones: {
                include: {
                  zone: true
                }
              }
            }
          }
        },
        orderBy: [
          {createdAt: 'asc'}
        ]
      }
    }
  })
}

export async function getDeclarantsByIds(declarantUserIds, includeDeleted = false) {
  if (!Array.isArray(declarantUserIds) || declarantUserIds.length === 0) {
    return []
  }

  return prisma.user.findMany({
    where: {
      id: {in: declarantUserIds},
      role: 'DECLARANT',
      ...userWhere(includeDeleted)
    },
    include: {declarant: true}
  })
}

export async function getDeclarantByEmail(email, includeDeleted = false) {
  const candidate = email.toLowerCase().trim()

  return prisma.user.findFirst({
    where: {
      email: candidate,
      role: 'DECLARANT',
      ...userWhere(includeDeleted)
    },
    include: {declarant: true}
  })
}

export async function insertDeclarant(declarantPayload) {
  if (!declarantPayload || typeof declarantPayload !== 'object') {
    throw createHttpError(400, 'Le déclarant doit être un objet.')
  }

  const email = declarantPayload.email?.toLowerCase().trim()
  if (!email) {
    throw createHttpError(400, 'Email requis.')
  }

  try {
    return await prisma.user.create({
      data: {
        id: randomUUID(),
        email,
        role: 'DECLARANT',
        firstName: declarantPayload.firstName ?? null,
        lastName: declarantPayload.lastName ?? null,
        declarant: {create: {}}
      },
      include: {declarant: true}
    })
  } catch (error) {
    if (error?.code === 'P2002') {
      throw createHttpError(409, 'Un utilisateur avec cet email existe déjà.')
    }

    throw error
  }
}

export async function updateDeclarantById(declarantUserId, changes) {
  if (!changes || typeof changes !== 'object') {
    throw createHttpError(400, 'Les modifications doivent être un objet.')
  }

  const {role, id, createdAt, updatedAt, deletedAt, ...safeChanges} = changes

  if (typeof safeChanges.email === 'string') {
    safeChanges.email = safeChanges.email.toLowerCase().trim()
  }

  const user = await prisma.user.findFirst({
    where: {
      id: declarantUserId,
      role: 'DECLARANT',
      deletedAt: null
    },
    select: {id: true}
  })

  if (!user) {
    throw createHttpError(404, 'Ce déclarant est introuvable.')
  }

  try {
    return await prisma.user.update({
      where: {id: declarantUserId},
      data: safeChanges,
      include: {declarant: true}
    })
  } catch (error) {
    if (error?.code === 'P2002') {
      throw createHttpError(409, 'Email déjà utilisé.')
    }

    throw error
  }
}

export async function deleteDeclarantById(declarantUserId) {
  const user = await prisma.user.findFirst({
    where: {id: declarantUserId, role: 'DECLARANT', deletedAt: null},
    select: {id: true}
  })

  if (!user) {
    throw createHttpError(404, 'Ce déclarant est introuvable.')
  }

  return prisma.user.update({
    where: {id: declarantUserId},
    data: {deletedAt: new Date()}
  })
}
