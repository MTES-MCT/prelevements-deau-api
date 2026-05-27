import createHttpError from 'http-errors'

import {prisma} from '../../db/prisma.js'

export async function markAccountCreationMailSent(userId, {role} = {}) {
  const user = await prisma.user.findFirst({
    where: {
      id: userId,
      deletedAt: null,
      ...(role ? {role} : {})
    },
    select: {
      id: true
    }
  })

  if (!user) {
    throw createHttpError(404, 'Cet utilisateur est introuvable.')
  }

  return prisma.user.update({
    where: {
      id: userId
    },
    data: {
      accountCreationMailSentAt: new Date()
    },
    include: {
      declarant: true,
      instructor: true
    }
  })
}

export async function markZoneAttachmentMailSent({instructorUserId, zoneId}) {
  const right = await prisma.instructorZone.findUnique({
    where: {
      instructorUserId_zoneId: {
        instructorUserId,
        zoneId
      }
    },
    select: {
      id: true
    }
  })

  if (!right) {
    throw createHttpError(404, 'Ce rattachement à la zone est introuvable.')
  }

  return prisma.instructorZone.update({
    where: {
      id: right.id
    },
    data: {
      zoneAttachmentMailSentAt: new Date()
    },
    include: {
      zone: true,
      instructor: {
        include: {
          user: true
        }
      }
    }
  })
}
