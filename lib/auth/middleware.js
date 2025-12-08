import createHttpError from 'http-errors'

import {getTerritoireByToken} from '../models/territoire.js'

export function ensureIsAdmin(req, res, next) {
  if (!req.isAdmin) {
    return next(createHttpError(403, 'Vous devez être administrateur'))
  }

  next()
}

export async function handleToken(req, res, next) {
  if (!req.get('Authorization')) {
    return next()
  }

  const token = req.get('Authorization').split(' ')[1]
  const territoire = await getTerritoireByToken(token)

  if (!territoire) {
    return next(createHttpError(401, 'Unauthorized'))
  }

  req.isAdmin = true
  req.territoire = territoire

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
    // Pour le moment, tout le monde est reader + editor
    // La vérification du territoire reste active
    const object = req[objectType]
    const paramKey = objectType === 'territoire' ? 'codeTerritoire' : null

    if (paramKey && req.territoire.code !== req.params[paramKey]) {
      // Cas spécial pour territoire (utilise params)
      return next(createHttpError(403, 'Vous n\'avez pas de droit sur ce territoire.'))
    }

    if (object && req.territoire.code !== object.territoire) {
      // Cas général (utilise l'objet résolu)
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
