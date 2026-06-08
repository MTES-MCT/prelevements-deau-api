import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {randomUUID} from 'node:crypto'
import {activeWindowWhere} from './point-prelevement.js'

function userWhere(includeDeleted) {
  return includeDeleted ? {} : {deletedAt: null}
}

function removeUndefinedValues(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  )
}

function normalizeCivility(value) {
  if (value === undefined) {
    return undefined
  }

  if (value === null || value === '') {
    return null
  }

  return {
    'M.': 'MR',
    Mme: 'MRS',
    MR: 'MR',
    MRS: 'MRS'
  }[value] ?? value
}

function normalizeEmail(email) {
  if (email === undefined) {
    return undefined
  }

  if (email === null || email === '') {
    return null
  }

  return typeof email === 'string' ? email.toLowerCase().trim() : email
}

function splitDeclarantPayload(payload) {
  return {
    userData: removeUndefinedValues({
      email: normalizeEmail(payload.email),
      firstName: payload.firstName,
      lastName: payload.lastName
    }),
    declarantData: removeUndefinedValues({
      declarantType: payload.declarantType,
      declarantRole: payload.declarantRole,
      jobTitle: payload.jobTitle,
      socialReason: payload.socialReason,
      civility: normalizeCivility(payload.civility),
      addressLine1: payload.addressLine1,
      addressLine2: payload.addressLine2,
      poBox: payload.poBox,
      postalCode: payload.postalCode,
      city: payload.city,
      siret: payload.siret,
      phoneNumber: payload.phoneNumber,
      sourceId: payload.sourceId
    })
  }
}

function stripReadonlyDeclarantFields(changes) {
  const data = {...changes}

  for (const key of [
    'id',
    'userId',
    'role',
    'createdAt',
    'updatedAt',
    'deletedAt',
    'lastLoginAt',
    'lastDeclarationAt',
    'lastReminderMailSentAt',
    'user',
    'declarant',
    'pointPrelevements',
    'collecteurExploitations',
    'declarations',
    'declarationsCreated',
    'declarationTypes',
    'serviceAccountDeclarants',
    'serviceAccountTokens',
    'apiImports',
    'right',
    '_count'
  ]) {
    delete data[key]
  }

  return data
}

function normalizeDeclarant(declarant) {
  if (!declarant) {
    return null
  }

  return {
    ...declarant,
    id: declarant.userId,
    email: declarant.user?.email ?? null,
    firstName: declarant.user?.firstName ?? null,
    lastName: declarant.user?.lastName ?? null
  }
}

function getExploitationInclude() {
  return {
    connectors: {
      orderBy: {createdAt: 'asc'}
    },
    collecteurs: {
      include: {
        collecteur: {
          include: {
            user: true
          }
        }
      },
      orderBy: {createdAt: 'asc'}
    },
    documents: {
      where: {deletedAt: null},
      orderBy: {createdAt: 'desc'}
    },
    pointPrelevement: {
      include: {
        zones: {
          include: {
            zone: true
          }
        }
      }
    },
    declarant: {
      include: {
        user: true
      }
    }
  }
}

function getDeclarantListInclude() {
  return {
    declarant: {
      include: {
        _count: {
          select: {
            pointPrelevements: true,
            collecteurExploitations: true
          }
        },
        user: true
      }
    }
  }
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

export async function getDeclarants(includeDeleted = false) {
  return prisma.user.findMany({
    where: {
      role: 'DECLARANT',
      ...userWhere(includeDeleted)
    },
    include: getDeclarantListInclude(),
    orderBy: {createdAt: 'asc'}
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
        OR: [
          {
            AND: [
              {pointPrelevements: {none: {}}},
              {collecteurExploitations: {none: {}}}
            ]
          },
          {
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
          },
          {
            collecteurExploitations: {
              some: {
                exploitation: {
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
          }
        ]
      }
    },
    include: getDeclarantListInclude(),
    orderBy: {createdAt: 'asc'}
  })
}

export async function getDeclarantDetail(req, res) {
  const declarant = await getDeclarantById(req.declarant.id)

  res.send(declarant)
}

export async function getDeclarantById(declarantId) {
  const declarant = await prisma.declarant.findUnique({
    where: {
      userId: declarantId
    },
    include: {
      user: true,
      pointPrelevements: {
        include: getExploitationInclude(),
        orderBy: [
          {createdAt: 'asc'}
        ]
      },
      collecteurExploitations: {
        include: {
          exploitation: {
            include: getExploitationInclude()
          }
        },
        orderBy: [
          {createdAt: 'asc'}
        ]
      }
    }
  })

  if (!declarant) {
    return null
  }

  const pointPrelevementIds = declarant.pointPrelevements
    .map(exploitation => exploitation.pointPrelevementId)
    .filter(Boolean)

  if (pointPrelevementIds.length === 0) {
    return normalizeDeclarant(declarant)
  }

  const chunks = await prisma.chunk.findMany({
    where: {
      pointPrelevementId: {
        in: pointPrelevementIds
      },
      source: {
        declaration: {
          declarantUserId: declarantId
        }
      }
    },
    select: {
      pointPrelevementId: true,
      minDate: true,
      maxDate: true,
      source: {
        select: {
          declaration: {
            select: {
              createdAt: true
            }
          }
        }
      }
    },
    orderBy: [
      {pointPrelevementId: 'asc'}
    ]
  })

  const statsByPointId = new Map()

  for (const chunk of chunks) {
    const {pointPrelevementId} = chunk

    if (!pointPrelevementId) {
      continue
    }

    const declarationCreatedAt = chunk.source.declaration.createdAt

    const current = statsByPointId.get(pointPrelevementId)

    if (!current) {
      statsByPointId.set(pointPrelevementId, {
        lastDeclarationAt: declarationCreatedAt,
        minDeclaredDate: chunk.minDate,
        maxDeclaredDate: chunk.maxDate
      })

      continue
    }

    if (declarationCreatedAt && (!current.lastDeclarationAt || declarationCreatedAt > current.lastDeclarationAt)) {
      current.lastDeclarationAt = declarationCreatedAt
    }

    if (chunk.minDate && (!current.minDeclaredDate || chunk.minDate < current.minDeclaredDate)) {
      current.minDeclaredDate = chunk.minDate
    }

    if (chunk.maxDate && (!current.maxDeclaredDate || chunk.maxDate > current.maxDeclaredDate)) {
      current.maxDeclaredDate = chunk.maxDate
    }
  }

  return normalizeDeclarant({
    ...declarant,
    pointPrelevements: declarant.pointPrelevements.map(exploitation => {
      const stats = statsByPointId.get(exploitation.pointPrelevementId)

      return {
        ...exploitation,
        lastDeclarationAt: stats?.lastDeclarationAt ?? null,
        minDeclaredDate: stats?.minDeclaredDate ?? null,
        maxDeclaredDate: stats?.maxDeclaredDate ?? null
      }
    })
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
  const candidate = normalizeEmail(email)

  if (!candidate) {
    return null
  }

  return prisma.user.findFirst({
    where: {
      email: candidate,
      role: 'DECLARANT',
      ...userWhere(includeDeleted)
    },
    include: {declarant: true}
  })
}

function assertEmailForCollecteur({userData, declarantData, existing}) {
  const nextRole = declarantData.declarantRole ?? existing?.declarant?.declarantRole ?? 'PRELEVEUR'
  const nextEmail = Object.hasOwn(userData, 'email')
    ? userData.email
    : existing?.email

  if (nextRole === 'COLLECTEUR' && !nextEmail) {
    throw createHttpError(400, 'Un collecteur doit avoir une adresse email pour pouvoir se connecter.')
  }
}

export async function insertDeclarant(declarantPayload) {
  if (!declarantPayload || typeof declarantPayload !== 'object') {
    throw createHttpError(400, 'Le déclarant doit être un objet.')
  }

  const {userData, declarantData} = splitDeclarantPayload(declarantPayload)
  declarantData.declarantRole ??= 'PRELEVEUR'

  assertEmailForCollecteur({userData, declarantData})

  try {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: userData.email ?? null,
        firstName: userData.firstName ?? null,
        lastName: userData.lastName ?? null,
        role: 'DECLARANT',
        declarant: {
          create: declarantData
        }
      },
      include: {declarant: true}
    })

    return getDeclarantById(user.id)
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

  const safeChanges = stripReadonlyDeclarantFields(changes)
  const {userData, declarantData} = splitDeclarantPayload(safeChanges)

  if (Object.keys(userData).length === 0 && Object.keys(declarantData).length === 0) {
    throw createHttpError(400, 'Aucun champ valide trouvé.')
  }

  const existingUser = await prisma.user.findFirst({
    where: {
      id: declarantUserId,
      role: 'DECLARANT',
      deletedAt: null
    },
    include: {declarant: true}
  })

  if (!existingUser) {
    throw createHttpError(404, 'Ce déclarant est introuvable.')
  }

  assertEmailForCollecteur({userData, declarantData, existing: existingUser})

  if (declarantData.declarantRole === 'COLLECTEUR' && existingUser.declarant?.declarantRole !== 'COLLECTEUR') {
    const exploitationCount = await prisma.declarantPointPrelevement.count({
      where: {declarantUserId}
    })

    if (exploitationCount > 0) {
      throw createHttpError(400, 'Impossible de transformer ce déclarant en collecteur : il est déjà rattaché à une ou plusieurs exploitations comme préleveur.')
    }
  }

  try {
    await prisma.user.update({
      where: {id: declarantUserId},
      data: {
        ...userData,
        ...(Object.keys(declarantData).length > 0
          ? {declarant: {update: declarantData}}
          : {})
      }
    })

    return getDeclarantById(declarantUserId)
  } catch (error) {
    if (error?.code === 'P2002') {
      throw createHttpError(409, 'Email déjà utilisé.')
    }

    throw error
  }
}

export async function getCollecteurPreleveurs(collecteurUserId) {
  const links = await prisma.declarantCollecteurExploitation.findMany({
    where: {
      collecteurUserId,
      exploitation: {
        declarant: {
          declarantRole: 'PRELEVEUR'
        }
      }
    },
    include: {
      exploitation: {
        include: {
          declarant: {
            include: {
              user: true
            }
          },
          pointPrelevement: true
        }
      }
    },
    orderBy: {createdAt: 'asc'}
  })

  const byPreleveurId = new Map()

  for (const link of links) {
    const preleveur = link.exploitation?.declarant
    const user = preleveur?.user

    if (!preleveur || !user) {
      continue
    }

    const id = preleveur.userId
    const current = byPreleveurId.get(id) ?? {
      ...user,
      id,
      declarant: {
        ...preleveur,
        user,
        _count: {
          pointPrelevements: 0,
          collecteurExploitations: 0
        },
        collecteurExploitations: []
      }
    }

    current.declarant._count.pointPrelevements += 1
    current.declarant.collecteurExploitations.push({
      id: link.id,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
      exploitation: link.exploitation
    })

    byPreleveurId.set(id, current)
  }

  return [...byPreleveurId.values()].sort((a, b) => {
    const labelA = (a.declarant.socialReason || `${a.firstName ?? ''} ${a.lastName ?? ''}`).trim().toLowerCase()
    const labelB = (b.declarant.socialReason || `${b.firstName ?? ''} ${b.lastName ?? ''}`).trim().toLowerCase()
    return labelA.localeCompare(labelB, 'fr')
  })
}

export async function updateLastDeclarationAt(declarantUserId) {
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

  return prisma.declarant.update({
    where: {
      userId: declarantUserId
    },
    data: {
      lastDeclarationAt: new Date()
    },
    include: {
      user: true
    }
  })
}

export async function updateLastReminderSentAt(declarantUserId) {
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

  return prisma.declarant.update({
    where: {
      userId: declarantUserId
    },
    data: {
      lastReminderMailSentAt: new Date()
    },
    include: {
      user: true
    }
  })
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
