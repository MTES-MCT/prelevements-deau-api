import createHttpError from 'http-errors'

import {prisma} from '../../db/prisma.js'
import {activeWindowWhere} from '../models/point-prelevement.js'
import {
  collecteurHasExploitationAccess,
  collecteurHasPreleveurAccess
} from '../models/exploitation.js'

function getUser(req) {
  return req.user
}

async function getAccessibleExploitationsCount({instructorUserId, exploitationIds, write}) {
  if (exploitationIds.length === 0) {
    return 0
  }

  const now = new Date()

  return prisma.declarantPointPrelevement.count({
    where: {
      id: {in: exploitationIds},
      pointPrelevement: {
        zones: {
          some: {
            zone: {
              instructorZones: {
                some: {
                  instructorUserId,
                  ...(write ? {isAdmin: true} : {}),
                  ...activeWindowWhere(now, {startNullable: false, endNullable: true})
                }
              }
            }
          }
        }
      }
    }
  })
}

async function instructorCanAccessAllExploitations({instructorUserId, exploitationIds, write}) {
  const count = await getAccessibleExploitationsCount({
    instructorUserId,
    exploitationIds,
    write
  })

  return count === exploitationIds.length
}

async function instructorCanAccessDeclarant({instructorUserId, declarantUserId, write}) {
  const exploitationIds = await prisma.declarantPointPrelevement.findMany({
    where: {declarantUserId},
    select: {id: true}
  })

  if (exploitationIds.length === 0) {
    return true
  }

  return instructorCanAccessAllExploitations({
    instructorUserId,
    exploitationIds: exploitationIds.map(exploitation => exploitation.id),
    write
  })
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

export function authorizeRegle(attribute = 'read') {
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

        const allowed = await instructorCanAccessAllExploitations({
          instructorUserId: user.id,
          exploitationIds,
          write: attribute === 'write'
        })

        if (!allowed) {
          return next(
            createHttpError(
              403,
              attribute === 'write'
                ? 'Droits insuffisants. Vous devez être admin des zones des exploitations liées à cette règle.'
                : 'Droits insuffisants. Cette règle ne fait pas partie de votre périmètre.'
            )
          )
        }

        return next()
      }

      return next(createHttpError(403, 'Droits insuffisants.'))
    } catch (error) {
      return next(error)
    }
  }
}

export function authorizeDocument(attribute = 'read') {
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
        if (req.document.declarantPointPrelevementId) {
          const allowed = await instructorCanAccessAllExploitations({
            instructorUserId: user.id,
            exploitationIds: [req.document.declarantPointPrelevementId],
            write: attribute === 'write'
          })

          if (!allowed) {
            return next(createHttpError(403, 'Droits insuffisants.'))
          }

          return next()
        }

        if (req.document.declarantUserId) {
          const allowed = await instructorCanAccessDeclarant({
            instructorUserId: user.id,
            declarantUserId: req.document.declarantUserId,
            write: attribute === 'write'
          })

          if (!allowed) {
            return next(createHttpError(403, 'Droits insuffisants.'))
          }

          return next()
        }
      }

      return next(createHttpError(403, 'Droits insuffisants.'))
    } catch (error) {
      return next(error)
    }
  }
}
