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
import {searchCorpusCache} from '../services/search-corpus-cache.js'
import {getPermissionZoneIdsForUser} from '../services/zone-permissions.js'
import {withRequestPerformancePhase} from '../util/request-performance.js'
import {validateUsageNameChange} from '../validation/point-validation.js'

const POINT_MAP_DEPENDENCIES = Object.freeze({
  getPermissionZoneIdsForUser,
  getPointMapSummaries,
  getPointMapSummariesByDeclarant,
  getPointMapSummariesByInstructor,
  serializePointMapSummaries
})

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

async function getCachedPointMapContext(req, dependencies) {
  const user = {id: req.user?.id, role: req.userRole}

  switch (req.userRole) {
    case 'ADMIN': {
      return {
        scope: {kind: 'point-map', user, rights: {administrator: true}},
        async loader() {
          const points = await withRequestPerformancePhase(
            'map_load',
            async () => dependencies.getPointMapSummaries()
          )

          return withRequestPerformancePhase(
            'map_serialize',
            () => dependencies.serializePointMapSummaries(points)
          )
        }
      }
    }

    case 'INSTRUCTOR': {
      const [detailZoneIds, declarantZoneIds, exploitationZoneIds]
        = await withRequestPerformancePhase('map_scope', async () => Promise.all([
          dependencies.getPermissionZoneIdsForUser(req.user, 'pp.detail.read'),
          dependencies.getPermissionZoneIdsForUser(req.user, 'declarant.list'),
          dependencies.getPermissionZoneIdsForUser(req.user, 'exploitation.list')
        ]))
      const permittedZoneIds = req.permittedZoneIds ?? []

      return {
        scope: {
          kind: 'point-map',
          user,
          rights: {
            permittedZoneIds,
            detailZoneIds,
            declarantZoneIds,
            exploitationZoneIds
          }
        },
        async loader() {
          const points = await withRequestPerformancePhase(
            'map_load',
            async () => dependencies.getPointMapSummariesByInstructor(permittedZoneIds)
          )

          return withRequestPerformancePhase(
            'map_serialize',
            () => dependencies.serializePointMapSummaries(points, {
              readableDeclarantZoneIds: new Set(declarantZoneIds),
              readableDetailZoneIds: new Set(detailZoneIds),
              readableExploitationZoneIds: new Set(exploitationZoneIds),
              visibleZoneIds: new Set(permittedZoneIds)
            })
          )
        }
      }
    }

    case 'DECLARANT': {
      return {
        scope: {kind: 'point-map', user, rights: {ownAssociations: true}},
        async loader() {
          const points = await withRequestPerformancePhase(
            'map_load',
            async () => dependencies.getPointMapSummariesByDeclarant(req.user.id)
          )

          return withRequestPerformancePhase(
            'map_serialize',
            () => dependencies.serializePointMapSummaries(points)
          )
        }
      }
    }
    // No default
  }

  return {
    scope: {kind: 'point-map', user, rights: {}},
    async loader() {
      return []
    }
  }
}

// Liste cartographique sans les déclarants ni le calcul individuel des droits.
export async function listPointMapSummaries(req, res, {
  cache = searchCorpusCache,
  dependencies = POINT_MAP_DEPENDENCIES
} = {}) {
  if (cache.isEnabled()) {
    const context = await getCachedPointMapContext(req, dependencies)
    const summaries = await cache.getOrLoad({
      ...context,
      phases: {
        hit: 'map_cache_hit',
        load: 'map_cache_load',
        miss: 'map_cache_miss'
      }
    })

    res.send(summaries)
    return
  }

  let points = []
  let readableDetailZoneIds
  let readableDeclarantZoneIds
  let readableExploitationZoneIds
  let visibleZoneIds

  switch (req.userRole) {
    case 'ADMIN': {
      points = await withRequestPerformancePhase(
        'map_load',
        async () => dependencies.getPointMapSummaries()
      )
      break
    }

    case 'INSTRUCTOR': {
      const [mapPoints, detailZoneIds, declarantZoneIds, exploitationZoneIds]
        = await withRequestPerformancePhase('map_load', async () => Promise.all([
          dependencies.getPointMapSummariesByInstructor(req.permittedZoneIds),
          dependencies.getPermissionZoneIdsForUser(req.user, 'pp.detail.read'),
          dependencies.getPermissionZoneIdsForUser(req.user, 'declarant.list'),
          dependencies.getPermissionZoneIdsForUser(req.user, 'exploitation.list')
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
        async () => dependencies.getPointMapSummariesByDeclarant(req.user.id)
      )
      break
    }
    // No default
  }

  res.send(withRequestPerformancePhase(
    'map_serialize',
    () => dependencies.serializePointMapSummaries(points, {
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
