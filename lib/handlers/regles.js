import {
  updateRegle,
  deleteRegle,
  decorateRegle
} from '../services/regle.js'

// Détail d'une règle
export async function getRegleDetail(req, res) {
  const decoratedRegle = await decorateRegle(req.regle)

  res.send(decoratedRegle)
}

// Mise à jour d'une règle
export async function updateRegleHandler(req, res) {
  const regle = await updateRegle(req.regle._id, req.body)
  const decoratedRegle = await decorateRegle(regle)

  res.send(decoratedRegle)
}

// Suppression d'une règle
export async function deleteRegleHandler(req, res) {
  const deletedRegle = await deleteRegle(req.regle._id)

  res.send(deletedRegle)
}
