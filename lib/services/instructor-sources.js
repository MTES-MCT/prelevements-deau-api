import {prisma} from '../../db/prisma.js'
import {activeWindowWhere} from "../models/point-prelevement.js";

export async function getAccessiblePointPrelevementIdsForInstructor(
  instructorUserId,
  now = new Date()
) {
  const activeWindowInstructor = activeWindowWhere(now, {
    startNullable: false,
    endNullable: true
  })

  const pointZones = await prisma.pointPrelevementZone.findMany({
    where: {
      zone: {
        instructorZones: {
          some: {
            instructorUserId,
            ...activeWindowInstructor
          }
        }
      }
    },
    select: {
      pointPrelevementId: true
    },
    distinct: ['pointPrelevementId']
  })

  return pointZones.map(item => item.pointPrelevementId)
}

export async function getAccessiblePointPrelevementIdsSetForInstructor(
  instructorUserId,
  now = new Date()
) {
  const pointIds = await getAccessiblePointPrelevementIdsForInstructor(instructorUserId, now)
  return new Set(pointIds)
}

export async function buildAccessibleSourceWhereForInstructor(
  instructorUserId,
  {now = new Date(), statuses} = {}
) {
  const pointIds = await getAccessiblePointPrelevementIdsForInstructor(instructorUserId, now)

  if (pointIds.length === 0) {
    return {id: '__no_access__'}
  }

  return {
    ...(statuses?.length
      ? {
        globalInstructionStatus: {
          in: statuses
        }
      }
      : {}),
    chunks: {
      some: {
        pointPrelevementId: {
          in: pointIds
        }
      }
    }
  }
}

export async function canInstructorReadSource(instructorUserId, sourceId, now = new Date()) {
  const accessibleSourceWhere = await buildAccessibleSourceWhereForInstructor(instructorUserId, now)

  const source = await prisma.source.findFirst({
    where: {
      id: sourceId,
      ...accessibleSourceWhere
    },
    select: {
      id: true
    }
  })

  return Boolean(source)
}

export async function canInstructorWriteSource(instructorUserId, sourceId, now = new Date()) {
  return canInstructorReadSource(instructorUserId, sourceId, now)
}

export async function getSourceForInstructor(instructorUserId, sourceId, now = new Date()) {
  const pointIdsSet = await getAccessiblePointPrelevementIdsSetForInstructor(instructorUserId, now)
  const pointIds = [...pointIdsSet]

  if (pointIds.length === 0) {
    return null
  }

  const source = await prisma.source.findFirst({
    where: {
      id: sourceId,
      chunks: {
        some: {
          pointPrelevementId: {
            in: pointIds
          }
        }
      }
    },
    include: {
      declaration: {
        include: {
          files: true,
          declarant: {
            include: {
              user: true
            }
          }
        }
      },
      chunks: {
        orderBy: [{minDate: 'asc'}, {createdAt: 'asc'}],
        include: {
          pointPrelevement: true,
          instructedByInstructor: {
            include: {
              user: true
            }
          },
          chunkValues: {
            orderBy: {
              date: 'asc'
            }
          }
        }
      }
    }
  })

  if (!source) {
    return null
  }

  return {
    ...source,
    chunks: source.chunks.map(chunk => ({
      ...chunk,
      canInstruct:
        chunk.pointPrelevementId === null || pointIdsSet.has(chunk.pointPrelevementId)
    }))
  }
}

export async function listSourcesForInstructor(
  instructorUserId,
  {now = new Date(), statuses} = {}
) {
  const accessibleSourceWhere = await buildAccessibleSourceWhereForInstructor(instructorUserId, {
    now,
    statuses
  })

  if (accessibleSourceWhere.id === '__no_access__') {
    return []
  }

  return prisma.source.findMany({
    where: accessibleSourceWhere,
    orderBy: {
      createdAt: 'desc'
    },
    include: {
      declaration: {
        include: {
          files: true,
          declarant: {
            include: {
              user: true
            }
          }
        }
      },
      _count: {
        select: {
          chunks: true
        }
      }
    }
  })
}

export async function getChunkAuthorizationForInstructor(instructorUserId, chunkId, now = new Date()) {
  const pointIdsSet = await getAccessiblePointPrelevementIdsSetForInstructor(instructorUserId, now)
  const pointIds = [...pointIdsSet]

  if (pointIds.length === 0) {
    return null
  }

  const chunk = await prisma.chunk.findUnique({
    where: {id: chunkId},
    select: {
      id: true,
      sourceId: true,
      pointPrelevementId: true
    }
  })

  if (!chunk) {
    return null
  }

  // Une source est visible si elle contient au moins un chunk lié à un point accessible.
  const sourceReadable = await prisma.source.findFirst({
    where: {
      id: chunk.sourceId,
      chunks: {
        some: {
          pointPrelevementId: {
            in: pointIds
          }
        }
      }
    },
    select: {
      id: true
    }
  })

  if (!sourceReadable) {
    return null
  }

  const canInstruct =
    chunk.pointPrelevementId === null || pointIdsSet.has(chunk.pointPrelevementId)

  return {
    chunkId: chunk.id,
    sourceId: chunk.sourceId,
    pointPrelevementId: chunk.pointPrelevementId,
    canRead: true,
    canWrite: canInstruct
  }
}
