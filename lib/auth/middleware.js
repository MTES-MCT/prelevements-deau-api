import createHttpError from 'http-errors'
import {authenticateByToken} from '../services/auth.js'
import {prisma} from '../../db/prisma.js'
import {activeWindowWhere, getPointsPrelevementByIds} from '../models/point-prelevement.js'
import {
  canInstructorReadSource,
  canInstructorWriteSource,
  getChunkAuthorizationForInstructor
} from '../services/instructor-sources.js'
import Joi from 'joi'

export async function handleToken(req, res, next) {
  const authHeader = req.get('Authorization')

  if (!authHeader) {
    return next()
  }

  const parts = authHeader.split(' ')
  if (parts.length !== 2 || (parts[0] !== 'Bearer' && parts[0] !== 'Token')) {
    return next(createHttpError(401, 'Format d\'authentification invalide'))
  }

  const token = parts[1]
  const auth = await authenticateByToken(token)

  if (!auth) {
    return next(createHttpError(401, 'Unauthorized'))
  }

  req.auth = auth
  req.user = auth.user
  req.userRole = auth.role

  if (auth.serviceAccount) {
    req.serviceAccount = auth.serviceAccount
  }

  if (auth.actor) {
    req.authActor = auth.actor
  }

  next()
}

export function ensureServiceAccountAuthenticated(req, res, next) {
  if (!req.auth || req.auth.type !== 'SERVICE_ACCOUNT_ACCESS') {
    return next(createHttpError(401, 'Compte de service non authentifié'))
  }

  next()
}

export function ensureHumanSession(req, res, next) {
  if (!req.auth) {
    return next(createHttpError(401, 'Non authentifié'))
  }

  if (req.auth.type !== 'USER_SESSION') {
    return next(
      createHttpError(
        403,
        'Cette action n’est autorisée que pour un utilisateur connecté'
      )
    )
  }

  next()
}

export function ensureAuthenticated(req, res, next) {
  if (!req.userRole) {
    return next(createHttpError(401, 'Non authentifié'))
  }

  next()
}

function isRoleAllowed(userRole, allowedRoles) {
  if (allowedRoles.includes(userRole)) {
    return true
  }

  return userRole === 'ADMIN' && allowedRoles.includes('INSTRUCTOR')
}

export function ensureRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.userRole) {
      return next(createHttpError(401, 'Non authentifié'))
    }

    if (isRoleAllowed(req.userRole, allowedRoles)) {
      return next()
    }

    return next(createHttpError(403, 'Droits insuffisants.'))
  }
}

async function collecteurHasPointAccess(collecteurUserId, pointPrelevementId) {
  const count = await prisma.declarantCollecteurExploitation.count({
    where: {
      collecteurUserId,
      exploitation: {
        pointPrelevementId
      }
    }
  })

  return count > 0
}

async function collecteurHasExploitationAccess(collecteurUserId, exploitationId) {
  const count = await prisma.declarantCollecteurExploitation.count({
    where: {
      collecteurUserId,
      exploitationId
    }
  })

  return count > 0
}

async function collecteurCanReadDeclarant(collecteurUserId, declarantUserId) {
  const count = await prisma.declarantCollecteurExploitation.count({
    where: {
      collecteurUserId,
      exploitation: {
        declarantUserId
      }
    }
  })

  return count > 0
}

async function getCollecteurAllowedPointIds(collecteurUserId, pointIds) {
  const links = await prisma.declarantCollecteurExploitation.findMany({
    where: {
      collecteurUserId,
      exploitation: {
        pointPrelevementId: {in: pointIds}
      }
    },
    select: {
      exploitation: {
        select: {
          pointPrelevementId: true
        }
      }
    }
  })

  return new Set(links.map(link => link.exploitation.pointPrelevementId))
}

async function declarantCanReadDeclaration(userId, declaration) {
  if (!declaration) {
    return false
  }

  if (declaration.declarantUserId === userId || declaration.createdByDeclarantUserId === userId) {
    return true
  }

  return collecteurCanReadDeclarant(userId, declaration.declarantUserId)
}

export function authorizePointPrelevement(attribute = 'read') {
  if (!['read', 'write'].includes(attribute)) {
    throw new Error(`Invalid attribute "${attribute}". Expected "read" or "write".`)
  }

  return async (req, res, next) => {
    try {
      if (!req.user) {
        return next(createHttpError(401, 'Non authentifié'))
      }

      const {id: userId, role} = req.user
      const pointId = req.point?.id

      if (!pointId) {
        return next(createHttpError(404, 'Point de prélèvement introuvable'))
      }

      if (role === 'ADMIN') {
        return next()
      }

      const now = new Date()
      const isWrite = attribute === 'write'

      if (role === 'DECLARANT') {
        if (isWrite) {
          return next(createHttpError(403, 'Droits insuffisants.'))
        }

        const declarantLink = await prisma.declarantPointPrelevement.findFirst({
          where: {
            declarantUserId: userId,
            pointPrelevementId: pointId
          },
          select: {id: true}
        })

        if (declarantLink || await collecteurHasPointAccess(userId, pointId)) {
          return next()
        }

        return next(createHttpError(403, 'Droits insuffisants. Aucun rattachement à ce point n\'a été trouvé.'))
      }

      if (role === 'INSTRUCTOR') {
        const instructorZones = await prisma.instructorZone.findMany({
          where: {
            instructorUserId: userId,
            ...(isWrite ? activeWindowWhere(now, {startNullable: false, endNullable: true}) : {}),
            zone: {
              pointPrelevementZones: {
                some: {pointPrelevementId: pointId}
              }
            }
          },
          select: {isAdmin: true}
        })

        if (instructorZones.length === 0) {
          return next(
            createHttpError(
              403,
              isWrite
                ? 'Droits insuffisants. Aucun rattachement actif à une zone de ce point n\'a été trouvé.'
                : 'Droits insuffisants. Aucun rattachement à une zone de ce point n\'a été trouvé.'
            )
          )
        }

        if (isWrite && !instructorZones.some(zone => zone.isAdmin)) {
          return next(createHttpError(403, 'Droits insuffisants. Vous devez être admin d\'au moins une zone rattachée à ce point.'))
        }

        return next()
      }

      return next(createHttpError(403, 'Droits insuffisants.'))
    } catch (error) {
      return next(error)
    }
  }
}

export function authorizePointsPrelevementBatch(attribute = 'read') {
  if (!['read', 'write'].includes(attribute)) {
    throw new Error(`Invalid attribute "${attribute}". Expected "read" or "write".`)
  }

  return async (req, res, next) => {
    try {
      if (!req.user) {
        return next(createHttpError(401, 'Non authentifié'))
      }

      const {error, value} = Joi.object({
        ids: Joi.array()
          .items(Joi.string().guid({version: 'uuidv4'}))
          .min(1)
          .required()
      })
        .validate(req.body)
      if (error) {
        return next(createHttpError(400, 'Liste des points invalide.'))
      }

      const {ids} = value
      const {id: userId, role} = req.user
      const now = new Date()
      const isWrite = attribute === 'write'

      const points = await getPointsPrelevementByIds(ids)

      if (points.length === 0) {
        req.points = []
        return next()
      }

      const pointIds = points.map(point => point.id)

      if (role === 'ADMIN') {
        req.points = points
        return next()
      }

      if (role === 'DECLARANT') {
        if (isWrite) {
          req.points = []
          return next()
        }

        const [declarantLinks, collecteurAllowedPointIds] = await Promise.all([
          prisma.declarantPointPrelevement.findMany({
            where: {
              declarantUserId: userId,
              pointPrelevementId: {in: pointIds}
            },
            select: {
              pointPrelevementId: true
            }
          }),
          getCollecteurAllowedPointIds(userId, pointIds)
        ])

        const allowedPointIds = new Set(
          declarantLinks.map(link => link.pointPrelevementId)
        )

        for (const pointId of collecteurAllowedPointIds) {
          allowedPointIds.add(pointId)
        }

        req.points = points.filter(point => allowedPointIds.has(point.id))
        return next()
      }

      if (role === 'INSTRUCTOR') {
        const instructorZones = await prisma.instructorZone.findMany({
          where: {
            instructorUserId: userId,
            ...(isWrite ? activeWindowWhere(now, {startNullable: false, endNullable: true}) : {}),
            zone: {
              pointPrelevementZones: {
                some: {
                  pointPrelevementId: {in: pointIds}
                }
              }
            }
          },
          select: {
            isAdmin: true,
            zone: {
              select: {
                pointPrelevementZones: {
                  where: {
                    pointPrelevementId: {in: pointIds}
                  },
                  select: {
                    pointPrelevementId: true
                  }
                }
              }
            }
          }
        })

        const allowedMap = new Map()

        for (const instructorZone of instructorZones) {
          for (const ppz of instructorZone.zone.pointPrelevementZones) {
            const entry = allowedMap.get(ppz.pointPrelevementId) || {hasAccess: true, hasAdmin: false}
            entry.hasAccess = true
            entry.hasAdmin ||= instructorZone.isAdmin
            allowedMap.set(ppz.pointPrelevementId, entry)
          }
        }

        req.points = points.filter(point => {
          const access = allowedMap.get(point.id)
          if (!access) {
            return false
          }

          if (isWrite) {
            return access.hasAdmin
          }

          return true
        })

        return next()
      }

      return next(createHttpError(403, 'Droits insuffisants.'))
    } catch (error) {
      return next(error)
    }
  }
}

export function authorizeExploitation(attribute = 'read') {
  if (!['read', 'write'].includes(attribute)) {
    throw new Error(`Invalid attribute "${attribute}". Expected "read" or "write".`)
  }

  return async (req, res, next) => {
    try {
      if (!req.user) {
        return next(createHttpError(401, 'Non authentifié'))
      }

      const {id: userId, role} = req.user
      const exploitationId = req.params?.exploitationId

      if (!exploitationId) {
        return next(createHttpError(404, 'Exploitation introuvable'))
      }

      const now = new Date()
      const isWrite = attribute === 'write'

      const exploitation = await prisma.declarantPointPrelevement.findFirst({
        where: {
          id: exploitationId,
          ...(isWrite ? activeWindowWhere(now) : {})
        },
        select: {
          id: true,
          declarantUserId: true,
          pointPrelevementId: true
        }
      })

      if (!exploitation) {
        return next(createHttpError(404, 'Exploitation introuvable'))
      }

      if (role === 'ADMIN') {
        return next()
      }

      if (role === 'DECLARANT') {
        if (isWrite) {
          return next(createHttpError(403, 'Droits insuffisants.'))
        }

        if (exploitation.declarantUserId === userId || await collecteurHasExploitationAccess(userId, exploitationId)) {
          return next()
        }

        return next(createHttpError(403, 'Droits insuffisants. Cette exploitation n\'est pas rattachée à votre compte.'))
      }

      if (role === 'INSTRUCTOR') {
        const instructorZones = await prisma.instructorZone.findMany({
          where: {
            instructorUserId: userId,
            ...(isWrite ? activeWindowWhere(now, {startNullable: false, endNullable: true}) : {}),
            zone: {
              pointPrelevementZones: {
                some: {pointPrelevementId: exploitation.pointPrelevementId}
              }
            }
          },
          select: {isAdmin: true}
        })

        if (instructorZones.length === 0) {
          return next(
            createHttpError(
              403,
              isWrite
                ? 'Droits insuffisants. Aucun rattachement actif à une zone du point lié à cette exploitation n\'a été trouvé.'
                : 'Droits insuffisants. Aucun rattachement à une zone du point lié à cette exploitation n\'a été trouvé.'
            )
          )
        }

        if (isWrite && !instructorZones.some(zone => zone.isAdmin)) {
          return next(createHttpError(403, 'Droits insuffisants. Vous devez être admin d\'au moins une zone rattachée au point lié à cette exploitation.'))
        }

        return next()
      }

      return next(createHttpError(403, 'Droits insuffisants.'))
    } catch (error) {
      return next(error)
    }
  }
}

export function authorizeDeclarant(attribute = 'read') {
  if (!['read', 'write'].includes(attribute)) {
    throw new Error(`Invalid attribute "${attribute}". Expected "read" or "write".`)
  }

  return async (req, res, next) => {
    try {
      if (!req.user) {
        return next(createHttpError(401, 'Non authentifié'))
      }

      const {id: userId, role} = req.user
      const declarantId = req.params?.declarantId

      if (!declarantId) {
        return next(createHttpError(404, 'Déclarant introuvable'))
      }

      if (role === 'ADMIN') {
        return next()
      }

      if (role === 'DECLARANT') {
        if (attribute === 'write') {
          return next(createHttpError(403, 'Droits insuffisants.'))
        }

        if (declarantId === userId || await collecteurCanReadDeclarant(userId, declarantId)) {
          return next()
        }

        return next(createHttpError(403, 'Droits insuffisants.'))
      }

      if (role === 'INSTRUCTOR') {
        const pointPrelevementsCount = await prisma.declarantPointPrelevement.count({
          where: {
            declarantUserId: declarantId
          }
        })

        const collecteurRightsCount = await prisma.declarantCollecteurExploitation.count({
          where: {
            collecteurUserId: declarantId
          }
        })

        if (pointPrelevementsCount + collecteurRightsCount === 0) {
          return next()
        }

        const now = new Date()
        const activeWindowInstructor = activeWindowWhere(now, {
          startNullable: false,
          endNullable: true
        })

        const instructorZones = await prisma.instructorZone.findMany({
          where: {
            instructorUserId: userId,
            ...activeWindowInstructor,
            zone: {
              pointPrelevementZones: {
                some: {
                  OR: [
                    {
                      pointPrelevement: {
                        declarants: {
                          some: {
                            declarantUserId: declarantId
                          }
                        }
                      }
                    },
                    {
                      pointPrelevement: {
                        declarants: {
                          some: {
                            collecteurs: {
                              some: {collecteurUserId: declarantId}
                            }
                          }
                        }
                      }
                    }
                  ]
                }
              }
            }
          },
          select: {isAdmin: true}
        })

        if (instructorZones.length === 0) {
          return next(createHttpError(403, 'Droits insuffisants. Aucun rattachement actif à une zone liée à ce déclarant n’a été trouvé.'))
        }

        if (attribute === 'write' && !instructorZones.some(z => z.isAdmin)) {
          return next(createHttpError(403, 'Droits insuffisants. Vous devez être admin d’au moins une zone liée à ce déclarant.'))
        }

        return next()
      }

      return next(createHttpError(403, 'Droits insuffisants.'))
    } catch (error) {
      return next(error)
    }
  }
}

export function authorizeSource(attribute = 'read') {
  if (!['read', 'write'].includes(attribute)) {
    throw new Error(`Invalid attribute "${attribute}". Expected "read" or "write".`)
  }

  return async (req, res, next) => {
    try {
      if (!req.user) {
        return next(createHttpError(401, 'Non authentifié'))
      }

      const {id: userId, role} = req.user
      const sourceId = req.params?.sourceId

      if (!sourceId) {
        return next(createHttpError(404, 'Source introuvable'))
      }

      const source = await prisma.source.findUnique({
        where: {id: sourceId},
        select: {
          id: true,
          declaration: {
            select: {
              declarantUserId: true,
              createdByDeclarantUserId: true
            }
          }
        }
      })

      if (!source) {
        return next(createHttpError(404, 'Source introuvable'))
      }

      if (role === 'ADMIN') {
        return next()
      }

      if (role === 'DECLARANT') {
        if (attribute === 'write') {
          return next(createHttpError(403, 'Droits insuffisants.'))
        }

        if (await declarantCanReadDeclaration(userId, source.declaration)) {
          return next()
        }

        return next(createHttpError(403, 'Droits insuffisants. Cette source n\'est pas rattachée à votre compte.'))
      }

      if (role === 'INSTRUCTOR') {
        const allowed = attribute === 'write'
          ? await canInstructorWriteSource(userId, sourceId)
          : await canInstructorReadSource(userId, sourceId)

        if (!allowed) {
          return next(createHttpError(403, 'Droits insuffisants. Cette source ne fait pas partie de votre périmètre d’instruction.'))
        }

        return next()
      }

      return next(createHttpError(403, 'Droits insuffisants.'))
    } catch (error) {
      return next(error)
    }
  }
}

export function authorizeChunk(attribute = 'read') {
  if (!['read', 'write'].includes(attribute)) {
    throw new Error(`Invalid attribute "${attribute}". Expected "read" or "write".`)
  }

  return async (req, res, next) => {
    try {
      if (!req.user) {
        return next(createHttpError(401, 'Non authentifié'))
      }

      const {id: userId, role} = req.user
      const chunkId = req.params?.chunkId

      if (!chunkId) {
        return next(createHttpError(404, 'Chunk introuvable'))
      }

      const chunk = await prisma.chunk.findUnique({
        where: {id: chunkId},
        select: {
          id: true,
          pointPrelevementId: true,
          source: {
            select: {
              declaration: {
                select: {
                  declarantUserId: true,
                  createdByDeclarantUserId: true
                }
              }
            }
          }
        }
      })

      if (!chunk) {
        return next(createHttpError(404, 'Chunk introuvable'))
      }

      if (role === 'ADMIN') {
        return next()
      }

      if (role === 'DECLARANT') {
        if (attribute === 'write') {
          return next(createHttpError(403, 'Droits insuffisants.'))
        }

        if (await declarantCanReadDeclaration(userId, chunk.source.declaration)) {
          return next()
        }

        return next(createHttpError(403, 'Droits insuffisants. Ce chunk n\'est pas rattaché à votre compte.'))
      }

      if (role === 'INSTRUCTOR') {
        const authorization = await getChunkAuthorizationForInstructor(userId, chunkId)

        if (!authorization?.canRead) {
          return next(createHttpError(403, 'Droits insuffisants. Ce chunk ne fait pas partie de votre périmètre d’instruction.'))
        }

        if (attribute === 'write' && !authorization.canWrite) {
          return next(createHttpError(403, 'Droits insuffisants. Vous ne pouvez pas instruire ce chunk.'))
        }

        return next()
      }

      return next(createHttpError(403, 'Droits insuffisants.'))
    } catch (error) {
      return next(error)
    }
  }
}
