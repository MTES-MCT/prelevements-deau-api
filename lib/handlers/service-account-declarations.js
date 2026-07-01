import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import createStorageClient from '../util/s3.js'
import {canServiceAccountAccessDeclarant} from '../models/service-account-declarant.js'
import {ingestDeclarationSeries} from '../declaration-importer/importer.js'
import {createLogger} from '../util/logger.js'
import {getDeclarationTypesByCodes} from '../models/declaration-type.js'
import {
  normalizeConflictPolicy,
  CHUNK_VALUE_CONFLICT_POLICIES
} from '../services/chunk-value-conflicts.js'
import {
  markDeclarationProcessingCompleted,
  markDeclarationProcessingFailed,
  markDeclarationProcessingStarted
} from '../services/declaration-processing.js'

const DECLARATIONS_BUCKET = 'declarations'

function getObjectMetadata(metadata) {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
}

function stringifyIngestionError(error) {
  if (typeof error === 'string') {
    return error
  }

  if (!error || typeof error !== 'object') {
    return String(error)
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function formatIngestionError(error) {
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return stringifyIngestionError(error)
  }

  const details = []
  if (typeof error.filename === 'string' && error.filename.trim()) {
    details.push(`Fichier ${error.filename.trim()}`)
  }

  if (typeof error.pointName === 'string' && error.pointName.trim()) {
    details.push(`Point ${error.pointName.trim()}`)
  }

  let message = stringifyIngestionError(error)
  if (typeof error.message === 'string') {
    message = error.message
  }

  if (typeof error.error === 'string') {
    message = error.error
  }

  if (message.trim()) {
    details.push(message.trim())
  }

  return details.join(' - ')
}

function buildIngestionErrorMessage(errors) {
  const messages = errors.map(formatIngestionError).filter(Boolean)

  if (messages.length === 0) {
    return 'Le traitement automatique n’a pas pu parser les fichiers déposés.'
  }

  const [firstMessage] = messages
  const remainingCount = messages.length - 1

  if (remainingCount === 0) {
    return `Erreur de parsing : ${firstMessage}`
  }

  return `Erreurs de parsing : ${firstMessage} (+${remainingCount} autre${remainingCount > 1 ? 's' : ''})`
}

function hasImportableSeries(data) {
  return Array.isArray(data?.series) && data.series.length > 0
}

async function markDeclarationIngestionFailed({
  declaration,
  errors,
  serviceAccountId
}) {
  const message = buildIngestionErrorMessage(errors)
  let source

  await prisma.$transaction(async tx => {
    const existingSource = await tx.source.findUnique({
      where: {declarationId: declaration.id},
      select: {
        id: true,
        metadata: true
      }
    })

    const metadata = {
      ...(existingSource ? getObjectMetadata(existingSource.metadata) : {}),
      declarationType: declaration.type,
      fileCount: declaration.files.length,
      processingError: message,
      parsingErrors: errors
    }

    source = existingSource
      ? await tx.source.update({
        where: {id: existingSource.id},
        data: {
          type: 'DECLARATION',
          status: 'FAILED',
          globalInstructionStatus: 'TO_INSTRUCT',
          metadata
        }
      })
      : await tx.source.create({
        data: {
          type: 'DECLARATION',
          status: 'FAILED',
          globalInstructionStatus: 'TO_INSTRUCT',
          declarationId: declaration.id,
          metadata
        }
      })

    await markDeclarationProcessingFailed({
      declarationId: declaration.id,
      error: new Error(message),
      metadata: {
        serviceAccountId,
        sourceId: source.id,
        imported: false,
        phase: 'parse-output',
        parsingErrors: errors
      },
      client: tx
    })
  })

  return {
    message,
    source
  }
}

export async function getDeclarationProcessingContextHandler(req, res) {
  if (!req.serviceAccount?.id) {
    throw createHttpError(401, 'Compte de service non authentifié')
  }

  const {declarationId} = req.params

  if (!declarationId) {
    throw createHttpError(400, 'declarationId requis')
  }

  const declaration = await prisma.declaration.findUnique({
    where: {id: declarationId},
    include: {
      files: true
    }
  })

  if (!declaration) {
    throw createHttpError(404, 'Déclaration introuvable')
  }

  const allowed = await canServiceAccountAccessDeclarant(
    req.serviceAccount.id,
    declaration.declarantUserId
  )

  if (!allowed) {
    throw createHttpError(
      403,
      'Ce compte de service ne peut pas traiter cette déclaration'
    )
  }

  await markDeclarationProcessingStarted({
    declarationId: declaration.id,
    metadata: {
      serviceAccountId: req.serviceAccount.id,
      phase: 'processing-context'
    }
  })

  const storage = createStorageClient(DECLARATIONS_BUCKET)

  const declarationTypesByCode = await getDeclarationTypesByCodes([declaration.type])
  const declarationType = declarationTypesByCode.get(declaration.type) ?? null

  const files = await Promise.all(
    declaration.files.map(async file => ({
      id: file.id,
      type: file.type,
      filename: file.filename,
      url: await storage.getPresignedUrl(file.storageKey)
    }))
  )

  const declarant = await prisma.declarant.findUnique({
    where: {
      userId: declaration.declarantUserId
    },
    select: {
      declarantRole: true
    }
  })

  const pointAccessWhere = declarant?.declarantRole === 'COLLECTEUR'
    ? {
      OR: [
        {
          declarants: {
            some: {
              declarantUserId: declaration.declarantUserId
            }
          }
        },
        {
          declarants: {
            some: {
              collecteurs: {
                some: {
                  collecteurUserId: declaration.declarantUserId
                }
              }
            }
          }
        }
      ]
    }
    : {
      declarants: {
        some: {
          declarantUserId: declaration.declarantUserId
        }
      }
    }

  const points = await prisma.pointPrelevement.findMany({
    where: {
      deletedAt: null,
      ...pointAccessWhere
    },
    select: {
      id: true,
      name: true,
      sourceId: true
    },
    orderBy: {
      name: 'asc'
    }
  })

  res.status(200).json({
    success: true,
    data: {
      id: declaration.id,
      type: declaration.type,
      declarationType,
      declarantUserId: declaration.declarantUserId,
      autoValidationEnabled: declaration.autoValidationEnabled,
      files,
      points: points.map(point => ({
        pointId: point.id,
        name: point.name,
        sourceId: point.sourceId || undefined
      }))
    }
  })
}

export async function ingestDeclarationSeriesHandler(req, res) {
  if (!req.serviceAccount?.id) {
    throw createHttpError(401, 'Compte de service non authentifié')
  }

  const {declarationId} = req.params

  if (!declarationId) {
    throw createHttpError(400, 'declarationId requis')
  }

  const declaration = await prisma.declaration.findUnique({
    where: {id: declarationId},
    select: {
      id: true,
      declarantUserId: true,
      type: true,
      files: {
        select: {
          id: true
        }
      }
    }
  })

  if (!declaration) {
    throw createHttpError(404, 'Déclaration introuvable')
  }

  const allowed = await canServiceAccountAccessDeclarant(
    req.serviceAccount.id,
    declaration.declarantUserId
  )

  if (!allowed) {
    throw createHttpError(
      403,
      'Ce compte de service ne peut pas ingérer cette déclaration'
    )
  }

  const {data, errors = []} = req.body
  const ingestionErrors = Array.isArray(errors) ? errors : []

  const requestedConflictPolicy = data?.conflictPolicy
  if (typeof requestedConflictPolicy !== 'string' || requestedConflictPolicy.trim().length === 0) {
    throw createHttpError(
      400,
      `data.conflictPolicy est requis. Valeurs autorisées: ${CHUNK_VALUE_CONFLICT_POLICIES.join(', ')}`
    )
  }

  const normalizedConflictPolicy = normalizeConflictPolicy(requestedConflictPolicy)
  if (normalizedConflictPolicy === null) {
    throw createHttpError(
      400,
      `data.conflictPolicy invalide. Valeurs autorisées: ${CHUNK_VALUE_CONFLICT_POLICIES.join(', ')}`
    )
  }

  let result
  try {
    if (!hasImportableSeries(data)) {
      const failure = await markDeclarationIngestionFailed({
        declaration,
        errors: ingestionErrors,
        serviceAccountId: req.serviceAccount.id
      })

      return res.status(200).json({
        success: true,
        data: {
          sourceId: failure.source.id,
          imported: false,
          error: failure.message
        }
      })
    }

    result = await ingestDeclarationSeries({
      declarationId,
      data: {
        ...data,
        conflictPolicy: normalizedConflictPolicy
      },
      errors: ingestionErrors,
      logger: createLogger()
    })

    await markDeclarationProcessingCompleted({
      declarationId,
      metadata: {
        serviceAccountId: req.serviceAccount.id,
        sourceId: result.sourceId,
        imported: result.imported
      }
    })
  } catch (error) {
    await markDeclarationProcessingFailed({
      declarationId,
      error,
      metadata: {
        serviceAccountId: req.serviceAccount.id,
        phase: 'ingest-series'
      }
    })

    throw error
  }

  res.status(200).json({
    success: true,
    data: result
  })
}
