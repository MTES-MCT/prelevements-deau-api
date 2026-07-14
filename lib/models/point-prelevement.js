import createHttpError from 'http-errors'
import {randomUUID} from 'node:crypto'
import {prisma} from '../../db/prisma.js'
import {refreshVolumeMetadataForSourceIds} from '../services/volume-totals.js'

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

export async function getCoordsByPointIds(ids) {
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

function computeDeletionCondition(withDeleted) {
  return withDeleted ? {} : {deletedAt: null}
}

const POINT_MAP_SUMMARY_SELECT = Object.freeze({
  id: true,
  name: true,
  usageName: true,
  flowType: true,
  waterBodyType: true,
  zones: {
    select: {zoneId: true}
  },
  declarants: {
    select: {
      usage: {
        select: {
          id: true,
          code: true,
          kind: true,
          label: true,
          color: true
        }
      }
    }
  }
})

async function findPointMapSummaries(where) {
  const points = await prisma.pointPrelevement.findMany({
    where,
    select: POINT_MAP_SUMMARY_SELECT,
    orderBy: {name: 'asc'}
  })

  return decoratePointsWithCoords(points)
}

function splitPointPayload(point) {
  const {coordinates, ...data} = point
  return {data, coordinates}
}

function validateCoordinates(coordinates) {
  if (!coordinates) {
    return null
  }

  if (
    coordinates.type !== 'Point'
    || !Array.isArray(coordinates.coordinates)
    || coordinates.coordinates.length !== 2
  ) {
    throw createHttpError(400, 'Les coordonnées du point sont invalides.')
  }

  const [longitude, latitude] = coordinates.coordinates

  if (
    typeof longitude !== 'number'
    || typeof latitude !== 'number'
    || !Number.isFinite(longitude)
    || !Number.isFinite(latitude)
    || longitude < -180
    || longitude > 180
    || latitude < -90
    || latitude > 90
  ) {
    throw createHttpError(400, 'Les coordonnées du point sont invalides.')
  }

  return {longitude, latitude}
}

function jsonForSql(value, defaultValue) {
  return JSON.stringify(value ?? defaultValue)
}

export async function getZoneIdsForCoordinates(coordinates) {
  const parsedCoordinates = validateCoordinates(coordinates)

  if (!parsedCoordinates) {
    return []
  }

  const {longitude, latitude} = parsedCoordinates

  const zones = await prisma.$queryRaw`
    SELECT id
    FROM "Zone"
    WHERE ST_Intersects(
      coordinates,
      ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)
    )
  `

  return zones.map(zone => zone.id)
}

async function setPointCoordinates(client, pointId, coordinates) {
  const parsedCoordinates = validateCoordinates(coordinates)

  if (!parsedCoordinates) {
    return
  }

  const {longitude, latitude} = parsedCoordinates

  await client.$executeRaw`
    UPDATE "PointPrelevement"
    SET coordinates = ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)
    WHERE id = ${pointId}::uuid
  `
}

async function syncPointExploitationZones(client, pointId, zoneIds) {
  if (zoneIds.length === 0) {
    return
  }

  const exploitations = await client.declarantPointPrelevement.findMany({
    where: {pointPrelevementId: pointId},
    select: {
      declarantUserId: true,
      collecteurs: {select: {collecteurUserId: true}}
    }
  })
  const declarantUserIds = [...new Set(exploitations.flatMap(exploitation => [
    exploitation.declarantUserId,
    ...exploitation.collecteurs.map(link => link.collecteurUserId)
  ]).filter(Boolean))]

  if (declarantUserIds.length === 0) {
    return
  }

  await client.declarantZone.createMany({
    data: declarantUserIds.flatMap(declarantUserId => zoneIds.map(zoneId => ({
      declarantUserId,
      zoneId,
      source: 'EXPLOITATION'
    }))),
    skipDuplicates: true
  })
}

async function refreshPointPrelevementZones(client, pointId) {
  const zones = await client.$queryRaw`
    SELECT z.id
    FROM "Zone" z
    JOIN "PointPrelevement" p
      ON p.id = ${pointId}::uuid
    WHERE ST_Intersects(z.coordinates, p.coordinates)
  `

  await client.pointPrelevementZone.deleteMany({
    where: {
      pointPrelevementId: pointId
    }
  })

  if (zones.length === 0) {
    return []
  }

  await client.pointPrelevementZone.createMany({
    data: zones.map(zone => ({
      pointPrelevementId: pointId,
      zoneId: zone.id
    })),
    skipDuplicates: true
  })

  const zoneIds = zones.map(zone => zone.id)
  await syncPointExploitationZones(client, pointId, zoneIds)

  return zoneIds
}

export async function refreshPointPrelevementZonesById(pointId) {
  return prisma.$transaction(async tx => refreshPointPrelevementZones(tx, pointId))
}

function declarantPointAccessWhere(declarantUserId) {
  const directActiveWhere = {
    declarantUserId,
    ...activeWindowWhere()
  }

  return {
    OR: [
      {
        declarants: {
          some: directActiveWhere
        }
      },
      {
        declarants: {
          some: {
            ...activeWindowWhere(),
            collecteurs: {
              some: {collecteurUserId: declarantUserId}
            }
          }
        }
      }
    ]
  }
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
  const points = await prisma.pointPrelevement.findMany({
    where: {
      ...computeDeletionCondition(includeDeleted)
    },
    include: {
      zones: {
        include: {
          zone: true
        }
      },
      declarants: true
    },
    orderBy: {createdAt: 'desc'}
  })

  return decoratePointsWithCoords(points)
}

export async function getPointsPrelevementByInstructor(zoneIds = []) {
  if (zoneIds.length === 0) {
    return []
  }

  const points = await prisma.pointPrelevement.findMany({
    where: {
      deletedAt: null,
      zones: {
        some: {
          zoneId: {in: zoneIds}
        }
      }
    },
    include: {
      zones: {
        include: {
          zone: true
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

  return points.map(p => ({
    ...p,
    coordinates: coordsById.get(p.id) ?? null
  }))
}

export async function getPointsPrelevementByDeclarant(declarantUserId) {
  const points = await prisma.pointPrelevement.findMany({
    where: {
      deletedAt: null,
      ...declarantPointAccessWhere(declarantUserId)
    },
    include: {
      zones: {include: {zone: true}},
      declarants: true
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
    coordinates: coordsById.get(p.id) ?? null
  }))
}

export function getPointMapSummaries(includeDeleted = false) {
  return findPointMapSummaries(computeDeletionCondition(includeDeleted))
}

export function getPointMapSummariesByInstructor(zoneIds = []) {
  if (zoneIds.length === 0) {
    return []
  }

  return findPointMapSummaries({
    deletedAt: null,
    zones: {
      some: {
        zoneId: {in: zoneIds}
      }
    }
  })
}

export function getPointMapSummariesByDeclarant(declarantUserId) {
  return findPointMapSummaries({
    deletedAt: null,
    ...declarantPointAccessWhere(declarantUserId)
  })
}

export async function getPointsPrelevementOptions(includeDeleted = false) {
  return prisma.pointPrelevement.findMany({
    where: {
      ...computeDeletionCondition(includeDeleted)
    },
    select: {
      id: true,
      name: true,
      usageName: true,
      flowType: true
    },
    orderBy: {
      name: 'asc'
    }
  })
}

export async function getPointsPrelevementOptionsByInstructor(zoneIds = []) {
  if (zoneIds.length === 0) {
    return []
  }

  return prisma.pointPrelevement.findMany({
    where: {
      deletedAt: null,
      zones: {
        some: {
          zoneId: {in: zoneIds}
        }
      }
    },
    select: {
      id: true,
      name: true,
      usageName: true,
      flowType: true
    },
    orderBy: {
      name: 'asc'
    }
  })
}

export async function getPointsPrelevementOptionsByDeclarant(declarantUserId) {
  return prisma.pointPrelevement.findMany({
    where: {
      deletedAt: null,
      ...declarantPointAccessWhere(declarantUserId)
    },
    select: {
      id: true,
      name: true,
      usageName: true,
      flowType: true
    },
    orderBy: {
      name: 'asc'
    }
  })
}

export async function getPointsPrelevementByIds(pointIds, includeDeleted = false) {
  return prisma.pointPrelevement.findMany({
    where: {
      id: {in: pointIds},
      ...computeDeletionCondition(includeDeleted)
    },
    include: {
      declarants: true
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

export async function insertPointPrelevement(point) {
  const id = randomUUID()
  const {data, coordinates} = splitPointPayload(point)
  const parsedCoordinates = validateCoordinates(coordinates)

  if (!parsedCoordinates) {
    throw createHttpError(400, 'Les coordonnées du point sont obligatoires.')
  }

  const {longitude, latitude} = parsedCoordinates
  const serializedNames = jsonForSql(data.names, [])
  const serializedIdentifiers = jsonForSql(data.identifiers, {})

  await prisma.$transaction(async tx => {
    await tx.$executeRaw`
      INSERT INTO "PointPrelevement" (
        id,
        "createdAt",
        "updatedAt",
        name,
        "waterBodyType",
        "flowType",
        nature,
        "withdrawalType",
        coordinates,
        "sourceId",
        "codeEUMasseDEau",
        "codePTP",
        "codeOPR",
        "codeBDLISA",
        "codeBSS",
        "codeAIOT",
        "codeBDCarthage",
        "codeBDTopage",
        "codeSISPEA",
        "codeBNPE",
        "codeMESO",
        "codeMEContinentalesBV",
        "codeSISEAUX",
        "codeINSEE",
        "codeROE",
        "otherNames",
        names,
        identifiers,
        depth,
        "isZre",
        "isBiologicalReservoir",
        "streamName",
        "locationDescription",
        "geometryPrecision",
        comment,
        "internalComment",
        "communeCode",
        "communeName",
        watershed,
        "underWatershed",
        "resourceName",
        "managementUnit",
        "managementSubUnit",
        "aquiferName"
      )
      VALUES (
        ${id}::uuid,
        now(),
        now(),
        ${data.name},
        CAST(${data.waterBodyType ?? null} AS "WaterBodyType"),
        CAST(${data.flowType} AS "PointFlowType"),
        CAST(${data.nature ?? null} AS "PointPrelevementNature"),
        CAST(${data.withdrawalType ?? null} AS "PrelevementType"),
        ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326),
        ${data.sourceId ?? null},
        ${data.codeEUMasseDEau ?? null},
        ${data.codePTP ?? null},
        ${data.codeOPR ?? null},
        ${data.codeBDLISA ?? null},
        ${data.codeBSS ?? null},
        ${data.codeAIOT ?? null},
        ${data.codeBDCarthage ?? null},
        ${data.codeBDTopage ?? null},
        ${data.codeSISPEA ?? null},
        ${data.codeBNPE ?? null},
        ${data.codeMESO ?? null},
        ${data.codeMEContinentalesBV ?? null},
        ${data.codeSISEAUX ?? null},
        ${data.codeINSEE ?? null},
        ${data.codeROE ?? null},
        ${data.otherNames ?? null},
        ${serializedNames}::json,
        ${serializedIdentifiers}::json,
        ${data.depth ?? null},
        ${data.isZre ?? false},
        ${data.isBiologicalReservoir ?? false},
        ${data.streamName ?? null},
        ${data.locationDescription ?? null},
        ${data.geometryPrecision ?? null},
        ${data.comment ?? null},
        ${data.internalComment ?? null},
        ${data.communeCode ?? null},
        ${data.communeName ?? null},
        ${data.watershed ?? null},
        ${data.underWatershed ?? null},
        ${data.resourceName ?? null},
        ${data.managementUnit ?? null},
        ${data.managementSubUnit ?? null},
        ${data.aquiferName ?? null}
      )
    `

    await refreshPointPrelevementZones(tx, id)
  })

  return getPointPrelevement(id)
}

export async function updatePointPrelevementById(pointId, changes) {
  if (!changes || typeof changes !== 'object') {
    throw createHttpError(400, 'Les modifications doivent être un objet.')
  }

  const {data, coordinates} = splitPointPayload(changes)

  await prisma.$transaction(async tx => {
    const existing = await tx.pointPrelevement.findFirst({
      where: {id: pointId, deletedAt: null},
      select: {id: true, flowType: true}
    })

    if (!existing) {
      throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
    }

    if (Object.keys(data).length > 0) {
      await tx.pointPrelevement.update({
        where: {id: pointId},
        data
      })
    }

    if (data.flowType && data.flowType !== existing.flowType) {
      const sourceIds = await tx.chunk.findMany({
        where: {pointPrelevementId: pointId},
        distinct: ['sourceId'],
        select: {sourceId: true}
      })

      await tx.chunk.updateMany({
        where: {pointPrelevementId: pointId},
        data: {flowType: data.flowType}
      })

      await refreshVolumeMetadataForSourceIds(
        sourceIds.map(source => source.sourceId),
        tx
      )
    }

    if (coordinates) {
      await setPointCoordinates(tx, pointId, coordinates)
    }

    await refreshPointPrelevementZones(tx, pointId)
  })

  return getPointPrelevement(pointId)
}

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
