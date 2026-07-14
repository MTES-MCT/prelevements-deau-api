import createHttpError from 'http-errors'

import {prisma} from '../../db/prisma.js'
import {
  ZONE_PERMISSION_CODES,
  ZONE_PERMISSION_CODE_SET,
  getMissingPermissionDependencies,
  sortZonePermissions
} from '../constants/zone-permissions.js'
import {activeWindowWhere} from '../models/point-prelevement.js'

function assertKnownPermission(permission) {
  if (!ZONE_PERMISSION_CODE_SET.has(permission)) {
    throw new Error(`Droit de zone inconnu : ${permission}`)
  }
}

export function activeInstructorZoneWhere(instructorUserId, {
  now = new Date(),
  permission
} = {}) {
  if (permission) {
    assertKnownPermission(permission)
  }

  return {
    instructorUserId,
    ...activeWindowWhere(now, {
      startNullable: false,
      endNullable: true
    }),
    ...(permission
      ? {
        permissions: {
          some: {permission}
        }
      }
      : {})
  }
}

export function validateZonePermissions(permissions) {
  if (!Array.isArray(permissions) || permissions.length === 0) {
    throw createHttpError(400, 'Sélectionnez au moins un droit pour cet agent.')
  }

  const unknown = [...new Set(permissions)].filter(permission => !ZONE_PERMISSION_CODE_SET.has(permission))
  if (unknown.length > 0) {
    throw createHttpError(400, `Droits inconnus : ${unknown.join(', ')}.`)
  }

  const normalized = sortZonePermissions(permissions)
  const missingDependencies = getMissingPermissionDependencies(normalized)

  if (missingDependencies.length > 0) {
    const details = missingDependencies
      .map(({permission, requires}) => `${permission} requiert ${requires}`)
      .join(', ')

    throw createHttpError(400, `Dépendances de droits manquantes : ${details}.`)
  }

  return normalized
}

export async function getPermissionZoneIdsForUser(user, permission, {
  client = prisma,
  now = new Date(),
  zoneIds
} = {}) {
  assertKnownPermission(permission)

  if (!user) {
    return []
  }

  const zoneIdFilter = zoneIds?.length ? {id: {in: [...new Set(zoneIds)]}} : {}

  if (user.role === 'ADMIN') {
    const zones = await client.zone.findMany({
      where: zoneIdFilter,
      select: {id: true}
    })

    return zones.map(zone => zone.id)
  }

  if (user.role !== 'INSTRUCTOR') {
    return []
  }

  const rights = await client.instructorZone.findMany({
    where: {
      ...activeInstructorZoneWhere(user.id, {now, permission}),
      ...(zoneIds?.length ? {zoneId: {in: [...new Set(zoneIds)]}} : {})
    },
    select: {zoneId: true},
    distinct: ['zoneId']
  })

  return rights.map(right => right.zoneId)
}

export async function hasZonePermission(user, permission, zoneIds, options = {}) {
  if (!Array.isArray(zoneIds) || zoneIds.length === 0) {
    return false
  }

  const permittedZoneIds = await getPermissionZoneIdsForUser(user, permission, {
    ...options,
    zoneIds
  })

  return permittedZoneIds.length > 0
}

export async function hasAnyZonePermission(user, permission, options = {}) {
  const zoneIds = await getPermissionZoneIdsForUser(user, permission, options)
  return zoneIds.length > 0
}

export async function getActiveZoneAssignmentsForUser(user, {
  client = prisma,
  now = new Date()
} = {}) {
  if (!user) {
    return []
  }

  if (user.role === 'ADMIN') {
    const zones = await client.zone.findMany({
      select: {
        id: true,
        code: true,
        name: true,
        type: true
      },
      orderBy: {name: 'asc'}
    })

    return zones.map(zone => ({
      id: null,
      zoneId: zone.id,
      zone,
      startDate: null,
      endDate: null,
      permissions: [...ZONE_PERMISSION_CODES]
    }))
  }

  if (user.role !== 'INSTRUCTOR') {
    return []
  }

  const assignments = await client.instructorZone.findMany({
    where: activeInstructorZoneWhere(user.id, {now}),
    select: {
      id: true,
      zoneId: true,
      startDate: true,
      endDate: true,
      zone: {
        select: {
          id: true,
          code: true,
          name: true,
          type: true
        }
      },
      permissions: {
        select: {permission: true}
      }
    },
    orderBy: {createdAt: 'asc'}
  })

  return assignments.map(assignment => ({
    ...assignment,
    permissions: sortZonePermissions(
      assignment.permissions.map(item => item.permission)
    )
  }))
}

export async function getActivePermissionCodesForUser(user, options = {}) {
  if (user?.role === 'ADMIN') {
    return [...ZONE_PERMISSION_CODES]
  }

  const assignments = await getActiveZoneAssignmentsForUser(user, options)
  return sortZonePermissions(assignments.flatMap(assignment => assignment.permissions))
}

export async function getPermissionCodesForUserInZones(user, zoneIds, {
  client = prisma,
  now = new Date()
} = {}) {
  if (!user || !Array.isArray(zoneIds) || zoneIds.length === 0) {
    return []
  }

  if (user.role === 'ADMIN') {
    return [...ZONE_PERMISSION_CODES]
  }

  if (user.role !== 'INSTRUCTOR') {
    return []
  }

  const assignments = await client.instructorZone.findMany({
    where: {
      ...activeInstructorZoneWhere(user.id, {now}),
      zoneId: {in: [...new Set(zoneIds)]}
    },
    select: {
      permissions: {select: {permission: true}}
    }
  })

  return sortZonePermissions(
    assignments.flatMap(assignment => assignment.permissions.map(item => item.permission))
  )
}

export async function getPointZoneIds(pointPrelevementId, {client = prisma} = {}) {
  if (!pointPrelevementId) {
    return []
  }

  const rows = await client.pointPrelevementZone.findMany({
    where: {pointPrelevementId},
    select: {zoneId: true}
  })

  return rows.map(row => row.zoneId)
}

export async function getExploitationZoneIds(exploitationId, {client = prisma} = {}) {
  if (!exploitationId) {
    return []
  }

  const exploitation = await client.declarantPointPrelevement.findUnique({
    where: {id: exploitationId},
    select: {pointPrelevementId: true}
  })

  return exploitation
    ? getPointZoneIds(exploitation.pointPrelevementId, {client})
    : []
}

export async function getDeclarantZoneIds(declarantUserId, {client = prisma} = {}) {
  if (!declarantUserId) {
    return []
  }

  const rows = await client.declarantZone.findMany({
    where: {declarantUserId},
    select: {zoneId: true}
  })

  return rows.map(row => row.zoneId)
}

export async function getSourceZoneIds(sourceId, {client = prisma} = {}) {
  if (!sourceId) {
    return []
  }

  const source = await client.source.findUnique({
    where: {id: sourceId},
    select: {
      declaration: {
        select: {
          declarantUserId: true,
          createdByDeclarantUserId: true
        }
      },
      chunks: {
        where: {pointPrelevementId: {not: null}},
        select: {pointPrelevementId: true}
      }
    }
  })

  if (!source) {
    return []
  }

  const pointIds = [...new Set(source.chunks.map(chunk => chunk.pointPrelevementId).filter(Boolean))]
  const declarantIds = [...new Set([
    source.declaration?.declarantUserId,
    source.declaration?.createdByDeclarantUserId
  ].filter(Boolean))]

  const [pointZones, declarantZones] = await Promise.all([
    pointIds.length === 0
      ? []
      : client.pointPrelevementZone.findMany({
        where: {pointPrelevementId: {in: pointIds}},
        select: {zoneId: true}
      }),
    declarantIds.length === 0
      ? []
      : client.declarantZone.findMany({
        where: {declarantUserId: {in: declarantIds}},
        select: {zoneId: true}
      })
  ])

  return [...new Set([
    ...pointZones.map(row => row.zoneId),
    ...declarantZones.map(row => row.zoneId)
  ])]
}

export async function getChunkZoneIds(chunkId, {client = prisma} = {}) {
  if (!chunkId) {
    return []
  }

  const chunk = await client.chunk.findUnique({
    where: {id: chunkId},
    select: {
      pointPrelevementId: true,
      sourceId: true
    }
  })

  if (!chunk) {
    return []
  }

  if (chunk.pointPrelevementId) {
    const zoneIds = await getPointZoneIds(chunk.pointPrelevementId, {client})
    if (zoneIds.length > 0) {
      return zoneIds
    }
  }

  return getSourceZoneIds(chunk.sourceId, {client})
}

export async function upsertDeclarantZones({
  declarantUserIds,
  zoneIds,
  source,
  createdByUserId = null,
  client = prisma
}) {
  const uniqueDeclarantIds = [...new Set(declarantUserIds.filter(Boolean))]
  const uniqueZoneIds = [...new Set(zoneIds.filter(Boolean))]

  if (uniqueDeclarantIds.length === 0 || uniqueZoneIds.length === 0) {
    return
  }

  await client.declarantZone.createMany({
    data: uniqueDeclarantIds.flatMap(declarantUserId =>
      uniqueZoneIds.map(zoneId => ({
        declarantUserId,
        zoneId,
        source,
        createdByUserId
      }))),
    skipDuplicates: true
  })
}

export async function syncDeclarantZonesFromPoint({
  declarantUserIds,
  pointPrelevementId,
  source = 'RECONCILIATION',
  createdByUserId = null,
  client = prisma
}) {
  const zoneIds = await getPointZoneIds(pointPrelevementId, {client})
  await upsertDeclarantZones({
    declarantUserIds,
    zoneIds,
    source,
    createdByUserId,
    client
  })
}

export async function replaceInstructorZonePermissions({
  client,
  instructorZone,
  permissions,
  actorUserId,
  action,
  before
}) {
  const normalized = validateZonePermissions(permissions)

  await client.instructorZonePermission.deleteMany({
    where: {instructorZoneId: instructorZone.id}
  })
  await client.instructorZonePermission.createMany({
    data: normalized.map(permission => ({
      instructorZoneId: instructorZone.id,
      permission
    }))
  })
  await client.instructorZonePermissionAudit.create({
    data: {
      instructorZoneId: instructorZone.id,
      zoneId: instructorZone.zoneId,
      instructorUserId: instructorZone.instructorUserId,
      actorUserId,
      action,
      before,
      after: {
        permissions: normalized,
        startDate: instructorZone.startDate,
        endDate: instructorZone.endDate
      }
    }
  })

  return normalized
}

export async function assertCanDelegateZonePermissions(actor, zoneId, permissions, {
  client = prisma,
  now = new Date(),
  managementPermission = 'zone.agent.update'
} = {}) {
  const normalized = validateZonePermissions(permissions)

  if (actor?.role === 'ADMIN') {
    return normalized
  }

  const actorZoneIds = await getPermissionZoneIdsForUser(actor, managementPermission, {
    client,
    now,
    zoneIds: [zoneId]
  })

  if (actorZoneIds.length === 0) {
    throw createHttpError(403, 'Vous ne pouvez pas modifier les droits des agents de cette zone.')
  }

  const actorRight = await client.instructorZone.findFirst({
    where: {
      ...activeInstructorZoneWhere(actor.id, {now}),
      zoneId
    },
    select: {
      zoneId: true,
      permissions: {select: {permission: true}}
    }
  })

  const actorPermissions = new Set(
    actorRight?.zoneId === zoneId
      ? actorRight.permissions.map(item => item.permission)
      : []
  )
  const forbidden = normalized.filter(permission => !actorPermissions.has(permission))

  if (forbidden.length > 0) {
    throw createHttpError(
      403,
      `Vous ne pouvez attribuer que vos propres droits. Droits non délégables : ${forbidden.join(', ')}.`
    )
  }

  return normalized
}
