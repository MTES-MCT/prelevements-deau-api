import createHttpError from 'http-errors'

import {recordUserActivity} from '../models/user-activity.js'
import {userActivityPayloadSchema} from '../validation/user-activity.js'

const HUMAN_ROLES = new Set(['ADMIN', 'INSTRUCTOR', 'DECLARANT'])

export function createUserActivityHandler({recordActivity = recordUserActivity} = {}) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store')

    if (!req.auth) {
      throw createHttpError(401, 'Non authentifié')
    }

    if (req.auth.type !== 'USER_SESSION') {
      throw createHttpError(403, 'Cette action est réservée aux utilisateurs connectés.')
    }

    const {actor, impersonation, user} = req.auth
    if ((actor && actor.type !== 'USER') || (impersonation && !actor)) {
      throw createHttpError(403, 'Session utilisateur invalide.')
    }

    const activeUser = actor || user
    if (!activeUser?.id || activeUser.deletedAt || !HUMAN_ROLES.has(activeUser.role)) {
      throw createHttpError(403, 'Session utilisateur invalide.')
    }

    const {error} = userActivityPayloadSchema.validate(req.body ?? {})
    const {error: queryError} = userActivityPayloadSchema.validate(req.query ?? {})
    if (error || queryError) {
      throw createHttpError(400, 'Ce signal d’activité ne contient aucun paramètre.')
    }

    try {
      const activity = await recordActivity({userId: activeUser.id, role: activeUser.role})
      res.status(200).json(activity)
    } catch {
      // L’erreur générique passe par le journal technique existant, sans y
      // ajouter l’identité, la navigation ni les détails de la requête SQL.
      throw createHttpError(503, 'La mesure d’activité est momentanément indisponible.')
    }
  }
}

export const postUserActivityHandler = createUserActivityHandler()
