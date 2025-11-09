import {
  getPointsPrelevementFromTerritoire
} from '../models/point-prelevement.js'

import {
  getPreleveurs
} from '../models/preleveur.js'

// Liste des points de prélèvement d'un territoire
export async function getTerritoirePointsPrelevement(req, res) {
  const points = await getPointsPrelevementFromTerritoire(req.params.codeTerritoire)

  res.send(points)
}

// Liste des préleveurs d'un territoire
export async function getTerritoirePreleveurs(req, res) {
  const preleveurs = await getPreleveurs(req.params.codeTerritoire)

  res.send(preleveurs)
}
