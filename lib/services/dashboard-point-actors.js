import createHttpError from 'http-errors'

import {prisma} from '../../db/prisma.js'
import {activeWindowWhere} from '../models/point-prelevement.js'

const DASHBOARD_POINT_ACTOR_PERMISSIONS = [
  'zone.dashboard.read',
  'exploitation.list',
  'declarant.list'
]

function getDashboardPointActorAccessSelect(user, now) {
  if (user.role === 'INSTRUCTOR') {
    return {
      id: true,
      deletedAt: true,
      zones: {
        select: {
          zone: {
            select: {
              instructorZones: {
                where: {
                  instructorUserId: user.id,
                  ...activeWindowWhere(now, {
                    startNullable: false,
                    endNullable: true
                  })
                },
                select: {
                  permissions: {
                    select: {permission: true}
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  if (user.role === 'DECLARANT') {
    const isCollecteur = user.declarant?.declarantRole === 'COLLECTEUR'

    return {
      id: true,
      deletedAt: true,
      declarants: {
        where: isCollecteur
          ? {collecteurs: {some: {collecteurUserId: user.id}}}
          : {declarantUserId: user.id},
        select: isCollecteur
          ? {
            collecteurs: {
              where: {collecteurUserId: user.id},
              select: {collecteurUserId: true}
            }
          }
          : {declarantUserId: true}
      }
    }
  }

  return {id: true, deletedAt: true}
}

function getInstructorZonePermissions(zoneLink) {
  return new Set(
    (zoneLink.zone?.instructorZones ?? [])
      .flatMap(assignment => assignment.permissions ?? [])
      .map(({permission}) => permission)
  )
}

export function canReadDashboardPointActors(point, user) {
  if (!point || point.deletedAt || !user) {
    return false
  }

  if (user.role === 'ADMIN') {
    return true
  }

  if (user.role === 'INSTRUCTOR') {
    return (point.zones ?? []).some(zoneLink => {
      const permissions = getInstructorZonePermissions(zoneLink)
      return DASHBOARD_POINT_ACTOR_PERMISSIONS.every(permission => permissions.has(permission))
    })
  }

  if (user.role !== 'DECLARANT') {
    return false
  }

  if (user.declarant?.declarantRole === 'COLLECTEUR') {
    return (point.declarants ?? []).some(exploitation =>
      exploitation.collecteurs?.some(link => link.collecteurUserId === user.id))
  }

  return (point.declarants ?? []).some(exploitation =>
    exploitation.declarantUserId === user.id)
}

function getDashboardPointActorWhere(user) {
  const preleveurWhere = {
    declarant: {
      declarantRole: 'PRELEVEUR',
      user: {deletedAt: null}
    }
  }

  if (user.role !== 'DECLARANT') {
    return preleveurWhere
  }

  if (user.declarant?.declarantRole === 'COLLECTEUR') {
    return {
      ...preleveurWhere,
      collecteurs: {
        some: {collecteurUserId: user.id}
      }
    }
  }

  return {
    ...preleveurWhere,
    declarantUserId: user.id
  }
}

function getDashboardPointCollecteurWhere() {
  return {
    collecteur: {
      declarantRole: 'COLLECTEUR',
      user: {deletedAt: null}
    }
  }
}

const DASHBOARD_ACTOR_SELECT = Object.freeze({
  userId: true,
  socialReason: true,
  user: {
    select: {
      id: true,
      firstName: true,
      lastName: true
    }
  }
})

function getDashboardActorLabel(declarant) {
  return declarant.socialReason
    || [declarant.user?.firstName, declarant.user?.lastName].filter(Boolean).join(' ')
    || 'Non renseigné'
}

function serializeDashboardActors(exploitations, relation) {
  const actors = new Map()

  for (const exploitation of exploitations) {
    const declarants = relation === 'declarant'
      ? [exploitation.declarant]
      : (exploitation.collecteurs ?? []).map(link => link.collecteur)

    for (const declarant of declarants) {
      const id = declarant?.userId ?? declarant?.user?.id
      if (!id || actors.has(id)) {
        continue
      }

      actors.set(id, {id, label: getDashboardActorLabel(declarant)})
    }
  }

  return [...actors.values()].sort((left, right) =>
    left.label.localeCompare(right.label, 'fr', {sensitivity: 'base'})
    || left.id.localeCompare(right.id))
}

export async function getDashboardPointActors(pointId, user, {
  client = prisma,
  now = new Date()
} = {}) {
  const point = await client.pointPrelevement.findUnique({
    where: {id: pointId},
    select: getDashboardPointActorAccessSelect(user, now)
  })

  if (!point || point.deletedAt) {
    throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
  }

  if (!canReadDashboardPointActors(point, user)) {
    throw createHttpError(403, 'Vous ne pouvez pas consulter les acteurs de ce point depuis le tableau de bord.')
  }

  const exploitations = await client.declarantPointPrelevement.findMany({
    where: {
      pointPrelevementId: pointId,
      ...getDashboardPointActorWhere(user)
    },
    select: {
      declarant: {
        select: DASHBOARD_ACTOR_SELECT
      },
      ...(user.role === 'DECLARANT'
        ? {}
        : {
          collecteurs: {
            where: getDashboardPointCollecteurWhere(),
            select: {
              collecteur: {
                select: DASHBOARD_ACTOR_SELECT
              }
            }
          }
        })
    }
  })

  return {
    pointId,
    preleveurs: serializeDashboardActors(exploitations, 'declarant'),
    collecteurs: serializeDashboardActors(exploitations, 'collecteurs')
  }
}
