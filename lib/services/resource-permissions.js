import {prisma} from '../../db/prisma.js'
import {activeWindowWhere} from '../models/point-prelevement.js'
import {ZONE_PERMISSION_CODES, sortZonePermissions} from '../constants/zone-permissions.js'
import {
  activeInstructorZoneWhere,
  getEffectiveDeclarantZoneIds,
  getEffectiveDeclarantZoneLinks,
  getExploitationZoneIds,
  getPermissionCodesForUserInZones,
  getPointZoneIds,
  hasAnyZonePermission,
  hasZonePermission
} from './zone-permissions.js'

const NO_RIGHT = Object.freeze({
  canRead: false,
  canEdit: false,
  canEditUsageName: false,
  isAdmin: false,
  permissions: []
})

const READ_ONLY = Object.freeze({
  canRead: true,
  canEdit: false,
  canEditUsageName: false,
  isAdmin: false,
  permissions: []
})

const DECLARANT_USAGE_NAME_RIGHT = Object.freeze({
  canRead: true,
  canEdit: false,
  canEditUsageName: true,
  isAdmin: false,
  permissions: []
})

const ADMIN_RIGHT = Object.freeze({
  canRead: true,
  canEdit: true,
  canEditUsageName: false,
  isAdmin: true,
  permissions: [...ZONE_PERMISSION_CODES]
})

function isGlobalAdmin(user) {
  return user?.role === 'ADMIN'
}

function isDeclarant(user) {
  return user?.role === 'DECLARANT'
}

function isInstructor(user) {
  return user?.role === 'INSTRUCTOR'
}

export async function canCreateDeclarant(user, {
  client = prisma,
  zoneIds
} = {}) {
  if (isGlobalAdmin(user)) {
    return true
  }

  if (!isInstructor(user)) {
    return false
  }

  return zoneIds?.length
    ? hasZonePermission(user, 'declarant.create', zoneIds, {client})
    : hasAnyZonePermission(user, 'declarant.create', {client})
}

export async function canEditPointUsageName(user, pointPrelevementId, {
  client = prisma,
  now = new Date()
} = {}) {
  if (!isDeclarant(user) || !pointPrelevementId) {
    return false
  }

  const exploitation = await client.declarantPointPrelevement.findFirst({
    where: {
      pointPrelevementId,
      ...activeWindowWhere(now),
      OR: [
        {declarantUserId: user.id},
        {
          collecteurs: {
            some: {collecteurUserId: user.id}
          }
        }
      ]
    },
    select: {id: true}
  })

  return Boolean(exploitation)
}

function toRight(permissionCodes, {readPermission, editPermission}) {
  if (!permissionCodes || permissionCodes.length === 0) {
    return NO_RIGHT
  }

  const permissions = new Set(permissionCodes)
  const canRead = permissions.has(readPermission)
  const canEdit = permissions.has(editPermission)

  return {
    canRead,
    canEdit,
    canEditUsageName: false,
    isAdmin: false,
    permissions: permissionCodes
  }
}

async function collecteurHasPointAccess(collecteurUserId, pointPrelevementId) {
  const count = await prisma.declarantCollecteurExploitation.count({
    where: {
      collecteurUserId,
      exploitation: {
        pointPrelevementId
      }
    }
  })

  return count > 0
}

async function collecteurHasExploitationAccess(collecteurUserId, exploitationId) {
  const count = await prisma.declarantCollecteurExploitation.count({
    where: {
      collecteurUserId,
      exploitationId
    }
  })

  return count > 0
}

async function collecteurCanReadDeclarant(collecteurUserId, declarantUserId) {
  const count = await prisma.declarantCollecteurExploitation.count({
    where: {
      collecteurUserId,
      exploitation: {
        declarantUserId
      }
    }
  })

  return count > 0
}

export async function getPointPrelevementRight(user, pointPrelevementId) {
  if (!user || !pointPrelevementId) {
    return NO_RIGHT
  }

  if (isGlobalAdmin(user)) {
    return ADMIN_RIGHT
  }

  if (isDeclarant(user)) {
    if (await canEditPointUsageName(user, pointPrelevementId)) {
      return DECLARANT_USAGE_NAME_RIGHT
    }

    const link = await prisma.declarantPointPrelevement.findFirst({
      where: {
        declarantUserId: user.id,
        pointPrelevementId
      },
      select: {id: true}
    })

    if (link) {
      return READ_ONLY
    }

    return await collecteurHasPointAccess(user.id, pointPrelevementId) ? READ_ONLY : NO_RIGHT
  }

  if (!isInstructor(user)) {
    return NO_RIGHT
  }

  const zoneIds = await getPointZoneIds(pointPrelevementId)
  const permissionCodes = await getPermissionCodesForUserInZones(user, zoneIds)

  return toRight(permissionCodes, {
    readPermission: 'pp.detail.read',
    editPermission: 'pp.update'
  })
}

export async function getExploitationRight(user, exploitationId) {
  if (!user || !exploitationId) {
    return NO_RIGHT
  }

  if (isGlobalAdmin(user)) {
    return ADMIN_RIGHT
  }

  const exploitation = await prisma.declarantPointPrelevement.findUnique({
    where: {id: exploitationId},
    select: {
      declarantUserId: true,
      pointPrelevementId: true
    }
  })

  if (!exploitation) {
    return NO_RIGHT
  }

  if (isDeclarant(user)) {
    if (exploitation.declarantUserId === user.id) {
      return READ_ONLY
    }

    return await collecteurHasExploitationAccess(user.id, exploitationId) ? READ_ONLY : NO_RIGHT
  }

  if (!isInstructor(user)) {
    return NO_RIGHT
  }

  const zoneIds = await getExploitationZoneIds(exploitationId)
  const permissionCodes = await getPermissionCodesForUserInZones(user, zoneIds)

  return toRight(permissionCodes, {
    readPermission: 'exploitation.detail.read',
    editPermission: 'exploitation.update'
  })
}

export async function getDeclarantRight(user, declarantUserId, {
  client = prisma,
  now = new Date()
} = {}) {
  if (!user || !declarantUserId) {
    return NO_RIGHT
  }

  if (isGlobalAdmin(user)) {
    return ADMIN_RIGHT
  }

  if (isDeclarant(user)) {
    if (declarantUserId === user.id) {
      return READ_ONLY
    }

    return await collecteurCanReadDeclarant(user.id, declarantUserId) ? READ_ONLY : NO_RIGHT
  }

  if (!isInstructor(user)) {
    return NO_RIGHT
  }

  const zoneIds = await getEffectiveDeclarantZoneIds(declarantUserId, {client})
  const permissionCodes = await getPermissionCodesForUserInZones(user, zoneIds, {
    client,
    now
  })

  return toRight(permissionCodes, {
    readPermission: 'declarant.detail.read',
    editPermission: 'declarant.update'
  })
}

export async function getDeclarantRights(user, declarantUserIds, {
  client = prisma,
  now = new Date()
} = {}) {
  const ids = [...new Set((declarantUserIds ?? []).filter(Boolean))]
  const rights = new Map(ids.map(id => [id, NO_RIGHT]))

  if (!user || ids.length === 0) {
    return rights
  }

  if (isGlobalAdmin(user)) {
    return new Map(ids.map(id => [id, ADMIN_RIGHT]))
  }

  if (isDeclarant(user)) {
    const otherIds = ids.filter(id => id !== user.id)
    const links = otherIds.length === 0
      ? []
      : await client.declarantCollecteurExploitation.findMany({
        where: {
          collecteurUserId: user.id,
          exploitation: {
            declarantUserId: {in: otherIds}
          }
        },
        select: {
          exploitation: {
            select: {declarantUserId: true}
          }
        }
      })
    const readableIds = new Set([
      user.id,
      ...links.map(link => link.exploitation.declarantUserId)
    ])

    for (const id of ids) {
      if (readableIds.has(id)) {
        rights.set(id, READ_ONLY)
      }
    }

    return rights
  }

  if (!isInstructor(user)) {
    return rights
  }

  const declarantZones = await getEffectiveDeclarantZoneLinks({
    client,
    declarantUserIds: ids
  })
  const zoneIds = [...new Set(declarantZones.map(link => link.zoneId))]

  if (zoneIds.length === 0) {
    return rights
  }

  const assignments = await client.instructorZone.findMany({
    where: {
      ...activeInstructorZoneWhere(user.id, {now}),
      zoneId: {in: zoneIds}
    },
    select: {
      zoneId: true,
      permissions: {select: {permission: true}}
    }
  })
  const permissionsByZone = new Map(assignments.map(assignment => [
    assignment.zoneId,
    assignment.permissions.map(item => item.permission)
  ]))
  const zoneIdsByDeclarant = new Map()

  for (const link of declarantZones) {
    if (!zoneIdsByDeclarant.has(link.declarantUserId)) {
      zoneIdsByDeclarant.set(link.declarantUserId, [])
    }

    zoneIdsByDeclarant.get(link.declarantUserId).push(link.zoneId)
  }

  for (const id of ids) {
    const permissionCodes = sortZonePermissions([
      ...new Set(
        (zoneIdsByDeclarant.get(id) ?? [])
          .flatMap(zoneId => permissionsByZone.get(zoneId) ?? [])
      )
    ])

    rights.set(id, toRight(permissionCodes, {
      readPermission: 'declarant.detail.read',
      editPermission: 'declarant.update'
    }))
  }

  return rights
}

export async function decoratePointPrelevementRight(pointPrelevement, user) {
  if (!pointPrelevement) {
    return pointPrelevement
  }

  return {
    ...pointPrelevement,
    right: await getPointPrelevementRight(user, pointPrelevement.id)
  }
}

export async function decorateExploitationRight(exploitation, user) {
  if (!exploitation) {
    return exploitation
  }

  return {
    ...exploitation,
    right: await getExploitationRight(user, exploitation.id)
  }
}

export async function decorateDeclarantRight(declarant, user) {
  if (!declarant) {
    return declarant
  }

  const declarantUserId = declarant.userId || declarant.id

  return {
    ...declarant,
    right: await getDeclarantRight(user, declarantUserId)
  }
}

export async function decorateDeclarantsRights(declarants, user, options = {}) {
  const declarantUserIds = declarants.map(declarant => declarant.userId || declarant.id)
  const rights = await getDeclarantRights(user, declarantUserIds, options)

  return declarants.map(declarant => {
    const declarantUserId = declarant.userId || declarant.id

    return {
      ...declarant,
      right: rights.get(declarantUserId) ?? NO_RIGHT
    }
  })
}
