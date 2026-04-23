import {createLogger} from '../util/logger.js'
import * as Sentry from '@sentry/node'
import {getApiImportById} from '../models/api-imports.js'

export async function processApiImport(apiImportId, logger = createLogger()) {
  logger.log(`Traitement de l'import API ${apiImportId}`)

  const declaration = await getApiImportById(apiImportId)
  if (!declaration) {
    logger.error(`Import API ${apiImportId} introuvable`)
    Sentry.captureException(new Error(`Import API ${apiImportId} introuvable`))
  }

  // TODO
}
