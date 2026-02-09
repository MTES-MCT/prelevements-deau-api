import {createLogger} from '../util/logger.js'
import {prisma} from '../../db/prisma.js'
import * as Sentry from '@sentry/node'
import createStorageClient from '../util/s3.js'
import {DECLARATIONS_BUCKET} from '../handlers/declarations.js'

export async function processDeclaration(declarationId, logger = createLogger()) {
  logger.log(`Traitement de la déclaration ${declarationId} - TODO`)

  const declaration = await prisma.declaration.findFirst({
    where: {id: declarationId},
    include: {files: true}
  })

  if (!declaration) {
    logger.error(`Déclaration ${declarationId} introuvable`)
    Sentry.captureException(new Error(`Déclaration ${declarationId} introuvable`))
    return
  }

  const storage = createStorageClient(DECLARATIONS_BUCKET)

  const filesWithUrls = await Promise.all(
    declaration.files.map(async f => ({
      ...f,
      url: await storage.getPresignedUrl(f.storageKey)
    }))
  )

  // TODO: faire le traitement de la déclaration
}
