import createHttpError from 'http-errors'

import {getTerritoireByToken} from '../models/territoire.js'

export function ensureIsAdmin(req, res, next) {
  if (!req.isAdmin) {
    return next(createHttpError(403, 'Vous devez être administrateur'))
  }

  next()
}

export async function checkPermissionOnPoint(req, res, next) {
  if (req.territoire.code !== req.point.territoire) {
    return next(createHttpError(403, 'Vous n’avez pas de droit sur ce point.'))
  }

  next()
}

export async function checkPermissionOnPreleveur(req, res, next) {
  if (req.territoire.code !== req.preleveur.territoire) {
    return next(createHttpError(403, 'Vous n’avez pas de droit sur ce préleveur.'))
  }

  next()
}

export async function checkPermissionOnExploitation(req, res, next) {
  if (req.territoire.code !== req.exploitation.territoire) {
    return next(createHttpError(403, 'Vous n’avez pas de droit sur cette exploitation.'))
  }

  next()
}

export async function checkPermissionOnTerritoire(req, res, next) {
  if (req.territoire.code !== req.params.codeTerritoire) {
    return next(createHttpError(403, 'Vous n’avez pas de droit sur ce territoire.'))
  }

  next()
}

export async function checkPermissionOnDocument(req, res, next) {
  if (req.territoire.code !== req.document.territoire.code) {
    return next(createHttpError(403, 'Vous n’avez pas de droit sur ce document.'))
  }
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
