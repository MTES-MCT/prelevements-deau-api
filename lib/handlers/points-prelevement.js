import {
  decoratePointPrelevement,
  createPointPrelevement,
  updatePointPrelevement,
  deletePointPrelevement
} from '../services/point-prelevement.js'

import {
  getPointsPrelevementByInstructor
} from '../models/point-prelevement.js'

import {
  getExploitationsFromPointId
} from '../models/exploitation.js'

import createHttpError from 'http-errors'

// Liste des points de prélèvement
export async function listPointsPrelevement(req, res) {
  const prelevements = await getPointsPrelevementByInstructor(req.user.id)
  const decoratedPoints = await Promise.all(prelevements.map(p => decoratePointPrelevement(p)))

  res.send(decoratedPoints)
}

// Création d'un point de prélèvement
export async function createPointPrelevementHandler(req, res) {
  const point = await createPointPrelevement(req.body)
  const decoratedPoint = await decoratePointPrelevement(point)

  res.send(decoratedPoint)
}

// Détail d'un point de prélèvement
export async function getPointPrelevementDetail(req, res) {
  const decoratedPoint = await decoratePointPrelevement(req.point)

  res.send(decoratedPoint)
}

// Mise à jour d'un point de prélèvement
export async function updatePointPrelevementHandler(req, res) {
  const point = await updatePointPrelevement(req.point._id, req.body)

  res.send(point)
}

// Suppression d'un point de prélèvement
export async function deletePointPrelevementHandler(req, res) {
  const deletedPoint = await deletePointPrelevement(req.point._id)

  if (!deletedPoint) {
    throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
  }

  res.send(deletedPoint)
}

// Liste des exploitations d'un point de prélèvement
export async function getPointExploitations(req, res) {
  const exploitations = await getExploitationsFromPointId(req.point.id)

  res.send(exploitations)
}
