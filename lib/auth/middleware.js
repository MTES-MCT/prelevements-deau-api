import createHttpError from 'http-errors'

export function ensureIsAdmin(req, res, next) {
  if (!req.isAdmin) {
    return next(createHttpError(403, 'Vous devez être administrateur'))
  }

  next()
}

