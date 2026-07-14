import {prisma} from '../../db/prisma.js'
import {activeWindowWhere} from '../models/point-prelevement.js'
import {ZONE_PERMISSION_CODES} from '../constants/zone-permissions.js'
import {
  getDeclarantZoneIds,
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

export async function getDeclarantRight(user, declarantUserId) {
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

  const zoneIds = await getDeclarantZoneIds(declarantUserId)
  const permissionCodes = await getPermissionCodesForUserInZones(user, zoneIds)

  return toRight(permissionCodes, {
    readPermission: 'declarant.detail.read',
    editPermission: 'declarant.update'
  })
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
