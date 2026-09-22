import Joi from 'joi'
import createHttpError from 'http-errors'
import {resourceIdSchema} from '../validation/resource-id.js'

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
  canChangeChunkPointAssociation,
  buildManualChunkPointAssociationParsingInfo,
  isChunkPointAssociationChangeAllowed
} from '../services/chunk-point-associations.js'
import {refreshSourceDeclarantsLastDeclarationAt} from '../models/declarant.js'
import {resolveExploitation} from '../services/exploitation-periods.js'
import {reconstructVolumesFromIndexForPoint} from '../services/volumes-from-index.js'

const CHUNK_INSTRUCTION_STATUSES = ['PENDING', 'REJECTED', 'VALIDATED']

export const updateChunkInstructionSchema = Joi.object({
  instructionStatus: Joi.string()
    .valid(...CHUNK_INSTRUCTION_STATUSES)
    .required(),
  instructionComment: Joi.string().allow('', null).optional(),
  exploitationId: resourceIdSchema.allow(null).optional(),
  pointPrelevementId: resourceIdSchema.allow('', null).optional()
})

export async function resolveInstructionChunkExploitation({client, chunk, pointPrelevementId, exploitationId}) {
  const declarantUserId = chunk.preleveurUserId || chunk.source?.declaration?.declarantUserId
  if (!declarantUserId) {
    throw createHttpError(409, 'Le préleveur doit être identifié avant de rattacher cette série à une exploitation.')
  }
  const declarant = await client.declarant.findUnique({where: {userId: declarantUserId}, select: {declarantRole: true}})
  const where = !chunk.preleveurUserId && declarant?.declarantRole === 'COLLECTEUR'
    ? {OR: [{declarantUserId}, {collecteurs: {some: {collecteurUserId: declarantUserId}}}]}
    : {declarantUserId}
  const exploitation = await resolveExploitation({
    client, exploitationId, pointPrelevementId, where,
    countingCode: chunk.metadata?.countingCode ?? undefined,
    start: chunk.minDate, end: chunk.maxDate,
    select: {id: true, declarantUserId: true, countingCode: true}
  })
  if (!exploitation) {
    throw createHttpError(409, 'Aucune exploitation autorisée ne correspond au point, au préleveur, au code comptage et à la période.')
  }
  return exploitation
}

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
          calculationStrategy: true,
          pointPrelevementId: true,
          exploitationId: true,
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

      if (existingChunk.calculationStrategy && existingChunk.calculationStrategy !== 'GENERIC') {
        throw createHttpError(409, 'Cette série est calculée à partir de relevés de compteur. Corrigez les relevés ou les affectations du compteur concerné.')
      }

      const finalPointPrelevementId = hasPointPrelevementIdInPayload
        ? payloadPointPrelevementId || null
        : existingChunk.pointPrelevementId
      const pointAssociationChanged = hasPointPrelevementIdInPayload
        && existingChunk.pointPrelevementId !== finalPointPrelevementId

      const hasExploitationId = Object.hasOwn(value, 'exploitationId')
      const exploitationAssociationChanged = hasExploitationId
        && existingChunk.exploitationId !== value.exploitationId
      if (!isChunkPointAssociationChangeAllowed(existingChunk, finalPointPrelevementId)
        || (existingChunk.exploitationId && exploitationAssociationChanged && !canChangeChunkPointAssociation(existingChunk))) {
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

      let finalExploitationId = finalPointPrelevementId ? existingChunk.exploitationId : null
      let finalPreleveurUserId = existingChunk.preleveurUserId
      if (finalPointPrelevementId && (pointAssociationChanged || hasExploitationId || (instructionStatus === 'VALIDATED' && !finalExploitationId))) {
        const exploitation = await resolveInstructionChunkExploitation({
          client: tx, chunk: existingChunk, pointPrelevementId: finalPointPrelevementId,
          exploitationId: hasExploitationId ? value.exploitationId : undefined
        })
        finalExploitationId = exploitation.id
        finalPreleveurUserId = exploitation.declarantUserId
      }

      if (instructionStatus === 'VALIDATED') {
        const chunkToValidate = {
          ...existingChunk,
          pointPrelevementId: finalPointPrelevementId,
          exploitationId: finalExploitationId,
          preleveurUserId: finalPreleveurUserId
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

      chunkUpdateData.exploitationId = finalExploitationId
      chunkUpdateData.preleveurUserId = finalPreleveurUserId
      if (exploitationAssociationChanged) {
        chunkUpdateData.parsingInfo = buildManualChunkPointAssociationParsingInfo({
          parsingInfo: chunkUpdateData.parsingInfo ?? existingChunk.parsingInfo,
          previousPointPrelevementId: existingChunk.pointPrelevementId,
          pointPrelevementId: finalPointPrelevementId,
          changedByUserId: req.user.id, changedByRole: req.user.role, changedAt: now,
          details: {previousExploitationId: existingChunk.exploitationId, exploitationId: finalExploitationId}
        })
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
            finalPreleveurUserId,
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

      return {
        ...updatedChunk,
        reconstructionPointIds: [...new Set([existingChunk.pointPrelevementId, finalPointPrelevementId].filter(Boolean))]
      }
    })

    for (const pointId of transactionResult.reconstructionPointIds) {
      // eslint-disable-next-line no-await-in-loop -- Serialize calculations sharing the same point lock.
      await reconstructVolumesFromIndexForPoint(pointId)
    }

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
        message: error.message
      })
    }

    return next(error)
  }
}
