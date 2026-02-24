import createHttpError from 'http-errors'
import {randomUUID} from 'node:crypto'
import {prisma} from '../../db/prisma.js'

export function activeWindowWhere(now = new Date(), {startNullable = true, endNullable = true} = {}) {
  return {
    AND: [
      startNullable
        ? {OR: [{startDate: null}, {startDate: {lte: now}}]}
        : {startDate: {lte: now}},
      endNullable
        ? {OR: [{endDate: null}, {endDate: {gte: now}}]}
        : {endDate: {gte: now}}
    ]
  }
}

// Decorate coordinates helpers

async function getCoordsByPointIds(ids) {
  if (!ids?.length) {
    return new Map()
  }

  const rows = await prisma.$queryRaw`
    SELECT
      id,
      ST_AsGeoJSON(coordinates)::json AS coordinates
    FROM "PointPrelevement"
    WHERE id = ANY(${ids}::uuid[])
  `

  return new Map(rows.map(r => [r.id, r.coordinates]))
}

export async function decoratePointWithCoords(point) {
  if (!point) {
    return null
  }

  const coordsById = await getCoordsByPointIds([point.id])
  return {
    ...point,
    coordinates: coordsById.get(point.id) ?? null
  }
}

async function decoratePointsWithCoords(points) {
  if (!points?.length) {
    return []
  }

  const coordsById = await getCoordsByPointIds(points.map(p => p.id))
  return points.map(p => ({
    ...p,
    coordinates: coordsById.get(p.id) ?? null
  }))
}

export async function getPointPrelevement(pointId) {
  const point = await prisma.pointPrelevement.findUnique({
    where: {id: pointId},
    include: {
      declarants: true
    }
  })

  return decoratePointWithCoords(point)
}

export async function getPointPrelevementByName(pointName) {
  const point = await prisma.pointPrelevement.findUnique({
    where: {name: pointName},
    include: {
      declarants: true
    }
  })

  return decoratePointWithCoords(point)
}

export async function getPointsPrelevement(includeDeleted = false) {
  const points = prisma.pointPrelevement.findMany({
    where: {
      ...computeDeletionCondition(includeDeleted)
    }
  })

  return decoratePointsWithCoords(points)
}

/**
 * Retourne les points visibles par un instructeur + le type de droit associé.
 *
 * Règles appliquées :
 * - points non supprimés (deletedAt = null)
 * - l’instructeur doit avoir un InstructorZone sur AU MOINS une zone du point
 * - le droit doit être "valide" aujourd’hui (startDate <= now, endDate null ou >= now)
 * - on remonte aussi le flag isAdmin (si l’instructeur est admin sur au moins une zone liée au point)
 *
 * @returns Promise<Array<{...PointPrelevement, right: { isAdmin: boolean, zones: Array<{zoneId: string, isAdmin: boolean}>}}>>
 */
export async function getPointsPrelevementByInstructor(instructorId) {
  const now = new Date()

  const instructorZoneActiveWhere = {
    instructorUserId: instructorId,
    ...activeWindowWhere(now, {startNullable: false, endNullable: true})
  }

  const points = await prisma.pointPrelevement.findMany({
    where: {
      deletedAt: null,
      zones: {
        some: {
          zone: {
            instructorZones: {some: instructorZoneActiveWhere}
          }
        }
      }
    },
    include: {
      zones: {
        include: {
          zone: {
            select: {
              id: true,
              instructorZones: {
                where: instructorZoneActiveWhere,
                select: {isAdmin: true, zoneId: true}
              }
            }
          }
        }
      },
      declarants: true
    },
    orderBy: {createdAt: 'desc'}
  })

  const ids = points.map(p => p.id)
  if (ids.length === 0) {
    return []
  }

  const coordsById = await getCoordsByPointIds(ids)

  return points.map(p => {
    const rightsByZone = p.zones.flatMap(pz =>
      (pz.zone?.instructorZones ?? []).map(iz => ({
        zoneId: iz.zoneId,
        isAdmin: iz.isAdmin
      }))
    )

    return {
      ...p,
      coordinates: coordsById.get(p.id) ?? null,
      right: {
        isAdmin: rightsByZone.some(r => r.isAdmin),
        zones: rightsByZone
      }
    }
  })
}

export async function getPointsPrelevementByDeclarant(declarantUserId) {
  const active = activeWindowWhere()

  const declarantLinkActiveWhere = {
    declarantUserId,
    ...active
  }

  const points = await prisma.pointPrelevement.findMany({
    where: {
      deletedAt: null,
      declarants: {
        some: declarantLinkActiveWhere
      }
    },
    include: {
      zones: {include: {zone: true}},
      declarants: {
        where: declarantLinkActiveWhere
      }
    },
    orderBy: {createdAt: 'desc'}
  })

  const ids = points.map(p => p.id)
  if (ids.length === 0) {
    return []
  }

  const coordsById = await getCoordsByPointIds(ids)

  return points.map(p => ({
    ...p,
    coordinates: coordsById.get(p.id) ?? null,
    right: {
      type: p.declarants?.[0]?.type ?? null
    }
  }))
}

export async function getPointsPrelevementByIds(pointIds, includeDeleted = false) {
  return prisma.pointPrelevement.findMany({
    where: {
      id: {in: pointIds},
      ...computeDeletionCondition(includeDeleted)
    }
  })
}

export async function getPointInfoById(pointId) {
  return prisma.pointPrelevement.findUnique({
    where: {id: pointId},
    select: {
      id: true,
      name: true,
      sourceId: true
    }
  })
}

/* Insertion (utilisé par le service) */

export async function insertPointPrelevement(point) {
  const data = {
    id: randomUUID(),
    ...point
  }

  return prisma.pointPrelevement.create({data})
}
/* Mise à jour par ID (utilisé par le service) */

export async function updatePointPrelevementById(pointId, changes) {
  if (!changes || typeof changes !== 'object') {
    throw createHttpError(400, 'Les modifications doivent être un objet.')
  }

  const {count} = await prisma.pointPrelevement.updateMany({
    where: {id: pointId, deletedAt: null},
    data: {
      ...changes
    }
  })

  if (count === 0) {
    throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
  }

  return prisma.pointPrelevement.findUnique({where: {id: pointId}})
}

/* Suppression par ID (utilisé par le service) */

export async function deletePointPrelevementById(pointId) {
  const now = new Date()

  const {count} = await prisma.pointPrelevement.updateMany({
    where: {id: pointId, deletedAt: null},
    data: {
      deletedAt: now
    }
  })

  if (count === 0) {
    return null
  }

  return prisma.pointPrelevement.findUnique({where: {id: pointId}})
}

/* Helpers */

function computeDeletionCondition(withDeleted) {
  return withDeleted ? {} : {deletedAt: null}
}
