import createHttpError from 'http-errors'

import {getExploitationsFromPointId} from '../models/exploitation.js'
import {
  getPointsPrelevement,
  getPointsPrelevementByDeclarant,
  getPointsPrelevementByInstructor,
  getPointsPrelevementOptions,
  getPointsPrelevementOptionsByDeclarant,
  getPointsPrelevementOptionsByInstructor
} from '../models/point-prelevement.js'
import {decorateExploitation} from '../services/exploitation.js'
import {
  decoratePointPrelevement,
  createPointPrelevement,
  updatePointPrelevement,
  deletePointPrelevement,
  decoratePointsPrelevement
} from '../services/point-prelevement.js'
import {canEditPointUsageName} from '../services/resource-permissions.js'
import {validateUsageNameChange} from '../validation/point-validation.js'

// Liste des points de prélèvement
export async function listPointsPrelevement(req, res) {
  const role = req.userRole

  let prelevements = []

  switch (role) {
    case 'ADMIN': {
      prelevements = await getPointsPrelevement()

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
      prelevements = await getPointsPrelevementOptions()

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
    name: point.name,
    usageName: point.usageName ?? null,
    flowType: point.flowType ?? 'PRELEVEMENT'
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

export async function updatePointUsageNameHandler(req, res) {
  if (!await canEditPointUsageName(req.user, req.point.id)) {
    throw createHttpError(403, 'Droits insuffisants. Aucun rattachement actif à ce point n’a été trouvé.')
  }

  const changes = validateUsageNameChange(req.body)
  const point = await updatePointPrelevement(req.point.id, changes, {user: req.user})
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
  const pointExploitations = await getExploitationsFromPointId(req.point.id)
  const exploitations = req.user?.role === 'DECLARANT'
    && req.user?.declarant?.declarantRole === 'COLLECTEUR'
    ? pointExploitations.filter(exploitation =>
      exploitation.declarantUserId === req.user.id
      || exploitation.collecteurs?.some(link => link.collecteurUserId === req.user.id))
    : pointExploitations
  const decoratedExploitations = await Promise.all(
    exploitations.map(exploitation => decorateExploitation(exploitation, {user: req.user}))
  )

  res.send(decoratedExploitations)
}
