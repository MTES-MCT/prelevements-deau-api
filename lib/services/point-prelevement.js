import {chain} from 'lodash-es'
import createHttpError from 'http-errors'

import {prisma} from '../../db/prisma.js'
import * as PointModel from '../models/point-prelevement.js'
import {getDeclarantsByIds} from '../models/declarant.js'
import {getDeclarantExploitations, pointHasActiveExploitation, getExploitationsFromPointId} from '../models/exploitation.js'

// Import de la validation
import {validateCreation, validateChanges} from '../validation/point-validation.js'
import {getCoordsByPointIds} from '../models/point-prelevement.js'
import {decoratePointPrelevementRight} from './resource-permissions.js'
import {serializeWaterUse} from './sandre-water-uses.js'
import {POINT_FLOW_TYPES} from '../constants/point-flow-types.js'
import {hasZonePermission} from './zone-permissions.js'

/**
 * Service layer pour les points de prélèvement.
 * Centralise les règles métier au-dessus des modèles Prisma.
 */

async function assertCanManagePointCoordinates(user, coordinates, permission) {
  if (!user || user.role === 'ADMIN') {
    return
  }

  if (user.role !== 'INSTRUCTOR') {
    throw createHttpError(403, 'Droits insuffisants.')
  }

  const zoneIds = await PointModel.getZoneIdsForCoordinates(coordinates)

  if (zoneIds.length === 0) {
    throw createHttpError(
      400,
      'Aucune zone déclarée ne couvre les coordonnées de ce point.'
    )
  }

  if (!await hasZonePermission(user, permission, zoneIds)) {
    throw createHttpError(
      403,
      'Vous ne disposez pas de ce droit dans les zones contenant ce point.'
    )
  }
}

function aggregateWaterUses(exploitations = []) {
  const byId = new Map()

  for (const exploitation of exploitations) {
    if (exploitation.usage?.id) {
      byId.set(exploitation.usage.id, serializeWaterUse(exploitation.usage))
    }
  }

  return [...byId.values()]
}

export function aggregateCollectors(exploitations = []) {
  const collectorsByUserId = new Map()

  for (const exploitation of exploitations) {
    for (const link of exploitation.collecteurs ?? []) {
      const {collecteur} = link
      const {user: collecteurUser, ...declarant} = collecteur ?? {}
      if (!collecteurUser?.id || collectorsByUserId.has(collecteurUser.id)) {
        continue
      }

      collectorsByUserId.set(collecteurUser.id, {
        ...collecteurUser,
        declarant
      })
    }
  }

  return [...collectorsByUserId.values()]
}

function aggregateMapWaterUses(exploitations = []) {
  const byId = new Map()

  for (const exploitation of exploitations) {
    const {usage} = exploitation
    if (usage?.id) {
      byId.set(usage.id, usage)
    }
  }

  return [...byId.values()]
}

export function serializePointMapSummary(point, {readableDetailZoneIds} = {}) {
  const {declarants = [], zones = [], ...summary} = point
  const canReadDetail = readableDetailZoneIds
    ? zones.some(({zoneId}) => readableDetailZoneIds.has(zoneId))
    : true

  return {
    ...summary,
    canReadDetail,
    usages: aggregateMapWaterUses(declarants)
  }
}

export function serializePointMapSummaries(points = [], options) {
  return points.map(point => serializePointMapSummary(point, options))
}

/* Récupération avec logique métier */

export async function getPointsFromDeclarant(declarantId, includeDeleted = false) {
  const exploitations = await getDeclarantExploitations(declarantId, {
    pointPrelevement: true
  })

  const pointIds = chain(exploitations)
    .map(e => e.pointPrelevement?.id)
    .compact()
    .uniq()
    .value()

  return PointModel.getPointsPrelevementByIds(pointIds, includeDeleted)
}

/* Création avec validation + contrôle admin sur les zones calculées */

export async function createPointPrelevement(payload, {user} = {}) {
  const point = validateCreation(payload)

  await assertCanManagePointCoordinates(user, point.coordinates, 'pp.create')

  return PointModel.insertPointPrelevement(point)
}

/* Mise à jour avec validation + recalcul automatique des zones */

export async function updatePointPrelevement(pointId, payload, {user} = {}) {
  const validatedChanges = validateChanges(payload)
  const {confirmFlowReclassification, ...changes} = validatedChanges

  if (Object.keys(changes).length === 0) {
    throw createHttpError(400, 'Aucun champ valide trouvé.')
  }

  if (changes.coordinates) {
    await assertCanManagePointCoordinates(user, changes.coordinates, 'pp.update')
  }

  if (changes.flowType) {
    const existingPoint = await prisma.pointPrelevement.findFirst({
      where: {id: pointId, deletedAt: null},
      select: {flowType: true}
    })

    if (!existingPoint) {
      throw createHttpError(404, 'Ce point de prélèvement ou de rejet est introuvable.')
    }

    const previousFlowType = existingPoint.flowType ?? POINT_FLOW_TYPES.PRELEVEMENT
    if (changes.flowType !== previousFlowType) {
      const [chunkCount, valueCount] = await Promise.all([
        prisma.chunk.count({where: {pointPrelevementId: pointId}}),
        prisma.chunkValue.count({where: {chunk: {pointPrelevementId: pointId}}})
      ])

      if (valueCount > 0 && !confirmFlowReclassification) {
        const error = createHttpError(
          409,
          'La modification reclassera toutes les mesures historiques de ce point.'
        )
        error.data = {
          reason: 'FLOW_RECLASSIFICATION_CONFIRMATION_REQUIRED',
          previousFlowType,
          nextFlowType: changes.flowType,
          chunkCount,
          valueCount
        }
        throw error
      }
    }
  }

  return PointModel.updatePointPrelevementById(pointId, changes)
}

/* Suppression avec validation métier */

export async function deletePointPrelevement(pointId) {
  if (await pointHasActiveExploitation(pointId)) {
    throw createHttpError(409, 'Ce point a des exploitations actives.')
  }

  return PointModel.deletePointPrelevementById(pointId)
}

/* Décorateur */

export async function decoratePointsPrelevement(points, {user} = {}) {
  if (!points?.length) {
    return []
  }

  const pointIds = points.map(point => point.id)

  const [exploitations, coordsById] = await Promise.all([
    prisma.declarantPointPrelevement.findMany({
      where: {
        pointPrelevementId: {in: pointIds}
      },
      include: {
        usage: true
      }
    }),
    getCoordsByPointIds(pointIds)
  ])

  const declarantUserIds = [
    ...new Set(
      points.flatMap(point => (point.declarants ?? []).map(d => d.declarantUserId))
    )
  ]

  const declarants = declarantUserIds.length > 0
    ? await getDeclarantsByIds(declarantUserIds)
    : []

  const declarantsById = new Map(declarants.map(declarant => [declarant.id, declarant]))
  const exploitationsByPointId = new Map()

  for (const exploitation of exploitations) {
    const list = exploitationsByPointId.get(exploitation.pointPrelevementId) || []
    list.push(exploitation)
    exploitationsByPointId.set(exploitation.pointPrelevementId, list)
  }

  const decoratedPoints = points.map(point => {
    const pointExploitations = exploitationsByPointId.get(point.id) || []
    const pointDeclarants = (point.declarants ?? [])
      .map(d => declarantsById.get(d.declarantUserId))
      .filter(Boolean)

    return {
      ...point,
      coordinates: coordsById.get(point.id) ?? point.coordinates ?? null,
      declarants: point.declarants ?? [],
      preleveurs: pointDeclarants,
      usages: aggregateWaterUses(pointExploitations)
    }
  })

  return Promise.all(
    decoratedPoints.map(point => decoratePointPrelevementRight(point, user))
  )
}

export async function decoratePointPrelevement(pointPrelevement, {user} = {}) {
  if (!pointPrelevement) {
    return null
  }

  const exploitations = await getExploitationsFromPointId(pointPrelevement.id)

  const declarantIds = (pointPrelevement.declarants ?? []).map(d => d.declarantUserId)
  const preleveurs = await getDeclarantsByIds(declarantIds)

  return decoratePointPrelevementRight({
    ...pointPrelevement,
    collecteurs: aggregateCollectors(exploitations),
    declarants: pointPrelevement.declarants ?? [],
    preleveurs,
    usages: aggregateWaterUses(exploitations)
  }, user)
}

/**
 * Récupère les informations d'affichage d'un point.
 * @param {string} pointId - L'ID du point
 * @returns {Promise<{id: string, name: string, sourceId: string | null} | null>}
 */
export async function getPointInfo(pointId) {
  if (!pointId) {
    return null
  }

  const point = await PointModel.getPointInfoById(pointId)
  if (!point) {
    return null
  }

  return {
    ...point,
    name: point.name || `Point ${point.id}`
  }
}
