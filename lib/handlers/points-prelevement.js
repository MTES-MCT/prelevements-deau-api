import createHttpError from 'http-errors'

import {stageAuditMutation} from '../audit/mutations.js'

import {getExploitationsFromPointId} from '../models/exploitation.js'
import {
  getPointsPrelevement,
  getPointsPrelevementByDeclarant,
  getPointsPrelevementByInstructor,
  getPointMapSummaries,
  getPointMapSummariesByDeclarant,
  getPointMapSummariesByInstructor,
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
  decoratePointsPrelevement,
  serializePointMapSummaries
} from '../services/point-prelevement.js'
import {canEditPointUsageName} from '../services/resource-permissions.js'
import {getPermissionZoneIdsForUser} from '../services/zone-permissions.js'
import {withRequestPerformancePhase} from '../util/request-performance.js'
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
      prelevements = await getPointsPrelevementByInstructor(
        req.permittedZoneIds
      )

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
      prelevements = await getPointsPrelevementOptionsByInstructor(
        req.permittedZoneIds
      )

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
    codeBSS: point.codeBSS ?? null,
    usageName: point.usageName ?? null,
    flowType: point.flowType ?? 'PRELEVEMENT'
  }))

  res.send(options)
}

// Liste cartographique sans les déclarants ni le calcul individuel des droits.
export async function listPointMapSummaries(req, res) {
  let points = []
  let readableDetailZoneIds
  let readableDeclarantZoneIds
  let readableExploitationZoneIds
  let visibleZoneIds

  switch (req.userRole) {
    case 'ADMIN': {
      points = await withRequestPerformancePhase(
        'map_load',
        async () => getPointMapSummaries()
      )
      break
    }

    case 'INSTRUCTOR': {
      const [mapPoints, detailZoneIds, declarantZoneIds, exploitationZoneIds]
        = await withRequestPerformancePhase('map_load', async () => Promise.all([
          getPointMapSummariesByInstructor(req.permittedZoneIds),
          getPermissionZoneIdsForUser(req.user, 'pp.detail.read'),
          getPermissionZoneIdsForUser(req.user, 'declarant.list'),
          getPermissionZoneIdsForUser(req.user, 'exploitation.list')
        ]))
      points = mapPoints
      readableDetailZoneIds = new Set(detailZoneIds)
      readableDeclarantZoneIds = new Set(declarantZoneIds)
      readableExploitationZoneIds = new Set(exploitationZoneIds)
      visibleZoneIds = new Set(req.permittedZoneIds)
      break
    }

    case 'DECLARANT': {
      points = await withRequestPerformancePhase(
        'map_load',
        async () => getPointMapSummariesByDeclarant(req.user.id)
      )
      break
    }
    // No default
  }

  res.send(withRequestPerformancePhase(
    'map_serialize',
    () => serializePointMapSummaries(points, {
      readableDeclarantZoneIds,
      readableDetailZoneIds,
      readableExploitationZoneIds,
      visibleZoneIds
    })
  ))
}

// Création d'un point de prélèvement
export async function createPointPrelevementHandler(req, res) {
  const point = await createPointPrelevement(req.body, {user: req.user})
  const decoratedPoint = await decoratePointPrelevement(point, {user: req.user})

  stageAuditMutation(req, {
    operation: 'CREATE',
    entityType: 'POINT',
    entityId: point.id,
    entityLabel: point.usageName || point.name,
    after: point
  })

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

  stageAuditMutation(req, {
    operation: 'UPDATE',
    entityType: 'POINT',
    entityId: point.id,
    entityLabel: point.usageName || point.name,
    before: req.point,
    after: point
  })

  res.send(decoratedPoint)
}

export async function updatePointUsageNameHandler(req, res) {
  if (!await canEditPointUsageName(req.user, req.point.id)) {
    throw createHttpError(403, 'Droits insuffisants. Aucun rattachement actif à ce point n’a été trouvé.')
  }

  const changes = validateUsageNameChange(req.body)
  const point = await updatePointPrelevement(req.point.id, changes, {user: req.user})
  const decoratedPoint = await decoratePointPrelevement(point, {user: req.user})

  stageAuditMutation(req, {
    operation: 'UPDATE',
    entityType: 'POINT',
    entityId: point.id,
    entityLabel: point.usageName || point.name,
    before: req.point,
    after: point
  })

  res.send(decoratedPoint)
}

// Suppression d'un point de prélèvement
export async function deletePointPrelevementHandler(req, res) {
  const deletedPoint = await deletePointPrelevement(req.point.id)

  if (!deletedPoint) {
    throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
  }

  stageAuditMutation(req, {
    operation: 'DELETE',
    entityType: 'POINT',
    entityId: req.point.id,
    entityLabel: req.point.usageName || req.point.name,
    before: req.point
  })

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
