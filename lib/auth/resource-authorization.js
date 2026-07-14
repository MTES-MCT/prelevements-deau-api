import createHttpError from 'http-errors'

import {prisma} from '../../db/prisma.js'
import {
  collecteurHasExploitationAccess,
  collecteurHasPreleveurAccess
} from '../models/exploitation.js'
import {
  getDeclarantZoneIds,
  getExploitationZoneIds,
  hasZonePermission
} from '../services/zone-permissions.js'

function getUser(req) {
  return req.user
}

async function getExploitationIdsZoneIds(exploitationIds) {
  const zoneIds = await Promise.all(
    exploitationIds.map(exploitationId => getExploitationZoneIds(exploitationId))
  )

  return [...new Set(zoneIds.flat())]
}

async function collecteurCanAccessAllExploitations({collecteurUserId, exploitationIds}) {
  if (exploitationIds.length === 0) {
    return false
  }

  const count = await prisma.declarantCollecteurExploitation.count({
    where: {
      collecteurUserId,
      exploitationId: {in: exploitationIds}
    }
  })

  return count === exploitationIds.length
}

async function declarantCanReadRegle(user, regle) {
  if (regle.declarantUserId === user.id) {
    return true
  }

  if (user.declarant?.declarantRole !== 'COLLECTEUR') {
    return false
  }

  const exploitationIds = (regle.exploitations ?? [])
    .map(link => link.declarantPointPrelevementId)
    .filter(Boolean)

  if (exploitationIds.length > 0) {
    return collecteurCanAccessAllExploitations({
      collecteurUserId: user.id,
      exploitationIds
    })
  }

  return collecteurHasPreleveurAccess(user.id, regle.declarantUserId)
}

async function declarantCanReadDocument(user, document) {
  if (document.declarantUserId === user.id) {
    return true
  }

  if (user.declarant?.declarantRole !== 'COLLECTEUR') {
    return false
  }

  if (document.declarantPointPrelevementId) {
    return collecteurHasExploitationAccess(user.id, document.declarantPointPrelevementId)
  }

  if (document.declarantUserId) {
    return collecteurHasPreleveurAccess(user.id, document.declarantUserId)
  }

  return false
}

export function authorizeRegle(
  attribute = 'read',
  permission = attribute === 'read' ? 'declarant.rule.read' : 'declarant.rule.update'
) {
  if (!['read', 'write'].includes(attribute)) {
    throw new Error(`Invalid attribute "${attribute}". Expected "read" or "write".`)
  }

  return async (req, _res, next) => {
    try {
      const user = getUser(req)

      if (!user) {
        return next(createHttpError(401, 'Non authentifié'))
      }

      if (!req.regle) {
        return next(createHttpError(404, 'Cette règle est introuvable.'))
      }

      if (user.role === 'ADMIN') {
        return next()
      }

      if (user.role === 'DECLARANT') {
        if (attribute === 'write') {
          return next(createHttpError(403, 'Droits insuffisants.'))
        }

        if (!await declarantCanReadRegle(user, req.regle)) {
          return next(createHttpError(403, 'Droits insuffisants.'))
        }

        return next()
      }

      if (user.role === 'INSTRUCTOR') {
        const exploitationIds = (req.regle.exploitations ?? [])
          .map(link => link.declarantPointPrelevementId)
          .filter(Boolean)
        const zoneIds = exploitationIds.length > 0
          ? await getExploitationIdsZoneIds(exploitationIds)
          : await getDeclarantZoneIds(req.regle.declarantUserId)
        const allowed = await hasZonePermission(user, permission, zoneIds)

        if (!allowed) {
          return next(createHttpError(403, 'Vous ne disposez pas de ce droit pour cette règle.'))
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

export function authorizeDocument(
  attribute = 'read',
  permission = attribute === 'read' ? 'declarant.document.read' : 'declarant.document.update'
) {
  if (!['read', 'write'].includes(attribute)) {
    throw new Error(`Invalid attribute "${attribute}". Expected "read" or "write".`)
  }

  return async (req, _res, next) => {
    try {
      const user = getUser(req)

      if (!user) {
        return next(createHttpError(401, 'Non authentifié'))
      }

      if (!req.document) {
        return next(createHttpError(404, 'Ce document est introuvable.'))
      }

      if (user.role === 'ADMIN') {
        return next()
      }

      if (user.role === 'DECLARANT') {
        if (attribute === 'write') {
          return next(createHttpError(403, 'Droits insuffisants.'))
        }

        if (!await declarantCanReadDocument(user, req.document)) {
          return next(createHttpError(403, 'Droits insuffisants.'))
        }

        return next()
      }

      if (user.role === 'INSTRUCTOR') {
        let zoneIds = []

        if (req.document.declarantPointPrelevementId) {
          zoneIds = await getExploitationZoneIds(req.document.declarantPointPrelevementId)
        } else if (req.document.declarantUserId) {
          zoneIds = await getDeclarantZoneIds(req.document.declarantUserId)
        }

        if (!await hasZonePermission(user, permission, zoneIds)) {
          return next(createHttpError(403, 'Vous ne disposez pas de ce droit pour ce document.'))
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
