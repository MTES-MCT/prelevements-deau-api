import createHttpError from 'http-errors'
import {authenticateByToken} from '../services/auth.js'
import {prisma} from '../../db/prisma.js'
import {activeWindowWhere} from "../models/point-prelevement.js";

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

  req.user = auth.user
  req.userRole = auth.role

  next()
}

export function ensureAuthenticated(req, res, next) {
  if (!req.userRole) {
    return next(createHttpError(401, 'Non authentifié'))
  }

  next()
}

export function ensureRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.userRole) {
      return next(createHttpError(401, 'Non authentifié'))
    }

    if (allowedRoles.includes(req.userRole)) {
      return next()
    }

    return next(createHttpError(403, 'Droits insuffisants.'))
  }
}

const VALID_OBJECT_TYPES = new Set(['point', 'preleveur', 'exploitation', 'document', 'regle', 'series', 'territoire'])
export function authorize(objectType, role = 'reader') {
  if (!VALID_OBJECT_TYPES.has(objectType)) {
    throw new Error(`Type d'objet inconnu: ${objectType}`)
  }

  return async (req, res, next) => {
    if (!req.userRole) {
      return next(createHttpError(401, 'Non authentifié'))
    }

    if (role === 'editor' && req.userRole === 'reader') {
      return next(createHttpError(403, 'Droits insuffisants. Vous devez être éditeur.'))
    }

    if (role === 'declarant' && req.userRole !== 'declarant') {
      return next(createHttpError(403, 'Droits insuffisants. Vous devez être déclarant.'))
    }

    // Vérification du territoire
    const object = req[objectType]
    const paramKey = objectType === 'territoire' ? 'codeTerritoire' : null

    if (paramKey && req.territoire.code !== req.params[paramKey]) {
      return next(createHttpError(403, 'Vous n\'avez pas de droit sur ce territoire.'))
    }

    if (object && req.territoire.code !== object.territoire) {
      const messages = {
        point: 'ce point',
        preleveur: 'ce préleveur',
        exploitation: 'cette exploitation',
        document: 'ce document',
        regle: 'cette règle',
        series: 'cette série'
      }
      return next(createHttpError(403, `Vous n'avez pas de droit sur ${messages[objectType]}.`))
    }

    next()
  }
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

      const now = new Date()
      const activeWindowDeclarant = activeWindowWhere(now)
      const activeWindowInstructor = activeWindowWhere(now, {startNullable: false, endNullable: true})

      if (role === 'DECLARANT') {
        if (attribute === 'write') {
          return next(createHttpError(403, 'Droits insuffisants.'))
        }

        const hasLink = await prisma.declarantPointPrelevement.findFirst({
          where: {
            declarantUserId: userId,
            pointPrelevementId: pointId,
            ...activeWindowDeclarant
          },
          select: {id: true}
        })

        if (!hasLink) {
          return next(
            createHttpError(
              403,
              'Droits insuffisants. Aucun rattachement actif à ce point n\'a été trouvé.'
            )
          )
        }

        return next()
      }

      if (role === 'INSTRUCTOR') {
        const instructorZones = await prisma.instructorZone.findMany({
          where: {
            instructorUserId: userId,
            ...activeWindowInstructor,
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
              'Droits insuffisants. Aucun rattachement actif à une zone de ce point n\'a été trouvé.'
            )
          )
        }

        if (attribute === 'write' && !instructorZones.some(z => z.isAdmin)) {
          return next(
            createHttpError(
              403,
              'Droits insuffisants. Vous devez être admin d\'au moins une zone rattachée à ce point.'
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
      const activeWindow = {
        AND: [
          {OR: [{startDate: null}, {startDate: {lte: now}}]},
          {OR: [{endDate: null}, {endDate: {gte: now}}]}
        ]
      }

      // 1) Charger l’exploitation (pour récupérer le point lié + le déclarant propriétaire)
      const exploitation = await prisma.declarantPointPrelevement.findFirst({
        where: {
          id: exploitationId,
          ...activeWindow
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

      // 2) Règles d’accès par rôle
      if (role === 'DECLARANT') {
        if (attribute === 'write') {
          return next(createHttpError(403, 'Droits insuffisants.'))
        }

        if (exploitation.declarantUserId !== userId) {
          return next(
            createHttpError(
              403,
              'Droits insuffisants. Cette exploitation n\'est pas rattachée à votre compte.'
            )
          )
        }

        return next()
      }

      if (role === 'INSTRUCTOR') {
        const instructorZones = await prisma.instructorZone.findMany({
          where: {
            instructorUserId: userId,
            ...activeWindow,
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
              'Droits insuffisants. Aucun rattachement actif à une zone du point lié à cette exploitation n\'a été trouvé.'
            )
          )
        }

        if (attribute === 'write' && !instructorZones.some(z => z.isAdmin)) {
          return next(
            createHttpError(
              403,
              'Droits insuffisants. Vous devez être admin d\'au moins une zone rattachée au point lié à cette exploitation.'
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

      const now = new Date()
      const activeWindow = {
        AND: [
          {OR: [{startDate: null}, {startDate: {lte: now}}]},
          {OR: [{endDate: null}, {endDate: {gte: now}}]}
        ]
      }

      // 1) Déclarant : accès uniquement à soi-même
      if (role === 'DECLARANT') {
        if (declarantId !== userId) {
          return next(createHttpError(403, 'Droits insuffisants.'))
        }

        return next()
      }

      // 2) Instructeur : accès si au moins un rattachement actif du déclarant à un point,
      // et que l’instructeur a au moins une zone active rattachée à ce point.
      if (role === 'INSTRUCTOR') {
        const instructorZones = await prisma.instructorZone.findMany({
          where: {
            instructorUserId: userId,
            ...activeWindow,
            zone: {
              pointPrelevementZones: {
                some: {
                  pointPrelevement: {
                    declarants: {
                      some: {
                        declarantUserId: declarantId,
                        ...activeWindow
                      }
                    }
                  }
                }
              }
            }
          },
          select: {isAdmin: true}
        })

        if (instructorZones.length === 0) {
          return next(
            createHttpError(
              403,
              'Droits insuffisants. Aucun rattachement actif à une zone liée à un point de ce déclarant n\'a été trouvé.'
            )
          )
        }

        if (attribute === 'write' && !instructorZones.some(z => z.isAdmin)) {
          return next(
            createHttpError(
              403,
              'Droits insuffisants. Vous devez être admin d\'au moins une zone liée à un point de ce déclarant.'
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
