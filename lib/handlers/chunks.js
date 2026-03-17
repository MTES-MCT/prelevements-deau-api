import Joi from 'joi'
import createHttpError from 'http-errors'

import {prisma} from '../../db/prisma.js'
import {
  getAccessiblePointPrelevementIdsSetForInstructor,
  getSourceForInstructor,
  getValidatedChunkConflictsForChunks
} from '../services/instructor-sources.js'

const CHUNK_INSTRUCTION_STATUSES = ['PENDING', 'REJECTED', 'VALIDATED']

const updateChunkInstructionSchema = Joi.object({
  instructionStatus: Joi.string()
    .valid(...CHUNK_INSTRUCTION_STATUSES)
    .required(),
  instructionComment: Joi.string().allow('', null).optional(),
  pointPrelevementId: Joi.string().allow('', null).uuid({version: 'uuidv4'}).optional()
})

function computeGlobalInstructionStatus(chunkStatuses) {
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

export async function updateChunkInstructionHandler(req, res, next) {
  try {
    if (!req.user) {
      return next(createHttpError(401, 'Non authentifié'))
    }

    if (req.user.role !== 'INSTRUCTOR') {
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

    const accessiblePointIdsSet = await getAccessiblePointPrelevementIdsSetForInstructor(
      instructorUserId,
      now
    )

    const transactionResult = await prisma.$transaction(async tx => {
      const existingChunk = await tx.chunk.findUnique({
        where: {id: chunkId},
        select: {
          id: true,
          sourceId: true,
          pointPrelevementId: true,
          minDate: true,
          maxDate: true,
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

      if (!existingChunk) {
        throw createHttpError(404, 'Chunk introuvable')
      }

      const finalPointPrelevementId = hasPointPrelevementIdInPayload
        ? payloadPointPrelevementId
        : existingChunk.pointPrelevementId

      if (hasPointPrelevementIdInPayload && finalPointPrelevementId !== null && !accessiblePointIdsSet.has(finalPointPrelevementId)) {
        throw createHttpError(
          403,
          'Droits insuffisants. Ce point de prélèvement ne fait pas partie de votre périmètre d’instruction.'
        )
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

      const chunkUpdateData
        = instructionStatus === 'PENDING'
          ? {
            instructionStatus,
            instructedAt: null,
            instructedByInstructorUserId: null,
            instructionComment: instructionComment ?? null,
            ...(hasPointPrelevementIdInPayload
              ? {pointPrelevementId: finalPointPrelevementId}
              : {})
          }
          : {
            instructionStatus,
            instructedAt: now,
            instructedByInstructorUserId: instructorUserId,
            instructionComment: instructionComment ?? null,
            ...(hasPointPrelevementIdInPayload
              ? {pointPrelevementId: finalPointPrelevementId}
              : {})
          }

      const updatedChunk = await tx.chunk.update({
        where: {id: chunkId},
        data: chunkUpdateData,
        select: {
          id: true,
          sourceId: true
        }
      })

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

      return updatedChunk
    })

    const refreshedSource = await getSourceForInstructor(
      instructorUserId,
      transactionResult.sourceId
    )

    if (!refreshedSource) {
      return next(createHttpError(404, 'Source introuvable'))
    }

    return res.status(200).json({
      success: true,
      data: refreshedSource
    })
  } catch (error) {
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
