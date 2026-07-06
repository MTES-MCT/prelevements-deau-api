import {randomUUID} from 'node:crypto'

import createHttpError from 'http-errors'
import Joi from 'joi'

import {prisma} from '../../db/prisma.js'
import {activeWindowWhere} from '../models/point-prelevement.js'
import {
  sendAccountCreationNotification,
  sendZoneAttachmentNotification
} from '../services/account-notifications.js'
import {
  getInstructorDisplayName,
  serializeInstructorCandidate,
  serializeInstructorRight
} from '../services/instructor-zones.js'
import {normalizeEmail} from '../util/email.js'

const zoneIdSchema = Joi.string().guid({version: 'uuidv4'}).required()
const instructorUserIdSchema = Joi.string().guid({version: 'uuidv4'}).required()

const addInstructorSchema = Joi.object({
  instructorUserId: Joi.string().guid({version: 'uuidv4'}),
  email: Joi.string().allow('', null),
  firstName: Joi.string().allow('', null),
  lastName: Joi.string().allow('', null),
  phoneNumber: Joi.string().allow('', null),
  jobTitle: Joi.string().allow('', null),
  isAdmin: Joi.boolean().default(false),
  startDate: Joi.date().iso().required(),
  endDate: Joi.date().iso().allow(null),
  notifyAccountCreation: Joi.boolean().default(false),
  notifyZoneAttachment: Joi.boolean().default(false)
}).custom((value, helpers) => {
  if (!value.instructorUserId && !value.email) {
    return helpers.error('any.required')
  }

  if (value.endDate && value.startDate > value.endDate) {
    return helpers.error('any.invalid')
  }

  return value
}, 'cohérence des dates')

const instructorOptionsQuerySchema = Joi.object({
  search: Joi.string().allow('', null).default(''),
  limit: Joi.number().integer().min(1).max(50).default(25)
})

function validateZoneId(zoneId) {
  const {error, value} = zoneIdSchema.validate(zoneId)

  if (error) {
    throw createHttpError(400, 'Identifiant de zone invalide.')
  }

  return value
}

function validateInstructorUserId(instructorUserId) {
  const {error, value} = instructorUserIdSchema.validate(instructorUserId)

  if (error) {
    throw createHttpError(400, 'Identifiant d’instructeur invalide.')
  }

  return value
}

function optionalText(value) {
  if (value === undefined || value === null) {
    return undefined
  }

  const trimmed = String(value).trim()
  return trimmed || undefined
}

function removeUndefinedValues(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  )
}

function notEndedWindowWhere(now = new Date()) {
  return {
    OR: [
      {endDate: null},
      {endDate: {gte: now}}
    ]
  }
}

function getDisplayName(person) {
  return getInstructorDisplayName(person) || person.socialReason || person.email || ''
}

function sortPeople(items) {
  return items.sort((a, b) => getDisplayName(a).localeCompare(getDisplayName(b), 'fr'))
}

function isGlobalAdmin(user) {
  return user?.role === 'ADMIN'
}

function createAdminZoneRight(zone) {
  return {
    zone,
    isAdmin: true,
    startDate: null,
    endDate: null
  }
}

function asDate(value) {
  if (!value) {
    return null
  }

  return value instanceof Date ? value : new Date(value)
}

async function getZoneById(zoneId) {
  return prisma.zone.findUnique({
    where: {id: zoneId},
    select: {
      id: true,
      type: true,
      code: true,
      name: true
    }
  })
}

async function getAllZoneRightsForAdmin() {
  const zones = await prisma.zone.findMany({
    select: {
      id: true,
      type: true,
      code: true,
      name: true
    },
    orderBy: {
      name: 'asc'
    }
  })

  return zones.map(zone => createAdminZoneRight(zone))
}

async function getZoneRightOrThrow(user, zoneId, {requireAdmin = false} = {}) {
  if (isGlobalAdmin(user)) {
    const zone = await getZoneById(zoneId)

    if (!zone) {
      throw createHttpError(404, 'Cette zone est introuvable.')
    }

    return createAdminZoneRight(zone)
  }

  const instructorUserId = typeof user === 'string' ? user : user?.id

  const right = await prisma.instructorZone.findFirst({
    where: {
      instructorUserId,
      zoneId,
      ...activeWindowWhere(new Date(), {
        startNullable: false,
        endNullable: true
      })
    },
    include: {
      zone: {
        select: {
          id: true,
          type: true,
          code: true,
          name: true
        }
      }
    }
  })

  if (!right) {
    throw createHttpError(403, 'Vous n’avez pas accès à cette zone.')
  }

  if (requireAdmin && !right.isAdmin) {
    throw createHttpError(
      403,
      'Droits insuffisants. Vous devez être admin de cette zone.'
    )
  }

  return right
}

async function countZoneDeclarants(zoneId) {
  const rows = await prisma.declarantPointPrelevement.findMany({
    where: {
      pointPrelevement: {
        deletedAt: null,
        zones: {
          some: {
            zoneId
          }
        }
      },
      declarant: {
        user: {
          deletedAt: null
        }
      }
    },
    distinct: ['declarantUserId'],
    select: {
      declarantUserId: true
    }
  })

  return rows.length
}

async function countZonePoints(zoneId) {
  return prisma.pointPrelevement.count({
    where: {
      deletedAt: null,
      zones: {
        some: {
          zoneId
        }
      }
    }
  })
}

async function countVisibleZoneInstructors(zoneId) {
  return prisma.instructorZone.count({
    where: {
      zoneId,
      ...notEndedWindowWhere(),
      instructor: {
        user: {
          deletedAt: null
        }
      }
    }
  })
}

async function countOtherActiveZoneAdmins(zoneId, excludedInstructorUserId) {
  return prisma.instructorZone.count({
    where: {
      zoneId,
      isAdmin: true,
      instructorUserId: {
        not: excludedInstructorUserId
      },
      ...activeWindowWhere(new Date(), {
        startNullable: false,
        endNullable: true
      }),
      instructor: {
        user: {
          deletedAt: null
        }
      }
    }
  })
}

async function decorateZoneRight(right) {
  const [pointsCount, declarantsCount, instructorsCount] = await Promise.all([
    countZonePoints(right.zone.id),
    countZoneDeclarants(right.zone.id),
    countVisibleZoneInstructors(right.zone.id)
  ])

  return {
    id: right.zone.id,
    type: right.zone.type,
    code: right.zone.code,
    name: right.zone.name,
    isAdmin: right.isAdmin,
    startDate: right.startDate,
    endDate: right.endDate,
    pointsCount,
    declarantsCount,
    instructorsCount,
    right: {
      canRead: true,
      canEdit: right.isAdmin
    }
  }
}

async function getVisibleZoneInstructor(zoneId, instructorUserId, {
  includeEnded = false,
  currentUserId = null,
  includeHabilitations = false
} = {}) {
  const right = await prisma.instructorZone.findFirst({
    where: {
      zoneId,
      instructorUserId,
      ...(includeEnded ? {} : notEndedWindowWhere())
    },
    include: {
      instructor: {
        include: {
          ...(includeHabilitations
            ? {
              instructorZones: {
                include: {
                  zone: {
                    select: {
                      id: true,
                      type: true,
                      code: true,
                      name: true
                    }
                  }
                },
                orderBy: [
                  {startDate: 'desc'},
                  {createdAt: 'desc'}
                ]
              }
            }
            : {}),
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              accountCreationMailSentAt: true,
              deletedAt: true
            }
          }
        }
      }
    }
  })

  return right
    ? serializeInstructorRight(right, {
      currentUserId,
      includeHabilitations,
      currentZoneId: zoneId
    })
    : null
}

async function getZoneInstructors(zoneId, currentUserId) {
  const rights = await prisma.instructorZone.findMany({
    where: {
      zoneId,
      ...notEndedWindowWhere(),
      instructor: {
        user: {
          deletedAt: null
        }
      }
    },
    include: {
      instructor: {
        include: {
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              accountCreationMailSentAt: true,
              deletedAt: true
            }
          }
        }
      }
    },
    orderBy: [
      {isAdmin: 'desc'},
      {createdAt: 'asc'}
    ]
  })

  return sortPeople(rights.map(right => serializeInstructorRight(right, {currentUserId})).filter(Boolean))
}

function buildInstructorOptionsWhere(search) {
  const trimmedSearch = String(search || '').trim()

  if (!trimmedSearch) {
    return {}
  }

  const containsSearch = {
    contains: trimmedSearch,
    mode: 'insensitive'
  }

  return {
    OR: [
      {email: containsSearch},
      {firstName: containsSearch},
      {lastName: containsSearch},
      {
        instructor: {
          is: {
            phoneNumber: containsSearch
          }
        }
      },
      {
        instructor: {
          is: {
            jobTitle: containsSearch
          }
        }
      }
    ]
  }
}

async function getZoneInstructorOptions(zoneId, {
  search = '',
  limit = 25,
  currentUserId = null
} = {}) {
  const users = await prisma.user.findMany({
    where: {
      role: 'INSTRUCTOR',
      deletedAt: null,
      instructor: {
        isNot: null
      },
      ...buildInstructorOptionsWhere(search)
    },
    include: {
      instructor: {
        include: {
          instructorZones: {
            include: {
              zone: {
                select: {
                  id: true,
                  type: true,
                  code: true,
                  name: true
                }
              }
            },
            orderBy: [
              {startDate: 'desc'},
              {createdAt: 'desc'}
            ]
          }
        }
      }
    },
    orderBy: [
      {lastName: 'asc'},
      {firstName: 'asc'},
      {email: 'asc'}
    ],
    take: limit
  })

  return sortPeople(users
    .map(user => serializeInstructorCandidate(user, {
      currentZoneId: zoneId,
      currentUserId
    }))
    .filter(Boolean))
}

async function getZoneDeclarants(zoneId) {
  const links = await prisma.declarantPointPrelevement.findMany({
    where: {
      pointPrelevement: {
        deletedAt: null,
        zones: {
          some: {
            zoneId
          }
        }
      },
      declarant: {
        user: {
          deletedAt: null
        }
      }
    },
    include: {
      declarant: {
        include: {
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true
            }
          }
        }
      },
      pointPrelevement: {
        select: {
          id: true,
          name: true
        }
      }
    },
    orderBy: {
      createdAt: 'asc'
    }
  })

  const declarantsById = new Map()

  for (const link of links) {
    const {declarant} = link
    const {user} = declarant

    if (!declarantsById.has(user.id)) {
      declarantsById.set(user.id, {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        declarantType: declarant.declarantType,
        civility: declarant.civility,
        socialReason: declarant.socialReason,
        siret: declarant.siret,
        phoneNumber: declarant.phoneNumber,
        city: declarant.city,
        declarant: {
          socialReason: declarant.socialReason,
          _count: {
            pointPrelevements: 0
          }
        },
        points: []
      })
    }

    const item = declarantsById.get(user.id)

    item.points.push({
      id: link.pointPrelevement.id,
      name: link.pointPrelevement.name,
      exploitationId: link.id,
      type: link.type,
      status: link.status,
      startDate: link.startDate,
      endDate: link.endDate
    })

    item.declarant._count.pointPrelevements = item.points.length
  }

  return sortPeople([...declarantsById.values()].map(declarant => ({
    ...declarant,
    points: declarant.points.sort((a, b) => a.name.localeCompare(b.name, 'fr'))
  })))
}

export async function listZones(req, res) {
  const rights = isGlobalAdmin(req.user)
    ? await getAllZoneRightsForAdmin()
    : await prisma.instructorZone.findMany({
      where: {
        instructorUserId: req.user.id,
        ...activeWindowWhere(new Date(), {
          startNullable: false,
          endNullable: true
        })
      },
      include: {
        zone: {
          select: {
            id: true,
            type: true,
            code: true,
            name: true
          }
        }
      },
      orderBy: {
        createdAt: 'asc'
      }
    })

  const zones = await Promise.all(rights.map(right => decorateZoneRight(right)))

  res.json(zones.sort((a, b) => a.name.localeCompare(b.name, 'fr')))
}

export async function getZoneHandler(req, res) {
  const zoneId = validateZoneId(req.params.zoneId)
  const right = await getZoneRightOrThrow(req.user, zoneId)

  res.json(await decorateZoneRight(right))
}

export async function listZoneDeclarantsHandler(req, res) {
  const zoneId = validateZoneId(req.params.zoneId)

  await getZoneRightOrThrow(req.user, zoneId)

  res.json(await getZoneDeclarants(zoneId))
}

export async function listZoneInstructorsHandler(req, res) {
  const zoneId = validateZoneId(req.params.zoneId)

  await getZoneRightOrThrow(req.user, zoneId)

  res.json(await getZoneInstructors(zoneId, req.user.id))
}

export async function listZoneInstructorOptionsHandler(req, res) {
  const zoneId = validateZoneId(req.params.zoneId)

  const {error, value} = instructorOptionsQuerySchema.validate(req.query, {
    stripUnknown: true
  })

  if (error) {
    throw createHttpError(400, 'Recherche d’agent invalide.')
  }

  await getZoneRightOrThrow(req.user, zoneId, {
    requireAdmin: true
  })

  res.json(await getZoneInstructorOptions(zoneId, {
    search: value.search,
    limit: value.limit,
    currentUserId: req.user.id
  }))
}

export async function getZoneInstructorHandler(req, res) {
  const zoneId = validateZoneId(req.params.zoneId)
  const instructorUserId = validateInstructorUserId(req.params.instructorUserId)

  await getZoneRightOrThrow(req.user, zoneId)

  const instructor = await getVisibleZoneInstructor(zoneId, instructorUserId, {
    currentUserId: req.user.id,
    includeHabilitations: true
  })

  if (!instructor) {
    throw createHttpError(404, 'Cet instructeur n’est pas rattaché à cette zone.')
  }

  res.json(instructor)
}

export async function addZoneInstructorHandler(req, res) {
  const zoneId = validateZoneId(req.params.zoneId)

  const {error, value} = addInstructorSchema.validate(req.body, {
    stripUnknown: true
  })

  if (error) {
    throw createHttpError(
      400,
      'Instructeur invalide : email, date de début et cohérence des dates requis.'
    )
  }

  await getZoneRightOrThrow(req.user, zoneId, {
    requireAdmin: true
  })

  const userData = removeUndefinedValues({
    firstName: optionalText(value.firstName),
    lastName: optionalText(value.lastName)
  })

  const instructorData = removeUndefinedValues({
    phoneNumber: optionalText(value.phoneNumber),
    jobTitle: optionalText(value.jobTitle)
  })

  let instructorUser

  await prisma.$transaction(async tx => {
    let user

    if (value.instructorUserId) {
      user = await tx.user.findUnique({
        where: {
          id: value.instructorUserId
        },
        include: {
          instructor: true
        }
      })

      if (!user || user.deletedAt || user.role !== 'INSTRUCTOR' || !user.instructor) {
        throw createHttpError(404, 'Cet agent est introuvable.')
      }
    } else {
      const email = normalizeEmail(value.email)

      user = await tx.user.findUnique({
        where: {
          email
        },
        include: {
          instructor: true
        }
      })

      if (user?.deletedAt) {
        throw createHttpError(
          409,
          'Un utilisateur supprimé existe déjà avec cet email. Réactivation manuelle nécessaire.'
        )
      }

      if (user && user.role !== 'INSTRUCTOR') {
        throw createHttpError(
          409,
          'Cet email est déjà utilisé par un utilisateur qui n’est pas instructeur.'
        )
      }

      if (user && !user.instructor) {
        await tx.instructor.create({
          data: {
            userId: user.id
          }
        })
      }

      user ||= await tx.user.create({
        data: {
          id: randomUUID(),
          email,
          role: 'INSTRUCTOR',
          ...userData,
          instructor: {
            create: instructorData
          }
        },
        include: {
          instructor: true
        }
      })
    }

    instructorUser = user

    await tx.instructorZone.upsert({
      where: {
        instructorUserId_zoneId: {
          instructorUserId: user.id,
          zoneId
        }
      },
      update: {
        isAdmin: value.isAdmin,
        startDate: asDate(value.startDate),
        endDate: asDate(value.endDate)
      },
      create: {
        instructorUserId: user.id,
        zoneId,
        isAdmin: value.isAdmin,
        startDate: asDate(value.startDate),
        endDate: asDate(value.endDate)
      }
    })
  })

  const zone = await getZoneById(zoneId)

  if (value.notifyAccountCreation) {
    await sendAccountCreationNotification(instructorUser, {role: 'INSTRUCTOR'})
  }

  if (value.notifyZoneAttachment) {
    await sendZoneAttachmentNotification({
      instructor: instructorUser,
      zone
    })
  }

  const instructor = await getVisibleZoneInstructor(zoneId, instructorUser.id, {
    includeEnded: true,
    currentUserId: req.user.id,
    includeHabilitations: true
  })

  res.status(201).json(instructor)
}

export async function removeZoneInstructorHandler(req, res) {
  const zoneId = validateZoneId(req.params.zoneId)
  const instructorUserId = validateInstructorUserId(req.params.instructorUserId)

  await getZoneRightOrThrow(req.user, zoneId, {
    requireAdmin: true
  })

  if (instructorUserId === req.user.id) {
    throw createHttpError(409, 'Vous ne pouvez pas retirer votre propre accès à cette zone.')
  }

  const right = await prisma.instructorZone.findUnique({
    where: {
      instructorUserId_zoneId: {
        instructorUserId,
        zoneId
      }
    },
    include: {
      instructor: {
        include: {
          user: true
        }
      }
    }
  })

  if (!right || right.instructor?.user?.deletedAt) {
    throw createHttpError(404, 'Cet instructeur n’est pas rattaché à cette zone.')
  }

  if (right.isAdmin && await countOtherActiveZoneAdmins(zoneId, instructorUserId) === 0) {
    throw createHttpError(409, 'Impossible de retirer le dernier admin actif de cette zone.')
  }

  await prisma.instructorZone.delete({
    where: {
      id: right.id
    }
  })

  res.json(serializeInstructorRight(right, {currentUserId: req.user.id}))
}
