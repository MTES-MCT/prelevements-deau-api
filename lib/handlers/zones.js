import {randomUUID} from 'node:crypto'

import createHttpError from 'http-errors'
import Joi from 'joi'

import {prisma} from '../../db/prisma.js'
import {stageAuditMutation} from '../audit/mutations.js'
import {
  LEGACY_INSTRUCTOR_ZONE_PERMISSIONS,
  READ_ONLY_ZONE_PERMISSIONS,
  ZONE_AGENT_MANAGEMENT_PERMISSIONS,
  ZONE_PERMISSION_CODES,
  sortZonePermissions
} from '../constants/zone-permissions.js'
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
import {
  assertCanDelegateZonePermissions,
  getActiveZoneAssignmentsForUser,
  getEffectiveDeclarantUserIdsByZone,
  hasZonePermission,
  replaceInstructorZonePermissions,
  validateZonePermissions
} from '../services/zone-permissions.js'

const zoneIdSchema = Joi.string().guid({version: 'uuidv4'}).required()
const instructorUserIdSchema = Joi.string().guid({version: 'uuidv4'}).required()

const addInstructorSchema = Joi.object({
  instructorUserId: Joi.string().guid({version: 'uuidv4'}),
  email: Joi.string().allow('', null),
  firstName: Joi.string().allow('', null),
  lastName: Joi.string().allow('', null),
  phoneNumber: Joi.string().allow('', null),
  jobTitle: Joi.string().allow('', null),
  permissions: Joi.array().items(Joi.string()).unique(),
  isAdmin: Joi.boolean(),
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

export const instructorOptionsQuerySchema = Joi.object({
  search: Joi.string().max(200).allow('', null).default(''),
  limit: Joi.number().integer().min(1).max(50).default(25)
})
const zoneOptionsQuerySchema = Joi.object({
  permission: Joi.string().valid(...ZONE_PERMISSION_CODES).required()
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

function resolveSubmittedPermissions(value, existingPermissions = null) {
  if (value.permissions !== undefined) {
    return validateZonePermissions(value.permissions)
  }

  if (value.isAdmin === true) {
    return [...ZONE_PERMISSION_CODES]
  }

  if (value.isAdmin === false) {
    return [...LEGACY_INSTRUCTOR_ZONE_PERMISSIONS]
  }

  return existingPermissions ?? [...READ_ONLY_ZONE_PERMISSIONS]
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
    permissions: ZONE_PERMISSION_CODES.map(permission => ({permission})),
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

function isActiveDateRange(startDate, endDate, now = new Date()) {
  const start = asDate(startDate)
  const end = asDate(endDate)

  return Boolean(start && start <= now && (!end || end >= now))
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

async function getZoneRightOrThrow(user, zoneId, {permission} = {}) {
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
      permissions: true,
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

  if (permission && !right.permissions.some(item => item.permission === permission)) {
    throw createHttpError(403, 'Vous ne disposez pas de ce droit sur cette zone.')
  }

  return right
}

export async function countZoneDeclarants(
  declarantUserIds = [],
  declarantRole,
  {client = prisma} = {}
) {
  const uniqueDeclarantUserIds = [...new Set(declarantUserIds)]

  if (uniqueDeclarantUserIds.length === 0) {
    return 0
  }

  return client.declarant.count({
    where: {
      userId: {in: uniqueDeclarantUserIds},
      ...(declarantRole ? {declarantRole} : {}),
      user: {deletedAt: null}
    }
  })
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

async function countZoneExploitations(zoneId) {
  return prisma.declarantPointPrelevement.count({
    where: {
      pointPrelevement: {
        deletedAt: null,
        zones: {some: {zoneId}}
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

async function countOtherActiveZoneManagers(zoneId, excludedInstructorUserId, client = prisma) {
  return client.instructorZone.count({
    where: {
      zoneId,
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
      },
      AND: ZONE_AGENT_MANAGEMENT_PERMISSIONS.map(permission => ({
        permissions: {some: {permission}}
      }))
    }
  })
}

async function lockZoneAgentManagement(client, zoneId) {
  await client.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${zoneId})::bigint)
  `
}

async function decorateZoneRight(right, {declarantUserIds = []} = {}) {
  const [
    pointsCount,
    preleveursCount,
    collecteursCount,
    exploitationsCount,
    instructorsCount
  ] = await Promise.all([
    countZonePoints(right.zone.id),
    countZoneDeclarants(declarantUserIds, 'PRELEVEUR'),
    countZoneDeclarants(declarantUserIds, 'COLLECTEUR'),
    countZoneExploitations(right.zone.id),
    countVisibleZoneInstructors(right.zone.id)
  ])

  const permissions = sortZonePermissions(
    (right.permissions ?? []).map(item => item.permission ?? item)
  )

  return {
    id: right.zone.id,
    type: right.zone.type,
    code: right.zone.code,
    name: right.zone.name,
    isAdmin: permissions.length === ZONE_PERMISSION_CODES.length,
    permissions,
    startDate: right.startDate,
    endDate: right.endDate,
    pointsCount,
    preleveursCount,
    collecteursCount,
    declarantsCount: preleveursCount + collecteursCount,
    exploitationsCount,
    instructorsCount,
    right: {
      canRead: true,
      canEdit: permissions.some(permission => !permission.endsWith('.read') && !permission.endsWith('.list')),
      permissions
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
      permissions: true,
      instructor: {
        include: {
          ...(includeHabilitations
            ? {
              instructorZones: {
                include: {
                  permissions: true,
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
      permissions: true,
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
    orderBy: {createdAt: 'asc'}
  })

  return sortPeople(rights.map(right => serializeInstructorRight(right, {currentUserId})).filter(Boolean))
}

export function buildInstructorOptionsWhere(search) {
  const trimmedSearch = String(search || '').trim()

  if (!trimmedSearch) {
    return {}
  }

  return {
    AND: [...new Set(trimmedSearch.split(/\s+/))].slice(0, 12).map(term => {
      const containsTerm = {
        contains: term,
        mode: 'insensitive'
      }

      return {
        OR: [
          {email: containsTerm},
          {firstName: containsTerm},
          {lastName: containsTerm},
          {
            instructor: {
              is: {
                phoneNumber: containsTerm
              }
            }
          },
          {
            instructor: {
              is: {
                jobTitle: containsTerm
              }
            }
          }
        ]
      }
    })
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
              permissions: true,
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
        zoneId: {in: req.permittedZoneIds},
        ...activeWindowWhere(new Date(), {
          startNullable: false,
          endNullable: true
        })
      },
      include: {
        permissions: true,
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

  const declarantUserIdsByZone = await getEffectiveDeclarantUserIdsByZone(
    rights.map(right => right.zone.id)
  )
  const zones = await Promise.all(rights.map(right => decorateZoneRight(right, {
    declarantUserIds: declarantUserIdsByZone.get(right.zone.id) ?? []
  })))

  res.json(zones.sort((a, b) => a.name.localeCompare(b.name, 'fr')))
}

export async function listZoneOptionsHandler(req, res) {
  const {error, value} = zoneOptionsQuerySchema.validate(req.query, {stripUnknown: true})

  if (error) {
    throw createHttpError(400, 'Droit de zone invalide.')
  }

  const assignments = await getActiveZoneAssignmentsForUser(req.user)
  const zones = assignments
    .filter(assignment => assignment.permissions.includes(value.permission))
    .map(assignment => assignment.zone)
    .sort((left, right) => left.name.localeCompare(right.name, 'fr'))

  res.json(zones)
}

export async function getZoneHandler(req, res) {
  const zoneId = validateZoneId(req.params.zoneId)
  const right = await getZoneRightOrThrow(req.user, zoneId)
  const declarantUserIdsByZone = await getEffectiveDeclarantUserIdsByZone([zoneId])

  res.json(await decorateZoneRight(right, {
    declarantUserIds: declarantUserIdsByZone.get(zoneId) ?? []
  }))
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
    permission: 'zone.agent.create'
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

  const routeInstructorUserId = req.params.instructorUserId
    ? validateInstructorUserId(req.params.instructorUserId)
    : null
  const requestedInstructorUserId = routeInstructorUserId ?? value.instructorUserId ?? null
  const existingRight = requestedInstructorUserId
    ? await prisma.instructorZone.findUnique({
      where: {
        instructorUserId_zoneId: {
          instructorUserId: requestedInstructorUserId,
          zoneId
        }
      },
      include: {permissions: true}
    })
    : null
  const isUpdate = Boolean(existingRight)

  if (routeInstructorUserId && !existingRight) {
    throw createHttpError(404, 'Cet instructeur n’est pas rattaché à cette zone.')
  }

  await getZoneRightOrThrow(req.user, zoneId, {
    permission: isUpdate ? 'zone.agent.update' : 'zone.agent.create'
  })

  if (requestedInstructorUserId === req.user.id) {
    throw createHttpError(409, 'Vous ne pouvez pas modifier vos propres droits sur cette zone.')
  }

  const existingPermissions = existingRight
    ? sortZonePermissions(existingRight.permissions.map(item => item.permission))
    : null
  const permissions = resolveSubmittedPermissions(value, existingPermissions)

  await assertCanDelegateZonePermissions(req.user, zoneId, permissions, {
    managementPermission: isUpdate ? 'zone.agent.update' : 'zone.agent.create'
  })

  if ((value.notifyAccountCreation || value.notifyZoneAttachment)
    && !await hasZonePermission(req.user, 'zone.agent.notify', [zoneId])) {
    throw createHttpError(403, 'Vous ne disposez pas du droit d’envoyer les emails d’accès.')
  }

  const wasManager = existingPermissions
    ? ZONE_AGENT_MANAGEMENT_PERMISSIONS.every(permission => existingPermissions.includes(permission))
    : false
  const remainsManager = ZONE_AGENT_MANAGEMENT_PERMISSIONS.every(permission => permissions.includes(permission))
  const wasActiveManager = wasManager && isActiveDateRange(
    existingRight?.startDate,
    existingRight?.endDate
  )
  const remainsActiveManager = remainsManager && isActiveDateRange(value.startDate, value.endDate)

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
    if (wasActiveManager && !remainsActiveManager) {
      await lockZoneAgentManagement(tx, zoneId)
      if (await countOtherActiveZoneManagers(zoneId, requestedInstructorUserId, tx) === 0) {
        throw createHttpError(409, 'Impossible de retirer les droits du dernier gestionnaire actif de cette zone.')
      }
    }

    let user

    if (requestedInstructorUserId) {
      user = await tx.user.findUnique({
        where: {
          id: requestedInstructorUserId
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

    if (user.id === req.user.id) {
      throw createHttpError(409, 'Vous ne pouvez pas modifier vos propres droits sur cette zone.')
    }

    instructorUser = user

    const right = await tx.instructorZone.upsert({
      where: {
        instructorUserId_zoneId: {
          instructorUserId: user.id,
          zoneId
        }
      },
      update: {
        isAdmin: permissions.length === ZONE_PERMISSION_CODES.length,
        startDate: asDate(value.startDate),
        endDate: asDate(value.endDate)
      },
      create: {
        instructorUserId: user.id,
        zoneId,
        isAdmin: permissions.length === ZONE_PERMISSION_CODES.length,
        startDate: asDate(value.startDate),
        endDate: asDate(value.endDate)
      }
    })

    await replaceInstructorZonePermissions({
      client: tx,
      instructorZone: right,
      permissions
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

  stageAuditMutation(req, {
    operation: isUpdate ? 'UPDATE' : 'CREATE',
    entityType: 'ZONE_AGENT_ASSIGNMENT',
    entityId: `${zoneId}:${instructorUser.id}`,
    entityLabel: getInstructorDisplayName(instructorUser),
    before: existingRight
      ? {
        ...existingRight,
        permissions: existingPermissions
      }
      : null,
    after: {
      zoneId,
      instructorUserId: instructorUser.id,
      isAdmin: permissions.length === ZONE_PERMISSION_CODES.length,
      startDate: asDate(value.startDate),
      endDate: asDate(value.endDate),
      permissions
    }
  })

  res.status(isUpdate ? 200 : 201).json(instructor)
}

export async function removeZoneInstructorHandler(req, res) {
  const zoneId = validateZoneId(req.params.zoneId)
  const instructorUserId = validateInstructorUserId(req.params.instructorUserId)

  await getZoneRightOrThrow(req.user, zoneId, {
    permission: 'zone.agent.remove'
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
      permissions: true,
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

  const permissions = sortZonePermissions(right.permissions.map(item => item.permission))
  const isManager = ZONE_AGENT_MANAGEMENT_PERMISSIONS.every(permission => permissions.includes(permission))

  await prisma.$transaction(async tx => {
    if (isManager && isActiveDateRange(right.startDate, right.endDate)) {
      await lockZoneAgentManagement(tx, zoneId)
      if (await countOtherActiveZoneManagers(zoneId, instructorUserId, tx) === 0) {
        throw createHttpError(409, 'Impossible de retirer le dernier gestionnaire actif de cette zone.')
      }
    }

    await tx.instructorZone.delete({where: {id: right.id}})
  })

  stageAuditMutation(req, {
    operation: 'DELETE',
    entityType: 'ZONE_AGENT_ASSIGNMENT',
    entityId: `${zoneId}:${instructorUserId}`,
    entityLabel: getInstructorDisplayName(right.instructor.user),
    before: {
      ...right,
      permissions
    }
  })

  res.json(serializeInstructorRight(right, {currentUserId: req.user.id}))
}

async function getNotifiableZoneInstructor(zoneId, instructorUserId) {
  const user = await prisma.user.findFirst({
    where: {
      id: instructorUserId,
      role: 'INSTRUCTOR',
      deletedAt: null,
      instructor: {
        instructorZones: {some: {zoneId}}
      }
    },
    include: {instructor: true}
  })

  if (!user?.instructor) {
    throw createHttpError(404, 'Cet instructeur n’est pas rattaché à cette zone.')
  }

  return user
}

export async function sendZoneInstructorAccountCreationNotificationHandler(req, res) {
  const zoneId = validateZoneId(req.params.zoneId)
  const instructorUserId = validateInstructorUserId(req.params.instructorUserId)

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'zone.agent.notify'})
  const instructor = await getNotifiableZoneInstructor(zoneId, instructorUserId)
  await sendAccountCreationNotification(instructor, {role: 'INSTRUCTOR'})

  res.json(await getVisibleZoneInstructor(zoneId, instructorUserId, {
    includeEnded: true,
    currentUserId: req.user.id,
    includeHabilitations: true
  }))
}

export async function sendZoneInstructorAttachmentNotificationHandler(req, res) {
  const zoneId = validateZoneId(req.params.zoneId)
  const instructorUserId = validateInstructorUserId(req.params.instructorUserId)

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'zone.agent.notify'})
  const [instructor, zone] = await Promise.all([
    getNotifiableZoneInstructor(zoneId, instructorUserId),
    getZoneById(zoneId)
  ])
  await sendZoneAttachmentNotification({instructor, zone})

  res.json(await getVisibleZoneInstructor(zoneId, instructorUserId, {
    includeEnded: true,
    currentUserId: req.user.id,
    includeHabilitations: true
  }))
}
