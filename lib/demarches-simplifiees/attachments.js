/* eslint-disable no-await-in-loop */
import {calculateObjectSize} from 'bson'
import {gzipSync} from 'node:zlib'

import {
  validateCamionCiterneFile,
  validateMultiParamFile
} from '@fabnum/prelevements-deau-timeseries-parsers'

import {getAttachmentObjectKey} from '@fabnum/demarches-simplifiees'

import s3 from '../util/s3.js'

import * as Dossier from '../models/dossier.js'

export async function processAttachments() {
  const unprocessedAttachments = await Dossier.getUnprocessedAttachments()

  for (const attachment of unprocessedAttachments) {
    await processAttachment(attachment)
  }
}

async function processAttachment(attachment) {
  const isSheetFile = isSheet(attachment.storageKey)

  if (!isSheetFile) {
    await Dossier.updateAttachment(attachment._id, {processed: true})
    return
  }

  const {demarcheNumber, dossierNumber, storageKey, typePrelevement} = attachment

  const objectKey = getAttachmentObjectKey(
    demarcheNumber,
    dossierNumber,
    storageKey
  )

  let buffer

  try {
    buffer = await s3('ds').downloadObject(objectKey)
  } catch {
    await Dossier.updateAttachment(attachment._id, {
      processingError: `Unable to download file ${objectKey}`,
      processed: true
    })
  }

  const result = {}
  let validationStatus = null

  if (typePrelevement === 'camion-citerne') {
    const {errors, data} = await validateCamionCiterneFile(buffer)
    result.errors = errors
    result.series = data?.series || []
  } else if (typePrelevement === 'aep-zre' || typePrelevement === 'icpe-hors-zre') {
    const {errors, data} = await validateMultiParamFile(buffer)
    result.errors = errors
    result.series = data?.series || []
  }

  result.errors &&= result.errors.map(error => ({
    ...error,
    severity: error.severity || 'error'
  }))

  if (result.errors?.length > 50) {
    result.errors = result.errors.slice(0, 50)
    result.errors.push({
      message: 'Le fichier contient plus de 50 erreurs. Les erreurs suivantes n’ont pas été affichées.'
    })
  }

  // Déterminer le status de validation maintenant (avant compression potentielle)
  if (result.errors?.length > 0) {
    validationStatus = result.errors.some(error => error.severity === 'error') ? 'error' : 'warning'
  } else {
    validationStatus = 'success'
  }

  const rawSize = calculateObjectSize(result)
  result.rawSize = rawSize
  const json = JSON.stringify({errors: result.errors, series: result.series})
  const gz = gzipSync(json)
  result.compressedSize = gz.length
  result.payload = gz

  if (result.errors) {
    const errorSummary = {total: result.errors.length}
    for (const e of result.errors) {
      errorSummary[e.severity] = (errorSummary[e.severity] || 0) + 1
    }

    result.errorSummary = errorSummary
  }

  delete result.series
  delete result.errors

  // Vérification finale de la taille mongo après transformation (utile si grande série très peu compressible)
  const finalSize = calculateObjectSize(result)
  if (finalSize > 14 * 1024 * 1024) { // 14 Mo
    await Dossier.updateAttachment(attachment._id, {
      processingError: 'Attachment result too large after compression',
      processed: true,
      validationStatus: 'failed'
    })
    return
  }

  await Dossier.updateAttachment(attachment._id, {processed: true, result, validationStatus})
}

/* Helpers */

function isSheet(filename) {
  const lcFilename = filename.toLowerCase()
  return lcFilename.endsWith('.xlsx') || lcFilename.endsWith('.xls') || lcFilename.endsWith('.ods')
}
