import {
  decoratePointPrelevement,
  createPointPrelevement,
  updatePointPrelevement,
  deletePointPrelevement,
  decoratePointsPrelevement
} from '../services/point-prelevement.js'
import {decorateExploitation} from '../services/exploitation.js'

import {
  getPointsPrelevementByDeclarant,
  getPointsPrelevementByInstructor,
  getPointsPrelevementOptionsByDeclarant,
  getPointsPrelevementOptionsByInstructor
} from '../models/point-prelevement.js'

import {
  getExploitationsFromPointId
} from '../models/exploitation.js'

import createHttpError from 'http-errors'

// Liste des points de prélèvement
export async function listPointsPrelevement(req, res) {
  const role = req.userRole

  let prelevements = []

  switch (role) {
    case 'ADMIN': {
      prelevements = await getPointsPrelevementByInstructor(req.user.id)

      break
    }

    case 'INSTRUCTOR': {
      prelevements = await getPointsPrelevementByInstructor(req.user.id)

      break
    }

    case 'DECLARANT': {
      prelevements = await getPointsPrelevementByDeclarant(req.user.id)

      break
    }
  // No default
  }

  const decoratedPoints = await decoratePointsPrelevement(prelevements, {user: req.user})

  res.send(decoratedPoints)
}

// Liste des points de prélèvement (allégée)
export async function listPointsPrelevementOptions(req, res) {
  const role = req.userRole

  let prelevements = []

  switch (role) {
    case 'ADMIN': {
      prelevements = await getPointsPrelevementOptionsByInstructor(req.user.id)

      break
    }

    case 'INSTRUCTOR': {
      prelevements = await getPointsPrelevementOptionsByInstructor(req.user.id)

      break
    }

    case 'DECLARANT': {
      prelevements = await getPointsPrelevementOptionsByDeclarant(req.user.id)

      break
    }
  // No default
  }

  const options = prelevements.map(point => ({
    id: point.id,
    name: point.name
  }))

  res.send(options)
}

// Création d'un point de prélèvement
export async function createPointPrelevementHandler(req, res) {
  const point = await createPointPrelevement(req.body, {user: req.user})
  const decoratedPoint = await decoratePointPrelevement(point, {user: req.user})

  res.send(decoratedPoint)
}

// Détail d'un point de prélèvement
export async function getPointPrelevementDetail(req, res) {
  const decoratedPoint = await decoratePointPrelevement(req.point, {user: req.user})

  res.send(decoratedPoint)
}

export async function getPointsPrelevementBatchDetail(req, res) {
  const decoratedPoints = await decoratePointsPrelevement(req.points, {user: req.user})
  res.send(decoratedPoints)
}

// Mise à jour d'un point de prélèvement
export async function updatePointPrelevementHandler(req, res) {
  const point = await updatePointPrelevement(req.point.id, req.body, {user: req.user})
  const decoratedPoint = await decoratePointPrelevement(point, {user: req.user})

  res.send(decoratedPoint)
}

// Suppression d'un point de prélèvement
export async function deletePointPrelevementHandler(req, res) {
  const deletedPoint = await deletePointPrelevement(req.point.id)

  if (!deletedPoint) {
    throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
  }

  res.send(deletedPoint)
}

// Liste des exploitations d'un point de prélèvement
export async function getPointExploitations(req, res) {
  const exploitations = await getExploitationsFromPointId(req.point.id)
  const decoratedExploitations = await Promise.all(
    exploitations.map(exploitation => decorateExploitation(exploitation, {user: req.user}))
  )

  res.send(decoratedExploitations)
}
