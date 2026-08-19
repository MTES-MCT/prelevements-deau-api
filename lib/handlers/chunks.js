import Joi from 'joi'
import createHttpError from 'http-errors'

import {prisma} from '../../db/prisma.js'
import {getSourceFlowTypeFromMetadata} from '../constants/point-flow-types.js'
import {
  getSourceForAdmin,
  getSourceForInstructor,
  getValidatedChunkConflictsForChunks
} from '../services/instructor-sources.js'
import {
  getPermissionZoneIdsForUser,
  getSourceZoneIds,
  hasZonePermission,
  syncDeclarantZonesFromPoint
} from '../services/zone-permissions.js'
import {
  AUTOMATIC_POINT_ASSOCIATION_LOCK_REASON,
  buildManualChunkPointAssociationParsingInfo,
  isChunkPointAssociationChangeAllowed
} from '../services/chunk-point-associations.js'
import {refreshSourceDeclarantsLastDeclarationAt} from '../models/declarant.js'

const CHUNK_INSTRUCTION_STATUSES = ['PENDING', 'REJECTED', 'VALIDATED']

const updateChunkInstructionSchema = Joi.object({
  instructionStatus: Joi.string()
    .valid(...CHUNK_INSTRUCTION_STATUSES)
    .required(),
  instructionComment: Joi.string().allow('', null).optional(),
  pointPrelevementId: Joi.string().allow('', null).uuid({version: 'uuidv4'}).optional()
})

function isGlobalAdmin(user) {
  return user?.role === 'ADMIN'
}

async function ensureInstructionActor(tx, user) {
  if (!isGlobalAdmin(user)) {
    return
  }

  await tx.instructor.upsert({
    where: {
      userId: user.id
    },
    update: {},
    create: {
      userId: user.id
    }
  })
}

export function computeGlobalInstructionStatus(chunkStatuses) {
  if (!Array.isArray(chunkStatuses) || chunkStatuses.length === 0) {
    return 'TO_INSTRUCT'
  }

  const total = chunkStatuses.length
  const pendingCount = chunkStatuses.filter(status => status === 'PENDING').length
  const validatedCount = chunkStatuses.filter(status => status === 'VALIDATED').length
  const rejectedCount = chunkStatuses.filter(status => status === 'REJECTED').length

  if (pendingCount === total) {
    return 'TO_INSTRUCT'
  }

  if (validatedCount === total) {
    return 'VALIDATED'
  }

  if (rejectedCount === total) {
    return 'REJECTED'
  }

  if (pendingCount > 0) {
    return 'INSTRUCTION_IN_PROGRESS'
  }

  return 'PARTIALLY_VALIDATED'
}

export function computeGlobalPointMatchingStatus(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return 'TO_INSTRUCT'
  }

  const total = chunks.length
  const matchedCount = chunks.filter(chunk => {
    if (typeof chunk === 'string') {
      return chunk === 'VALIDATED' || chunk === 'AUTOMATICALLY_VALIDATED'
    }

    return Boolean(chunk?.pointPrelevementId)
  }).length

  if (matchedCount === 0) {
    return 'TO_INSTRUCT'
  }

  if (matchedCount === total) {
    return 'VALIDATED'
  }

  return 'INSTRUCTION_IN_PROGRESS'
}

export async function updateChunkInstructionHandler(req, res, next) {
  try {
    if (!req.user) {
      return next(createHttpError(401, 'Non authentifié'))
    }

    const isAdmin = isGlobalAdmin(req.user)

    if (req.user.role !== 'INSTRUCTOR' && !isAdmin) {
      return next(createHttpError(403, 'Droits insuffisants.'))
    }

    const {chunkId} = req.params

    if (!chunkId) {
      return next(createHttpError(404, 'Chunk introuvable'))
    }

    const {error, value} = updateChunkInstructionSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true
    })

    if (error) {
      return next(
        createHttpError(
          400,
          error.details.map(detail => detail.message).join(' ')
        )
      )
    }

    const {instructionStatus, instructionComment} = value
    const hasPointPrelevementIdInPayload = Object.hasOwn(
      value,
      'pointPrelevementId'
    )
    const payloadPointPrelevementId = hasPointPrelevementIdInPayload
      ? value.pointPrelevementId
      : undefined

    const instructorUserId = req.user.id
    const now = new Date()

    const permittedZoneIds = isAdmin
      ? null
      : await getPermissionZoneIdsForUser(req.user, 'declaration.instruct')

    const transactionResult = await prisma.$transaction(async tx => {
      const existingChunk = await tx.chunk.findUnique({
        where: {id: chunkId},
        select: {
          id: true,
          sourceId: true,
          pointPrelevementId: true,
          flowType: true,
          metadata: true,
          parsingInfo: true,
          preleveurUserId: true,
          submittedByDeclarantUserId: true,
          collecteurUserId: true,
          minDate: true,
          maxDate: true,
          source: {
            select: {
              declaration: {
                select: {
                  declarantUserId: true,
                  createdByDeclarantUserId: true
                }
              }
            }
          }
        }
      })

      if (!existingChunk) {
        throw createHttpError(404, 'Chunk introuvable')
      }

      const finalPointPrelevementId = hasPointPrelevementIdInPayload
        ? payloadPointPrelevementId
        : existingChunk.pointPrelevementId
      const pointAssociationChanged = hasPointPrelevementIdInPayload
        && existingChunk.pointPrelevementId !== finalPointPrelevementId

      if (!isChunkPointAssociationChangeAllowed(existingChunk, finalPointPrelevementId)) {
        const lockedAssociationError = createHttpError(
          409,
          'Une association automatique ne peut être ni modifiée ni détachée.'
        )
        lockedAssociationError.data = {
          reason: AUTOMATIC_POINT_ASSOCIATION_LOCK_REASON,
          chunkId: existingChunk.id,
          pointPrelevementId: existingChunk.pointPrelevementId
        }
        throw lockedAssociationError
      }

      let targetPoint = null
      if (hasPointPrelevementIdInPayload && finalPointPrelevementId !== null) {
        if (isAdmin) {
          targetPoint = await tx.pointPrelevement.findFirst({
            where: {id: finalPointPrelevementId, deletedAt: null},
            select: {id: true, flowType: true}
          })

          if (!targetPoint) {
            throw createHttpError(400, 'Ce point de prélèvement est introuvable.')
          }
        } else {
          targetPoint = await tx.pointPrelevement.findFirst({
            where: {
              id: finalPointPrelevementId,
              deletedAt: null,
              zones: {some: {zoneId: {in: permittedZoneIds}}}
            },
            select: {id: true, flowType: true}
          })
        }

        if (!targetPoint) {
          throw createHttpError(403, 'Ce point de prélèvement ne fait pas partie de votre périmètre d’instruction.')
        }

        const pointFlowType = targetPoint.flowType
        const sourceFlowType = getSourceFlowTypeFromMetadata(existingChunk.metadata)
        if (sourceFlowType && sourceFlowType !== pointFlowType) {
          const error = createHttpError(
            409,
            'Le type de point indiqué par le fichier ne correspond pas à celui du point sélectionné.'
          )
          error.data = {
            reason: 'POINT_FLOW_TYPE_MISMATCH',
            sourceFlowType,
            pointFlowType,
            pointPrelevementId: targetPoint.id
          }
          throw error
        }
      }

      if (instructionStatus === 'VALIDATED' && !finalPointPrelevementId) {
        throw createHttpError(
          400,
          'Impossible de valider un volume sans point de prélèvement associé.'
        )
      }

      if (instructionStatus === 'VALIDATED') {
        const chunkToValidate = {
          ...existingChunk,
          pointPrelevementId: finalPointPrelevementId
        }

        const conflictsByChunkId = await getValidatedChunkConflictsForChunks([chunkToValidate], tx)
        const validationConflicts = conflictsByChunkId[existingChunk.id] ?? []

        if (validationConflicts.length > 0) {
          const conflictError = createHttpError(
            409,
            'Impossible de valider ce chunk car des données déjà validées se chevauchent sur le même point de prélèvement pour le même déclarant.'
          )

          conflictError.data = {
            sourceId: existingChunk.sourceId,
            chunkId: existingChunk.id,
            pointPrelevementId: finalPointPrelevementId,
            minDate: existingChunk.minDate,
            maxDate: existingChunk.maxDate,
            validationConflicts
          }

          throw conflictError
        }
      }

      if (instructionStatus !== 'PENDING') {
        await ensureInstructionActor(tx, req.user)
      }

      const pointAssociationUpdate = hasPointPrelevementIdInPayload
        ? {
          pointPrelevementId: finalPointPrelevementId,
          flowType: finalPointPrelevementId
            ? targetPoint.flowType
            : getSourceFlowTypeFromMetadata(existingChunk.metadata),
          ...(pointAssociationChanged
            ? {
              parsingInfo: buildManualChunkPointAssociationParsingInfo({
                parsingInfo: existingChunk.parsingInfo,
                previousPointPrelevementId: existingChunk.pointPrelevementId,
                pointPrelevementId: finalPointPrelevementId,
                changedByUserId: req.user.id,
                changedByRole: req.user.role,
                changedAt: now
              })
            }
            : {})
        }
        : {}

      const chunkUpdateData
        = instructionStatus === 'PENDING'
          ? {
            instructionStatus,
            instructedAt: null,
            instructedByInstructorUserId: null,
            instructionComment: instructionComment ?? null,
            ...pointAssociationUpdate
          }
          : {
            instructionStatus,
            instructedAt: now,
            instructedByInstructorUserId: instructorUserId,
            instructionComment: instructionComment ?? null,
            ...pointAssociationUpdate
          }

      const updatedChunk = await tx.chunk.update({
        where: {id: chunkId},
        data: chunkUpdateData,
        select: {
          id: true,
          sourceId: true
        }
      })

      if (finalPointPrelevementId) {
        await syncDeclarantZonesFromPoint({
          declarantUserIds: [
            existingChunk.preleveurUserId,
            existingChunk.submittedByDeclarantUserId,
            existingChunk.collecteurUserId,
            existingChunk.source.declaration?.declarantUserId,
            existingChunk.source.declaration?.createdByDeclarantUserId
          ],
          pointPrelevementId: finalPointPrelevementId,
          source: 'RECONCILIATION',
          createdByUserId: req.user.id,
          client: tx
        })
      }

      const sourceChunks = await tx.chunk.findMany({
        where: {
          sourceId: existingChunk.sourceId
        },
        select: {
          instructionStatus: true
        }
      })

      const globalInstructionStatus = computeGlobalInstructionStatus(
        sourceChunks.map(chunk => chunk.instructionStatus)
      )

      await tx.source.update({
        where: {
          id: existingChunk.sourceId
        },
        data: {
          globalInstructionStatus
        }
      })

      await refreshSourceDeclarantsLastDeclarationAt(existingChunk.sourceId, {client: tx})

      return updatedChunk
    })

    let refreshedSource

    if (isAdmin) {
      refreshedSource = await getSourceForAdmin(transactionResult.sourceId)
    } else {
      const [readZoneIds, instructZoneIds, reconcileZoneIds, sourceZoneIds] = await Promise.all([
        getPermissionZoneIdsForUser(req.user, 'declaration.detail.read'),
        getPermissionZoneIdsForUser(req.user, 'declaration.instruct'),
        getPermissionZoneIdsForUser(req.user, 'declaration.reconcile'),
        getSourceZoneIds(transactionResult.sourceId)
      ])
      const sourceZoneIdSet = new Set(sourceZoneIds)

      refreshedSource = await getSourceForInstructor(
        transactionResult.sourceId,
        {
          readZoneIds,
          instructZoneIds,
          reconcileZoneIds,
          canInstructUnmatched: instructZoneIds.some(zoneId => sourceZoneIdSet.has(zoneId)),
          canReconcileUnmatched: reconcileZoneIds.some(zoneId => sourceZoneIdSet.has(zoneId)),
          canDownloadFiles: await hasZonePermission(
            req.user,
            'declaration.file.download',
            sourceZoneIds
          )
        }
      )
    }

    if (!refreshedSource) {
      return next(createHttpError(404, 'Source introuvable'))
    }

    return res.status(200).json({
      success: true,
      data: refreshedSource
    })
  } catch (error) {
    if (error.data?.reason === AUTOMATIC_POINT_ASSOCIATION_LOCK_REASON) {
      return res.status(409).json({
        success: false,
        error: error.message,
        data: error.data,
        message: error.message
      })
    }

    if (error.status === 409) {
      return res.status(409).json({
        success: false,
        error: error.message,
        data: error.data ?? null,
        message: 'Impossible de valider ces volumes car des données déjà validées se chevauchent sur le même point de prélèvement pour le même déclarant.'
      })
    }

    return next(error)
  }
}
