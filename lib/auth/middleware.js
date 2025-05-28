import createHttpError from 'http-errors'
import {getPointPrelevement} from '../models/points-prelevement.js'
import {getPreleveur} from '../models/preleveur.js'
import {getExploitation} from '../models/exploitation.js'

export function ensureIsAdmin(req, res, next) {
  if (!req.isAdmin) {
    return next(createHttpError(403, 'Vous devez être administrateur'))
  }

  next()
}

export async function checkPermissionOnPoint(req, res, next) {
  const point = await getPointPrelevement(req.params.id)

  if (req.territoire !== point.territoire) {
    return next(createHttpError(403, 'Vous n’avez pas de droit sur ce point.'))
  }

  next()
}

export async function checkPermissionOnPreleveur(req, res, next) {
  const preleveur = await getPreleveur(req.params.id)

  if (req.territoire !== preleveur.territoire) {
    return next(createHttpError(403, 'Vous n’avez pas de droit sur ce préleveur.'))
  }

  next()
}

export async function checkPermissionOnExploitation(req, res, next) {
  const exploitation = await getExploitation(req.params.id)

  if (req.territoire !== exploitation.territoire) {
    return next(createHttpError(403, 'Vous n’avez pas de droit sur cette exploitation'))
  }

  next()
}

