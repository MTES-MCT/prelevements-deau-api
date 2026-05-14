import {randomUUID} from 'node:crypto'

import createHttpError from 'http-errors'
import Joi from 'joi'

import {prisma} from '../../db/prisma.js'
import {activeWindowWhere} from '../models/point-prelevement.js'
import {normalizeEmail} from '../util/email.js'

const zoneIdSchema = Joi.string().guid({version: 'uuidv4'}).required()
const instructorUserIdSchema = Joi.string().guid({version: 'uuidv4'}).required()

const addInstructorSchema = Joi.object({
  email: Joi.string().required(),
  firstName: Joi.string().allow('', null),
  lastName: Joi.string().allow('', null),
  phoneNumber: Joi.string().allow('', null),
  jobTitle: Joi.string().allow('', null),
  isAdmin: Joi.boolean().default(false),
  startDate: Joi.date().iso().required(),
  endDate: Joi.date().iso().allow(null)
}).custom((value, helpers) => {
  if (value.endDate && value.startDate > value.endDate) {
    return helpers.error('any.invalid')
  }

  return value
}, 'cohérence des dates')

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
  const fullName = [person.firstName, person.lastName].filter(Boolean).join(' ').trim()
  return fullName || person.socialReason || person.email || ''
}

function sortPeople(items) {
  return items.sort((a, b) => getDisplayName(a).localeCompare(getDisplayName(b), 'fr'))
}

async function getZoneRightOrThrow(instructorUserId, zoneId, {requireAdmin = false} = {}) {
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
  const [declarantsCount, instructorsCount] = await Promise.all([
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
    declarantsCount,
    instructorsCount,
    right: {
      canRead: true,
      canEdit: right.isAdmin
    }
  }
}

function serializeInstructorRight(right, {currentUserId = null} = {}) {
  const user = right.instructor?.user

  if (!user || user.deletedAt) {
    return null
  }

  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    phoneNumber: right.instructor.phoneNumber,
    jobTitle: right.instructor.jobTitle,
    isAdmin: right.isAdmin,
    isCurrentUser: user.id === currentUserId,
    startDate: right.startDate,
    endDate: right.endDate,
    createdAt: right.createdAt,
    updatedAt: right.updatedAt
  }
}

async function getVisibleZoneInstructor(zoneId, instructorUserId, {
  includeEnded = false,
  currentUserId = null
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
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              deletedAt: true
            }
          }
        }
      }
    }
  })

  return right ? serializeInstructorRight(right, {currentUserId}) : null
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
  const rights = await prisma.instructorZone.findMany({
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
  const right = await getZoneRightOrThrow(req.user.id, zoneId)

  res.json(await decorateZoneRight(right))
}

export async function listZoneDeclarantsHandler(req, res) {
  const zoneId = validateZoneId(req.params.zoneId)

  await getZoneRightOrThrow(req.user.id, zoneId)

  res.json(await getZoneDeclarants(zoneId))
}

export async function listZoneInstructorsHandler(req, res) {
  const zoneId = validateZoneId(req.params.zoneId)

  await getZoneRightOrThrow(req.user.id, zoneId)

  res.json(await getZoneInstructors(zoneId, req.user.id))
}

export async function getZoneInstructorHandler(req, res) {
  const zoneId = validateZoneId(req.params.zoneId)
  const instructorUserId = validateInstructorUserId(req.params.instructorUserId)

  await getZoneRightOrThrow(req.user.id, zoneId)

  const instructor = await getVisibleZoneInstructor(zoneId, instructorUserId, {
    currentUserId: req.user.id
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

  await getZoneRightOrThrow(req.user.id, zoneId, {
    requireAdmin: true
  })

  const email = normalizeEmail(value.email)

  const userData = removeUndefinedValues({
    firstName: optionalText(value.firstName),
    lastName: optionalText(value.lastName)
  })

  const instructorData = removeUndefinedValues({
    phoneNumber: optionalText(value.phoneNumber),
    jobTitle: optionalText(value.jobTitle)
  })

  let instructorUserId

  await prisma.$transaction(async tx => {
    let user = await tx.user.findUnique({
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

    if (user) {
      if (Object.keys(userData).length > 0) {
        user = await tx.user.update({
          where: {
            id: user.id
          },
          data: userData,
          include: {
            instructor: true
          }
        })
      }

      if (user.instructor) {
        if (Object.keys(instructorData).length > 0) {
          await tx.instructor.update({
            where: {
              userId: user.id
            },
            data: instructorData
          })
        }
      } else {
        await tx.instructor.create({
          data: {
            userId: user.id,
            ...instructorData
          }
        })
      }
    } else {
      user = await tx.user.create({
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

    instructorUserId = user.id

    await tx.instructorZone.upsert({
      where: {
        instructorUserId_zoneId: {
          instructorUserId: user.id,
          zoneId
        }
      },
      update: {
        isAdmin: value.isAdmin,
        startDate: value.startDate,
        endDate: value.endDate ?? null
      },
      create: {
        instructorUserId: user.id,
        zoneId,
        isAdmin: value.isAdmin,
        startDate: value.startDate,
        endDate: value.endDate ?? null
      }
    })
  })

  const instructor = await getVisibleZoneInstructor(zoneId, instructorUserId, {
    includeEnded: true,
    currentUserId: req.user.id
  })

  res.status(201).json(instructor)
}

export async function removeZoneInstructorHandler(req, res) {
  const zoneId = validateZoneId(req.params.zoneId)
  const instructorUserId = validateInstructorUserId(req.params.instructorUserId)

  if (instructorUserId === req.user.id) {
    throw createHttpError(
      400,
      'Vous ne pouvez pas vous retirer vous-même de cette zone.'
    )
  }

  await getZoneRightOrThrow(req.user.id, zoneId, {
    requireAdmin: true
  })

  const right = await prisma.instructorZone.findUnique({
    where: {
      instructorUserId_zoneId: {
        instructorUserId,
        zoneId
      }
    }
  })

  if (!right) {
    throw createHttpError(404, 'Cet instructeur n’est pas rattaché à cette zone.')
  }

  if (right.isAdmin) {
    const otherActiveAdmins = await countOtherActiveZoneAdmins(zoneId, instructorUserId)

    if (otherActiveAdmins === 0) {
      throw createHttpError(
        400,
        'Impossible de supprimer le dernier admin actif de la zone.'
      )
    }
  }

  await prisma.instructorZone.delete({
    where: {
      instructorUserId_zoneId: {
        instructorUserId,
        zoneId
      }
    }
  })

  res.status(204).end()
}
