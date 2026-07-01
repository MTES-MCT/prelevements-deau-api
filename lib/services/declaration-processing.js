import process from 'node:process'

import {prisma} from '../../db/prisma.js'
import {notifyDeclarationUploaded} from './orchestration-client.js'

export const DECLARATION_PROCESSING_STATUS = Object.freeze({
  CREATED: 'CREATED',
  UPLOADED: 'UPLOADED',
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
})

function getObjectMetadata(metadata) {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
}

function getErrorMessage(error) {
  return error?.message || String(error)
}

export function isDeclarationOrchestrationRequired() {
  return process.env.ORCHESTRATION_REQUIRED === 'true' || process.env.NODE_ENV === 'production'
}

async function createProcessingEvent({
  declarationId,
  status,
  message,
  metadata,
  createdByUserId,
  client = prisma
}) {
  await client.declarationProcessingEvent.create({
    data: {
      declarationId,
      status,
      message: message ?? null,
      metadata: metadata ?? undefined,
      createdByUserId: createdByUserId ?? null
    }
  })
}

export async function markDeclarationProcessingUploaded({
  declarationId,
  createdByUserId,
  metadata,
  client = prisma
}) {
  await client.$transaction(async tx => {
    await tx.declaration.update({
      where: {id: declarationId},
      data: {
        processingStatus: DECLARATION_PROCESSING_STATUS.UPLOADED,
        processingError: null,
        processingFailedAt: null
      }
    })
    await createProcessingEvent({
      declarationId,
      status: DECLARATION_PROCESSING_STATUS.UPLOADED,
      message: 'Déclaration uploadée',
      metadata,
      createdByUserId,
      client: tx
    })
  })
}

export async function markDeclarationProcessingStarted({
  declarationId,
  createdByUserId,
  metadata,
  client = prisma
}) {
  await client.$transaction(async tx => {
    await tx.declaration.update({
      where: {id: declarationId},
      data: {
        processingStatus: DECLARATION_PROCESSING_STATUS.PROCESSING,
        processingStartedAt: new Date(),
        processingAttemptCount: {
          increment: 1
        },
        processingError: null,
        processingFailedAt: null
      }
    })
    await createProcessingEvent({
      declarationId,
      status: DECLARATION_PROCESSING_STATUS.PROCESSING,
      message: 'Traitement démarré',
      metadata,
      createdByUserId,
      client: tx
    })
  })
}

export async function markDeclarationProcessingCompleted({
  declarationId,
  createdByUserId,
  metadata,
  client = prisma
}) {
  await client.$transaction(async tx => {
    await tx.declaration.update({
      where: {id: declarationId},
      data: {
        processingStatus: DECLARATION_PROCESSING_STATUS.COMPLETED,
        processingCompletedAt: new Date(),
        processingError: null,
        processingFailedAt: null
      }
    })
    await createProcessingEvent({
      declarationId,
      status: DECLARATION_PROCESSING_STATUS.COMPLETED,
      message: 'Traitement terminé',
      metadata,
      createdByUserId,
      client: tx
    })
  })
}

export async function markDeclarationProcessingFailed({
  declarationId,
  error,
  createdByUserId,
  metadata,
  client = prisma
}) {
  const message = getErrorMessage(error)

  await client.$transaction(async tx => {
    await tx.declaration.update({
      where: {id: declarationId},
      data: {
        processingStatus: DECLARATION_PROCESSING_STATUS.FAILED,
        processingFailedAt: new Date(),
        processingError: message
      }
    })
    await createProcessingEvent({
      declarationId,
      status: DECLARATION_PROCESSING_STATUS.FAILED,
      message,
      metadata,
      createdByUserId,
      client: tx
    })
  })
}

export async function requestDeclarationProcessing({
  declarationId,
  createdByUserId,
  replay = false,
  required = isDeclarationOrchestrationRequired(),
  metadata,
  notify = notifyDeclarationUploaded,
  client = prisma
}) {
  try {
    const orchestration = await notify({
      declarationId,
      required
    })

    if (orchestration?.queued) {
      await client.$transaction(async tx => {
        await tx.declaration.update({
          where: {id: declarationId},
          data: {
            processingStatus: DECLARATION_PROCESSING_STATUS.QUEUED,
            processingQueuedAt: new Date(),
            processingJobId: orchestration.jobId,
            processingError: null,
            processingFailedAt: null
          }
        })
        await createProcessingEvent({
          declarationId,
          status: DECLARATION_PROCESSING_STATUS.QUEUED,
          message: replay ? 'Rejeu demandé' : 'Traitement demandé',
          metadata: {
            ...getObjectMetadata(metadata),
            orchestration
          },
          createdByUserId,
          client: tx
        })
      })
    } else {
      await createProcessingEvent({
        declarationId,
        status: DECLARATION_PROCESSING_STATUS.UPLOADED,
        message: replay ? 'Rejeu non mis en file' : 'Traitement non mis en file',
        metadata: {
          ...getObjectMetadata(metadata),
          orchestration
        },
        createdByUserId,
        client
      })
    }

    return orchestration
  } catch (error) {
    await markDeclarationProcessingFailed({
      declarationId,
      error,
      createdByUserId,
      metadata: {
        ...getObjectMetadata(metadata),
        replay
      },
      client
    })

    throw error
  }
}
