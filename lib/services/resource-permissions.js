import {prisma} from '../../db/prisma.js'
import {activeWindowWhere} from '../models/point-prelevement.js'

const NO_RIGHT = Object.freeze({
  canRead: false,
  canEdit: false,
  isAdmin: false
})

const READ_ONLY = Object.freeze({
  canRead: true,
  canEdit: false,
  isAdmin: false
})

const ADMIN_RIGHT = Object.freeze({
  canRead: true,
  canEdit: true,
  isAdmin: true
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

function toRight(rows) {
  if (!rows || rows.length === 0) {
    return NO_RIGHT
  }

  const isAdmin = rows.some(row => row.isAdmin)
  return {
    canRead: true,
    canEdit: isAdmin,
    isAdmin
  }
}

async function getInstructorPointRows(userId, pointPrelevementId) {
  const now = new Date()

  return prisma.instructorZone.findMany({
    where: {
      instructorUserId: userId,
      ...activeWindowWhere(now, {startNullable: false, endNullable: true}),
      zone: {
        pointPrelevementZones: {
          some: {pointPrelevementId}
        }
      }
    },
    select: {isAdmin: true}
  })
}

export async function getPointPrelevementRight(user, pointPrelevementId) {
  if (!user || !pointPrelevementId) {
    return NO_RIGHT
  }

  if (isGlobalAdmin(user)) {
    return ADMIN_RIGHT
  }

  if (isDeclarant(user)) {
    const link = await prisma.declarantPointPrelevement.findFirst({
      where: {
        declarantUserId: user.id,
        pointPrelevementId
      },
      select: {id: true}
    })

    return link ? READ_ONLY : NO_RIGHT
  }

  if (!isInstructor(user)) {
    return NO_RIGHT
  }

  return toRight(await getInstructorPointRows(user.id, pointPrelevementId))
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
    return exploitation.declarantUserId === user.id ? READ_ONLY : NO_RIGHT
  }

  if (!isInstructor(user)) {
    return NO_RIGHT
  }

  return toRight(await getInstructorPointRows(user.id, exploitation.pointPrelevementId))
}

export async function getDeclarantRight(user, declarantUserId) {
  if (!user || !declarantUserId) {
    return NO_RIGHT
  }

  if (isGlobalAdmin(user)) {
    return ADMIN_RIGHT
  }

  if (isDeclarant(user)) {
    return declarantUserId === user.id ? READ_ONLY : NO_RIGHT
  }

  if (!isInstructor(user)) {
    return NO_RIGHT
  }

  const now = new Date()
  const rows = await prisma.instructorZone.findMany({
    where: {
      instructorUserId: user.id,
      ...activeWindowWhere(now, {startNullable: false, endNullable: true}),
      zone: {
        pointPrelevementZones: {
          some: {
            pointPrelevement: {
              declarants: {
                some: {declarantUserId}
              }
            }
          }
        }
      }
    },
    select: {isAdmin: true}
  })

  return toRight(rows)
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
