// Informations utilisateur authentifié
export async function getInfoHandler(req, res) {
  const response = {
    role: req.userRole,
  }

  // Ajouter les infos utilisateur si authentifié via session
  if (req.user) {
    response.user = {
      id: req.user.id,
      email: req.user.email,
      lastName: req.user.lastName,
      firstName: req.user.firstName,
    }

    if (req.user.structure) {
      response.user.structure = req.user.structure
    }
  }

  res.send(response)
}
