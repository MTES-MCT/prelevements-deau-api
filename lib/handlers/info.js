import createHttpError from 'http-errors'

// Informations utilisateur/admin
export async function getInfoHandler(req, res) {
  if (!req.isAdmin) {
    throw createHttpError(403, 'Vous n\'êtes pas autorisé à accéder à cette ressource')
  }

  res.send({
    isAdmin: true,
    territoire: req.territoire.code
  })
}
