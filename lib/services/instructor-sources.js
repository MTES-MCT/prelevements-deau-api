import {prisma} from '../../db/prisma.js'
import {activeWindowWhere} from '../models/point-prelevement.js'
import createStorageClient from '../util/s3.js'
import {DECLARATIONS_BUCKET} from '../handlers/declarations.js'
import {decorateDeclarationsWithDeclarationTypes} from '../models/declaration-type.js'

function sourceStatusWhere(statuses) {
  return statuses?.length
    ? {
      globalInstructionStatus: {
        in: statuses
      }
    }
    : {}
}

function sourceTypeWhere(types) {
  if (types === undefined) {
    return {}
  }

  if (types.length === 0) {
    return {id: {in: []}}
  }

  const declarationDataSourceTypes = types.filter(type => type !== 'API')
  const or = []

  if (declarationDataSourceTypes.length > 0) {
    or.push({
      declaration: {
        is: {
          dataSourceType: {
            in: declarationDataSourceTypes
          }
        }
      }
    })
  }

  if (types.includes('API')) {
    or.push({
      OR: [
        {type: 'API'},
        {
          declaration: {
            is: {
              dataSourceType: 'API'
            }
          }
        }
      ]
    })
  }

  return or.length > 0 ? {OR: or} : {}
}

function visibleSourceWhere() {
  return {
    NOT: {
      type: 'API',
      status: 'COMPLETED',
      chunks: {
        none: {}
      }
    }
  }
}

function getSourceListInclude() {
  return {
    declaration: {
      include: {
        files: true,
        declarant: {
          include: {
            user: true
          }
        },
        createdByDeclarant: {
          include: {
            user: true
          }
        }
      }
    },
    chunks: {
      include: {
        _count: {
          select: {
            chunkValues: true
          }
        },
        pointPrelevement: {
          include: {
            declarants: {
              include: {
                declarant: {
                  include: {
                    user: true
                  }
                }
              }
            }
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
}

function getPointPrelevementWithDeclarantsInclude() {
  return {
    include: {
      declarants: {
        include: {
          declarant: {
            include: {
              user: true
            }
          }
        }
      }
    }
  }
}

function chunkPeriodWhere({startDate, endDate} = {}) {
  return {
    ...(startDate ? {maxDate: {gte: startDate}} : {}),
    ...(endDate ? {minDate: {lte: endDate}} : {})
  }
}

function sourceChunkWhere({pointIds, startDate, endDate} = {}) {
  const chunkWhere = {
    ...(pointIds ? {pointPrelevementId: {in: pointIds}} : {}),
    ...chunkPeriodWhere({startDate, endDate})
  }

  return Object.keys(chunkWhere).length > 0
    ? {
      chunks: {
        some: chunkWhere
      }
    }
    : {}
}

function pointsToAssociateWhere(pointsToAssociate) {
  return pointsToAssociate
    ? {
      chunks: {
        some: {
          pointPrelevementId: null
        }
      }
    }
    : {}
}

function andWhere(conditions) {
  const filteredConditions = conditions.filter(condition => Object.keys(condition).length > 0)
  return filteredConditions.length > 0 ? {AND: filteredConditions} : {}
}

function declarationSearchWhere({declarant, dossierNumber} = {}) {
  const where = {}

  if (dossierNumber) {
    where.code = {
      contains: dossierNumber,
      mode: 'insensitive'
    }
  }

  if (declarant) {
    where.declarant = {
      OR: [
        {socialReason: {contains: declarant, mode: 'insensitive'}},
        {siret: {contains: declarant, mode: 'insensitive'}},
        {
          user: {
            OR: [
              {firstName: {contains: declarant, mode: 'insensitive'}},
              {lastName: {contains: declarant, mode: 'insensitive'}},
              {email: {contains: declarant, mode: 'insensitive'}}
            ]
          }
        }
      ]
    }
  }

  return Object.keys(where).length > 0
    ? {declaration: {is: where}}
    : {}
}

function paginatedSourcesPayload({items, page, pageSize, total}) {
  return {
    items,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize))
    }
  }
}

async function decorateSourcesWithDeclarationTypes(sources) {
  const declarationsWithTypes = await decorateDeclarationsWithDeclarationTypes(
    sources.map(source => source.declaration).filter(Boolean)
  )

  const declarationsWithTypesById = new Map(
    declarationsWithTypes.map(declaration => [declaration.id, declaration])
  )

  return sources.map(source => ({
    ...source,
    declaration: source.declaration
      ? declarationsWithTypesById.get(source.declaration.id) ?? source.declaration
      : source.declaration
  }))
}

async function decorateSourceDetail(source, canInstructChunk) {
  if (!source) {
    return null
  }

  const storage = createStorageClient(DECLARATIONS_BUCKET)

  if (source.declaration) {
    source.declaration.files = await Promise.all(
      source.declaration.files.map(async file => ({
        ...file,
        url: await storage.getPresignedUrl(file.storageKey)
      }))
    )

    const [declarationWithType] = await decorateDeclarationsWithDeclarationTypes([source.declaration])
    source.declaration = declarationWithType
  }

  const conflictsByChunkId = await getValidatedChunkConflictsForChunks(source.chunks)

  return {
    ...source,
    chunks: source.chunks.map(chunk => ({
      ...chunk,
      canInstruct: canInstructChunk(chunk),
      validationConflicts: conflictsByChunkId[chunk.id] ?? [],
      hasValidationConflicts: (conflictsByChunkId[chunk.id] ?? []).length > 0
    }))
  }
}

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
    ...sourceStatusWhere(statuses),
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
  {
    declarant,
    dossierNumber,
    endDate,
    now = new Date(),
    page = 1,
    pageSize = 25,
    pointsToAssociate,
    startDate,
    statuses,
    types
  } = {}
) {
  const pointIds = await getAccessiblePointPrelevementIdsForInstructor(instructorUserId, now)

  if (pointIds.length === 0) {
    return paginatedSourcesPayload({items: [], page, pageSize, total: 0})
  }

  const where = {
    ...sourceStatusWhere(statuses),
    ...sourceTypeWhere(types),
    ...declarationSearchWhere({declarant, dossierNumber}),
    ...andWhere([
      sourceChunkWhere({pointIds, startDate, endDate}),
      pointsToAssociateWhere(pointsToAssociate)
    ])
  }

  const [total, sources] = await Promise.all([
    prisma.source.count({where}),
    prisma.source.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: {
        createdAt: 'desc'
      },
      include: getSourceListInclude()
    })
  ])

  return paginatedSourcesPayload({
    items: await decorateSourcesWithDeclarationTypes(sources),
    page,
    pageSize,
    total
  })
}

export async function listSourcesForAdmin({
  declarant,
  dossierNumber,
  endDate,
  page = 1,
  pageSize = 25,
  pointsToAssociate,
  startDate,
  statuses,
  types
} = {}) {
  const where = {
    ...sourceStatusWhere(statuses),
    ...sourceTypeWhere(types),
    ...declarationSearchWhere({declarant, dossierNumber}),
    ...visibleSourceWhere(),
    ...andWhere([
      sourceChunkWhere({startDate, endDate}),
      pointsToAssociateWhere(pointsToAssociate)
    ])
  }

  const [total, sources] = await Promise.all([
    prisma.source.count({where}),
    prisma.source.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: {
        createdAt: 'desc'
      },
      include: getSourceListInclude()
    })
  ])

  return paginatedSourcesPayload({
    items: await decorateSourcesWithDeclarationTypes(sources),
    page,
    pageSize,
    total
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
 * - le même préleveur métier
 * - un chevauchement de dates
 *
 * Le chunk lui-même est exclu de ses propres conflits.
 */
function getChunkPreleveurConflictKey(chunk) {
  return chunk.preleveurUserId ?? chunk.source?.declaration?.declarantUserId ?? null
}

export async function getValidatedChunkConflictsForChunks(chunks, db = prisma) {
  const candidateChunks = chunks.filter(
    chunk =>
      chunk.pointPrelevementId
      && chunk.minDate
      && chunk.maxDate
      && getChunkPreleveurConflictKey(chunk)
  )

  const conflictsByChunkId = Object.fromEntries(chunks.map(chunk => [chunk.id, []]))

  if (candidateChunks.length === 0) {
    return conflictsByChunkId
  }

  const pointIds = [...new Set(candidateChunks.map(chunk => chunk.pointPrelevementId))]
  const preleveurUserIds = [
    ...new Set(candidateChunks.map(getChunkPreleveurConflictKey))
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
      OR: [
        {
          preleveurUserId: {
            in: preleveurUserIds
          }
        },
        {
          preleveurUserId: null,
          source: {
            declaration: {
              declarantUserId: {
                in: preleveurUserIds
              }
            }
          }
        }
      ]
    },
    select: {
      id: true,
      sourceId: true,
      pointPrelevementId: true,
      preleveurUserId: true,
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
    const chunkPreleveurUserId = getChunkPreleveurConflictKey(chunk)

    const conflicts = validatedChunks
      .filter(validatedChunk => {
        if (validatedChunk.id === chunk.id) {
          return false
        }

        if (validatedChunk.pointPrelevementId !== chunk.pointPrelevementId) {
          return false
        }

        if (getChunkPreleveurConflictKey(validatedChunk) !== chunkPreleveurUserId) {
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
        declarantUserId: getChunkPreleveurConflictKey(conflict),
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
          },
          createdByDeclarant: {
            include: {
              user: true
            }
          }
        }
      },
      chunks: {
        orderBy: [{minDate: 'asc'}, {createdAt: 'asc'}],
        include: {
          pointPrelevement: getPointPrelevementWithDeclarantsInclude(),
          preleveur: {
            include: {
              user: true
            }
          },
          usage: true,
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
              periodEnd: 'asc'
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

  return decorateSourceDetail(
    source,
    chunk => chunk.pointPrelevementId === null || pointIdsSet.has(chunk.pointPrelevementId)
  )
}

export async function getSourceForAdmin(sourceId) {
  const source = await prisma.source.findFirst({
    where: {
      id: sourceId,
      ...visibleSourceWhere()
    },
    include: {
      declaration: {
        include: {
          files: true,
          declarant: {
            include: {
              user: true
            }
          },
          createdByDeclarant: {
            include: {
              user: true
            }
          }
        }
      },
      chunks: {
        orderBy: [{minDate: 'asc'}, {createdAt: 'asc'}],
        include: {
          pointPrelevement: getPointPrelevementWithDeclarantsInclude(),
          preleveur: {
            include: {
              user: true
            }
          },
          usage: true,
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
              periodEnd: 'asc'
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

  return decorateSourceDetail(source, () => true)
}
