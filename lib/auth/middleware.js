import createHttpError from 'http-errors'
import {authenticateByToken} from '../services/auth.js'
import {prisma} from '../../db/prisma.js'
import {activeWindowWhere, getPointsPrelevementByIds} from '../models/point-prelevement.js'
import {
  getChunkZoneIds,
  getDeclarantZoneIds,
  getEffectiveDeclarantZoneIds,
  getExploitationZoneIds,
  getPermissionZoneIdsForUser,
  getPointZoneIds,
  getSourceZoneIds,
  hasZonePermission
} from '../services/zone-permissions.js'
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
  req.authToken = token
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

export function authorizeAnyZonePermission(permission) {
  return async (req, _res, next) => {
    try {
      if (!req.user) {
        return next(createHttpError(401, 'Non authentifié'))
      }

      if (req.user.role === 'ADMIN') {
        req.permittedZoneIds = await getPermissionZoneIdsForUser(req.user, permission)
        return next()
      }

      if (req.user.role === 'DECLARANT') {
        return next()
      }

      if (req.user.role !== 'INSTRUCTOR') {
        return next(createHttpError(403, 'Droits insuffisants.'))
      }

      const zoneIds = await getPermissionZoneIdsForUser(req.user, permission)
      if (zoneIds.length === 0) {
        return next(createHttpError(403, 'Ce droit ne vous est attribué sur aucune zone active.'))
      }

      req.permittedZoneIds = zoneIds
      return next()
    } catch (error) {
      return next(error)
    }
  }
}

export async function authorizeAggregationRead(req, _res, next) {
  try {
    if (!req.user) {
      throw createHttpError(401, 'Non authentifié')
    }

    if (req.user.role === 'DECLARANT') {
      return next()
    }

    const permissions = req.query.preleveurId || req.query.collecteurId
      ? ['declarant.volumes.read', 'exploitation.volumes.read']
      : ['pp.volumes.read']
    const zoneIdsByPermission = await Promise.all(
      permissions.map(permission => getPermissionZoneIdsForUser(req.user, permission))
    )
    const zoneIds = [...new Set(zoneIdsByPermission.flat())]

    if (zoneIds.length === 0) {
      throw createHttpError(403, 'Vous ne disposez pas du droit de consulter ces mesures.')
    }

    req.permittedZoneIds = zoneIds
    return next()
  } catch (error) {
    return next(error)
  }
}

export function authorizeZonePermission(permission) {
  return async (req, _res, next) => {
    try {
      if (!req.user) {
        return next(createHttpError(401, 'Non authentifié'))
      }

      const {zoneId} = req.params
      if (!zoneId) {
        return next(createHttpError(400, 'Identifiant de zone manquant.'))
      }

      if (!await hasZonePermission(req.user, permission, [zoneId])) {
        return next(createHttpError(403, 'Vous ne disposez pas de ce droit sur cette zone.'))
      }

      req.permittedZoneIds = [zoneId]
      return next()
    } catch (error) {
      return next(error)
    }
  }
}

export function authorizeZoneAnyPermission(...permissions) {
  return async (req, _res, next) => {
    try {
      if (!req.user) {
        return next(createHttpError(401, 'Non authentifié'))
      }

      const {zoneId} = req.params
      if (!zoneId) {
        return next(createHttpError(400, 'Identifiant de zone manquant.'))
      }

      const checks = await Promise.all(
        permissions.map(permission => hasZonePermission(req.user, permission, [zoneId]))
      )

      if (!checks.some(Boolean)) {
        return next(createHttpError(403, 'Vous ne disposez d’aucun des droits requis sur cette zone.'))
      }

      req.permittedZoneIds = [zoneId]
      return next()
    } catch (error) {
      return next(error)
    }
  }
}

export function authorizeDeclarationPermission(permission, {
  client = prisma,
  now = new Date()
} = {}) {
  return async (req, _res, next) => {
    try {
      if (!req.user) {
        return next(createHttpError(401, 'Non authentifié'))
      }

      if (req.user.role === 'DECLARANT') {
        return next()
      }

      const declaration = await client.declaration.findUnique({
        where: {id: req.params.declarationId},
        select: {
          declarantUserId: true,
          createdByDeclarantUserId: true,
          source: {select: {id: true}}
        }
      })

      if (!declaration) {
        return next(createHttpError(404, 'Déclaration introuvable.'))
      }

      const declarantZoneIds = declaration.source
        ? null
        : await Promise.all([
          getDeclarantZoneIds(declaration.declarantUserId, {client}),
          getDeclarantZoneIds(declaration.createdByDeclarantUserId, {client})
        ])
      const zoneIds = declaration.source
        ? await getSourceZoneIds(declaration.source.id, {client})
        : [...new Set(declarantZoneIds.flat())]
      const permittedZoneIds = await getPermissionZoneIdsForUser(
        req.user,
        permission,
        {client, now, zoneIds}
      )

      if (permittedZoneIds.length === 0) {
        return next(createHttpError(403, 'Vous ne disposez pas de ce droit pour cette déclaration.'))
      }

      req.permittedZoneIds = permittedZoneIds
      return next()
    } catch (error) {
      return next(error)
    }
  }
}

export async function authorizeDeclarantCreation(req, res, next) {
  try {
    if (!req.user) {
      return next(createHttpError(401, 'Non authentifié'))
    }

    const {error, value: zoneIds} = Joi.array()
      .items(Joi.string().guid({version: 'uuidv4'}))
      .min(1)
      .unique()
      .required()
      .validate(req.body?.zoneIds)

    if (error) {
      return next(createHttpError(400, 'Sélectionnez au moins une zone pour ce déclarant.'))
    }

    const permittedZoneIds = await getPermissionZoneIdsForUser(
      req.user,
      'declarant.create',
      {zoneIds}
    )

    if (permittedZoneIds.length !== zoneIds.length) {
      return next(createHttpError(403, 'Vous ne pouvez créer un déclarant que dans les zones où ce droit vous est attribué.'))
    }

    req.declarantZoneIds = zoneIds
    return next()
  } catch (error) {
    return next(error)
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

export function authorizePointPrelevement(
  attribute = 'read',
  permission = attribute === 'read' ? 'pp.detail.read' : 'pp.update'
) {
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
        const zoneIds = await getPointZoneIds(pointId)
        if (!await hasZonePermission(req.user, permission, zoneIds)) {
          return next(createHttpError(403, 'Vous ne disposez pas de ce droit sur les zones de ce point.'))
        }

        req.permittedZoneIds = zoneIds
        return next()
      }

      return next(createHttpError(403, 'Droits insuffisants.'))
    } catch (error) {
      return next(error)
    }
  }
}

export function authorizePointsPrelevementBatch(
  attribute = 'read',
  permission = attribute === 'read' ? 'pp.detail.read' : 'pp.update'
) {
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
        const permittedZoneIds = await getPermissionZoneIdsForUser(req.user, permission)
        const pointZones = await prisma.pointPrelevementZone.findMany({
          where: {
            pointPrelevementId: {in: pointIds},
            zoneId: {in: permittedZoneIds}
          },
          select: {pointPrelevementId: true},
          distinct: ['pointPrelevementId']
        })
        const allowedPointIds = new Set(pointZones.map(row => row.pointPrelevementId))

        req.points = points.filter(point => allowedPointIds.has(point.id))
        req.permittedZoneIds = permittedZoneIds

        return next()
      }

      return next(createHttpError(403, 'Droits insuffisants.'))
    } catch (error) {
      return next(error)
    }
  }
}

export function authorizeExploitation(
  attribute = 'read',
  permission = attribute === 'read' ? 'exploitation.detail.read' : 'exploitation.update'
) {
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
        const zoneIds = await getExploitationZoneIds(exploitationId)
        if (!await hasZonePermission(req.user, permission, zoneIds)) {
          return next(createHttpError(403, 'Vous ne disposez pas de ce droit sur les zones de cette exploitation.'))
        }

        req.permittedZoneIds = zoneIds
        return next()
      }

      return next(createHttpError(403, 'Droits insuffisants.'))
    } catch (error) {
      return next(error)
    }
  }
}

export function authorizeDeclarant(
  attribute = 'read',
  permission = attribute === 'read' ? 'declarant.detail.read' : 'declarant.update',
  {client = prisma, now = new Date()} = {}
) {
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
        const zoneIds = await getEffectiveDeclarantZoneIds(declarantId, {client})
        if (zoneIds.length === 0) {
          return next(createHttpError(403, 'Vous ne disposez pas de ce droit sur les zones de ce déclarant.'))
        }

        const permittedZoneIds = await getPermissionZoneIdsForUser(
          req.user,
          permission,
          {client, now, zoneIds}
        )
        if (permittedZoneIds.length === 0) {
          return next(createHttpError(403, 'Vous ne disposez pas de ce droit sur les zones de ce déclarant.'))
        }

        req.permittedZoneIds = permittedZoneIds
        return next()
      }

      return next(createHttpError(403, 'Droits insuffisants.'))
    } catch (error) {
      return next(error)
    }
  }
}

export function authorizeSource(
  attribute = 'read',
  permission = attribute === 'read' ? 'declaration.detail.read' : 'declaration.instruct',
  {client = prisma, now = new Date()} = {}
) {
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

      const source = await client.source.findUnique({
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
        const zoneIds = await getSourceZoneIds(sourceId, {client})
        const permittedZoneIds = await getPermissionZoneIdsForUser(
          req.user,
          permission,
          {client, now, zoneIds}
        )
        if (permittedZoneIds.length === 0) {
          return next(createHttpError(403, 'Vous ne disposez pas de ce droit pour cette déclaration.'))
        }

        req.permittedZoneIds = permittedZoneIds
        return next()
      }

      return next(createHttpError(403, 'Droits insuffisants.'))
    } catch (error) {
      return next(error)
    }
  }
}

export function authorizeChunk(
  attribute = 'read',
  permission = attribute === 'read' ? 'declaration.detail.read' : 'declaration.instruct',
  {client = prisma, now = new Date()} = {}
) {
  if (!['read', 'write', 'reconcile'].includes(attribute)) {
    throw new Error(`Invalid attribute "${attribute}". Expected "read", "write" or "reconcile".`)
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

      const chunk = await client.chunk.findUnique({
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
        const zoneIds = await getChunkZoneIds(chunkId, {client})
        const permittedZoneIds = await getPermissionZoneIdsForUser(
          req.user,
          permission,
          {client, now, zoneIds}
        )
        if (permittedZoneIds.length === 0) {
          return next(createHttpError(403, 'Vous ne disposez pas de ce droit pour cette ligne de déclaration.'))
        }

        req.permittedZoneIds = permittedZoneIds
        return next()
      }

      return next(createHttpError(403, 'Droits insuffisants.'))
    } catch (error) {
      return next(error)
    }
  }
}
