import createHttpError from 'http-errors'

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
