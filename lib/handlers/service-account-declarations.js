import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import createStorageClient from '../util/s3.js'
import {canServiceAccountImpersonateDeclarant} from '../models/service-account-declarant.js'
import {ingestDeclarationSeries} from '../declaration-importer/importer.js'
import {createLogger} from '../util/logger.js'
import {
  normalizeConflictPolicy,
  CHUNK_VALUE_CONFLICT_POLICIES
} from '../services/chunk-value-conflicts.js'

const DECLARATIONS_BUCKET = 'declarations'

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

  const allowed = await canServiceAccountImpersonateDeclarant(
    req.serviceAccount.id,
    declaration.declarantUserId
  )

  if (!allowed) {
    throw createHttpError(
      403,
      'Ce compte de service ne peut pas traiter cette déclaration'
    )
  }

  const storage = createStorageClient(DECLARATIONS_BUCKET)

  const files = await Promise.all(
    declaration.files.map(async file => ({
      id: file.id,
      type: file.type,
      filename: file.filename,
      url: await storage.getPresignedUrl(file.storageKey)
    }))
  )

  const points = await prisma.pointPrelevement.findMany({
    where: {
      deletedAt: null,
      declarants: {
        some: {
          declarantUserId: declaration.declarantUserId
        }
      }
    },
    select: {
      id: true,
      name: true
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
      declarantUserId: declaration.declarantUserId,
      autoValidationEnabled: declaration.autoValidationEnabled,
      files,
      points: points.map(point => ({
        pointId: point.id,
        name: point.name
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
      declarantUserId: true
    }
  })

  if (!declaration) {
    throw createHttpError(404, 'Déclaration introuvable')
  }

  const allowed = await canServiceAccountImpersonateDeclarant(
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

  const result = await ingestDeclarationSeries({
    declarationId,
    data: {
      ...data,
      conflictPolicy: normalizedConflictPolicy
    },
    errors,
    logger: createLogger()
  })

  res.status(200).json({
    success: true,
    data: result
  })
}
