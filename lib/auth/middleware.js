import createHttpError from 'http-errors'

import {authenticateByToken} from '../services/auth.js'

export function ensureIsAdmin(req, res, next) {
  if (!req.isAdmin) {
    return next(createHttpError(403, 'Vous devez être administrateur'))
  }

  next()
}

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
  req.territoire = auth.territoire
  req.userRole = auth.userRole
  req.isAdmin = auth.isAdmin

  next()
}

const VALID_OBJECT_TYPES = new Set(['point', 'preleveur', 'exploitation', 'document', 'regle', 'series', 'territoire'])
const VALID_ROLES = new Set(['reader', 'editor'])

export function authorize(objectType, role = 'reader') {
  if (!VALID_OBJECT_TYPES.has(objectType)) {
    throw new Error(`Type d'objet inconnu: ${objectType}`)
  }

  if (!VALID_ROLES.has(role)) {
    throw new Error(`Rôle inconnu: ${role}`)
  }

  return async (req, res, next) => {
    // Vérifier le rôle de l'utilisateur
    if (!req.userRole) {
      return next(createHttpError(401, 'Non authentifié'))
    }

    // Si editor est requis et l'utilisateur est reader, refuser
    if (role === 'editor' && req.userRole === 'reader') {
      return next(createHttpError(403, 'Droits insuffisants. Vous devez être éditeur.'))
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
