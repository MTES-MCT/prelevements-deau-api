import {prisma} from '../../db/prisma.js'
import {activeWindowWhere} from '../models/point-prelevement.js'
import createStorageClient from '../util/s3.js'
import {DECLARATIONS_BUCKET} from '../handlers/declarations.js'

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
    return null
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
  const accessibleSourceWhere = await buildAccessibleSourceWhereForInstructor(instructorUserId, {now})

  if (!accessibleSourceWhere) {
    return false
  }

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

export async function listSourcesForInstructor(
  instructorUserId,
  {now = new Date(), statuses} = {}
) {
  const accessibleSourceWhere = await buildAccessibleSourceWhereForInstructor(instructorUserId, {
    now,
    statuses
  })

  if (accessibleSourceWhere === null) {
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

  const canInstruct
    = chunk.pointPrelevementId === null || pointIdsSet.has(chunk.pointPrelevementId)

  return {
    chunkId: chunk.id,
    sourceId: chunk.sourceId,
    pointPrelevementId: chunk.pointPrelevementId,
    canRead: true,
    canWrite: canInstruct
  }
}

function rangesOverlap(aMinDate, aMaxDate, bMinDate, bMaxDate) {
  return aMinDate <= bMaxDate && aMaxDate >= bMinDate
}

/**
 * Retourne, pour chaque chunk fourni, la liste des chunks déjà VALIDATED
 * qui ont :
 * - le même pointPrelevementId
 * - le même declarantUserId
 * - un chevauchement de dates
 *
 * Le chunk lui-même est exclu de ses propres conflits.
 */
export async function getValidatedChunkConflictsForChunks(chunks, db = prisma) {
  const candidateChunks = chunks.filter(
    chunk =>
      chunk.pointPrelevementId
      && chunk.minDate
      && chunk.maxDate
      && chunk.source?.declaration?.declarantUserId
  )

  const conflictsByChunkId = Object.fromEntries(chunks.map(chunk => [chunk.id, []]))

  if (candidateChunks.length === 0) {
    return conflictsByChunkId
  }

  const pointIds = [...new Set(candidateChunks.map(chunk => chunk.pointPrelevementId))]
  const declarantUserIds = [
    ...new Set(candidateChunks.map(chunk => chunk.source.declaration.declarantUserId))
  ]

  const globalMinDate = new Date(
    Math.min(...candidateChunks.map(chunk => new Date(chunk.minDate).getTime()))
  )
  const globalMaxDate = new Date(
    Math.max(...candidateChunks.map(chunk => new Date(chunk.maxDate).getTime()))
  )

  const validatedChunks = await db.chunk.findMany({
    where: {
      instructionStatus: 'VALIDATED',
      pointPrelevementId: {
        in: pointIds
      },
      minDate: {
        lte: globalMaxDate
      },
      maxDate: {
        gte: globalMinDate
      },
      source: {
        declaration: {
          declarantUserId: {
            in: declarantUserIds
          }
        }
      }
    },
    select: {
      id: true,
      sourceId: true,
      pointPrelevementId: true,
      minDate: true,
      maxDate: true,
      pointPrelevement: {
        select: {
          id: true,
          name: true
        }
      },
      source: {
        select: {
          declaration: {
            select: {
              declarantUserId: true
            }
          }
        }
      }
    }
  })

  for (const chunk of candidateChunks) {
    const chunkDeclarantUserId = chunk.source.declaration.declarantUserId

    const conflicts = validatedChunks
      .filter(validatedChunk => {
        if (validatedChunk.id === chunk.id) {
          return false
        }

        if (validatedChunk.pointPrelevementId !== chunk.pointPrelevementId) {
          return false
        }

        if (validatedChunk.source.declaration.declarantUserId !== chunkDeclarantUserId) {
          return false
        }

        return rangesOverlap(
          new Date(chunk.minDate),
          new Date(chunk.maxDate),
          new Date(validatedChunk.minDate),
          new Date(validatedChunk.maxDate)
        )
      })
      .map(conflict => ({
        sourceId: conflict.sourceId,
        chunkId: conflict.id,
        pointPrelevementId: conflict.pointPrelevementId,
        declarantUserId: conflict.source.declaration.declarantUserId,
        minDate: conflict.minDate,
        maxDate: conflict.maxDate,
        pointPrelevement: conflict.pointPrelevement
      }))

    conflictsByChunkId[chunk.id] = conflicts
  }

  return conflictsByChunkId
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
              user: {
                select: {
                  lastName: true,
                  firstName: true
                }
              }
            }
          },
          chunkValues: {
            orderBy: {
              date: 'asc'
            }
          },
          source: {
            select: {
              id: true,
              declaration: {
                select: {
                  declarantUserId: true
                }
              }
            }
          }
        }
      }
    }
  })

  if (!source) {
    return null
  }

  const storage = createStorageClient(DECLARATIONS_BUCKET)

  source.declaration.files = await Promise.all(
    source.declaration.files.map(async file => ({
      ...file,
      url: await storage.getPresignedUrl(file.storageKey)
    }))
  )

  const conflictsByChunkId = await getValidatedChunkConflictsForChunks(source.chunks)

  return {
    ...source,
    chunks: source.chunks.map(chunk => ({
      ...chunk,
      canInstruct:
        chunk.pointPrelevementId === null || pointIdsSet.has(chunk.pointPrelevementId),
      validationConflicts: conflictsByChunkId[chunk.id] ?? [],
      hasValidationConflicts: (conflictsByChunkId[chunk.id] ?? []).length > 0
    }))
  }
}
