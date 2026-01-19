// Informations utilisateur authentifié
export async function getInfoHandler(req, res) {
  const response = {
    roles: req.userRoles,
  }

  // Ajouter les infos utilisateur si authentifié via session (pas token legacy)
  if (req.user) {
    response.user = {
      _id: req.user._id.toString(),
      email: req.user.email,
      nom: req.user.nom,
      prenom: req.user.prenom
    }

    if (req.user.structure) {
      response.user.structure = req.user.structure
    }
  }

  res.send(response)
}
