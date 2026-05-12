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

/**
 * Service layer pour les points de prélèvement.
 * Ne dépend d’aucun référentiel Mongo.
 */

async function assertCanManagePointCoordinates(user, coordinates) {
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

  const instructorZone = await prisma.instructorZone.findFirst({
    where: {
      instructorUserId: user.id,
      isAdmin: true,
      zoneId: {in: zoneIds},
      ...PointModel.activeWindowWhere(new Date(), {
        startNullable: false,
        endNullable: true
      })
    },
    select: {id: true}
  })

  if (!instructorZone) {
    throw createHttpError(
      400,
      'Vous devez être administrateur d’au moins une zone contenant ce point.'
    )
  }
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

  await assertCanManagePointCoordinates(user, point.coordinates)

  return PointModel.insertPointPrelevement(point)
}

/* Mise à jour avec validation + recalcul automatique des zones */

export async function updatePointPrelevement(pointId, payload, {user} = {}) {
  const changes = validateChanges(payload)

  if (Object.keys(changes).length === 0) {
    throw createHttpError(400, 'Aucun champ valide trouvé.')
  }

  if (changes.coordinates) {
    await assertCanManagePointCoordinates(user, changes.coordinates)
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
      usages: chain(pointExploitations).map('usages').flatten().uniq().value()
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
    declarants: pointPrelevement.declarants ?? [],
    preleveurs,
    usages: chain(exploitations).map('usages').flatten().uniq().value()
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
