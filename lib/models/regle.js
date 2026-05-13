import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'

function defaultInclude() {
  return {
    document: true,
    exploitations: {
      include: {
        declarantPointPrelevement: {
          include: {
            pointPrelevement: true,
            declarant: {
              include: {
                user: true
              }
            }
          }
        }
      },
      orderBy: {
        createdAt: 'asc'
      }
    }
  }
}

function splitRulePayload(payload) {
  const data = {...payload}
  const exploitationIds = Object.hasOwn(data, 'exploitationIds')
    ? data.exploitationIds
    : undefined

  delete data.exploitationIds

  return {data, exploitationIds}
}

export async function getRegle(regleId) {
  return prisma.resourceRule.findFirst({
    where: {
      id: regleId,
      deletedAt: null
    },
    include: defaultInclude()
  })
}

export async function getPreleveurRegles(declarantUserId) {
  return prisma.resourceRule.findMany({
    where: {
      declarantUserId,
      deletedAt: null
    },
    include: defaultInclude(),
    orderBy: {
      createdAt: 'desc'
    }
  })
}

export async function getExploitationRegles(exploitationId) {
  return prisma.resourceRule.findMany({
    where: {
      deletedAt: null,
      exploitations: {
        some: {
          declarantPointPrelevementId: exploitationId
        }
      }
    },
    include: defaultInclude(),
    orderBy: {
      createdAt: 'desc'
    }
  })
}

export async function preleveurHasRegles(declarantUserId) {
  const count = await prisma.resourceRule.count({
    where: {
      declarantUserId,
      deletedAt: null
    }
  })

  return count > 0
}

export async function documentHasRegles(documentId) {
  const count = await prisma.resourceRule.count({
    where: {
      documentId,
      deletedAt: null
    }
  })

  return count > 0
}

export async function insertRegle(regle) {
  const {data, exploitationIds = []} = splitRulePayload(regle)

  return prisma.resourceRule.create({
    data: {
      ...data,
      exploitations: {
        create: exploitationIds.map(exploitationId => ({
          declarantPointPrelevementId: exploitationId
        }))
      }
    },
    include: defaultInclude()
  })
}

export async function updateRegleById(regleId, changes) {
  if (!changes || typeof changes !== 'object') {
    throw createHttpError(400, 'Les modifications doivent être un objet.')
  }

  const existing = await prisma.resourceRule.findFirst({
    where: {
      id: regleId,
      deletedAt: null
    },
    select: {
      id: true
    }
  })

  if (!existing) {
    throw createHttpError(404, 'Cette règle est introuvable.')
  }

  const {data, exploitationIds} = splitRulePayload(changes)

  return prisma.resourceRule.update({
    where: {
      id: regleId
    },
    data: {
      ...data,
      ...(exploitationIds
        ? {
          exploitations: {
            deleteMany: {},
            create: exploitationIds.map(exploitationId => ({
              declarantPointPrelevementId: exploitationId
            }))
          }
        }
        : {})
    },
    include: defaultInclude()
  })
}

export async function deleteRegle(regleId) {
  const existing = await prisma.resourceRule.findFirst({
    where: {
      id: regleId,
      deletedAt: null
    },
    select: {
      id: true
    }
  })

  if (!existing) {
    throw createHttpError(404, 'Cette règle est introuvable.')
  }

  return prisma.resourceRule.update({
    where: {
      id: regleId
    },
    data: {
      deletedAt: new Date()
    },
    include: defaultInclude()
  })
}
