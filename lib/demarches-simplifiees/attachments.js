/* eslint-disable no-await-in-loop */
import {
  extractCamionCiterne,
  extractMultiParamFile
} from '@fabnum/prelevements-deau-timeseries-parsers'

import {getAttachmentObjectKey} from '@fabnum/demarches-simplifiees'

import s3 from '../util/s3.js'

import * as Dossier from '../models/dossier.js'
import {insertSeriesWithValues, deleteSeriesByAttachmentId} from '../models/series.js'
import {getTerritoires} from '../models/territoire.js'

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
    const {errors, data} = await extractCamionCiterne(buffer)
    result.errors = errors
    result.series = data?.series || []
  } else if (typePrelevement === 'aep-zre' || typePrelevement === 'icpe-hors-zre') {
    const {errors, data} = await extractMultiParamFile(buffer)
    result.errors = errors
    result.series = data?.series || []
  }

  result.errors &&= result.errors.map(error => ({
    ...error,
    severity: error.severity || 'error'
  }))

  const errorSummary = result.errors ? {
    total: result.errors.length,
    error: result.errors.filter(e => e.severity === 'error').length,
    warning: result.errors.filter(e => e.severity === 'warning').length
  } : {total: 0}

  if (result.errors?.length > 50) {
    result.errors = result.errors.slice(0, 50)
    result.errors.push({
      message: 'Le fichier contient plus de 50 erreurs. Les erreurs suivantes n’ont pas été affichées.'
    })
  }

  // Déterminer le status de validation maintenant
  if (result.errors?.length > 0) {
    validationStatus = result.errors.some(error => error.severity === 'error') ? 'error' : 'warning'
  } else {
    validationStatus = 'success'
  }

  // (Re)créer les séries : suppression préalable si déjà présentes (idempotence rerun)
  await deleteSeriesByAttachmentId(attachment._id)

  // Deduction du code territoire à partir de demarcheNumber (mapping présent dans collection territoires)
  const territoires = await getTerritoires()
  const territoire = territoires.find(t => t.demarcheNumber === demarcheNumber)?.code
  if (!territoire) {
    await Dossier.updateAttachment(attachment._id, {
      processingError: 'territoire introuvable pour cette démarche (mapping manquant)',
      processed: true
    })
    return
  }

  const {insertedSeriesIds, totalValueDocs} = await insertSeriesWithValues({
    attachmentId: attachment._id,
    demarcheNumber,
    dossierNumber,
    territoire,
    series: result.series || []
  })

  const attachmentMeta = {
    processed: true,
    validationStatus,
    result: {
      seriesCount: insertedSeriesIds.length,
      valueRowCount: totalValueDocs,
      errorSummary,
      errors: result.errors
    }
  }

  await Dossier.updateAttachment(attachment._id, attachmentMeta)
}

/* Helpers */

function isSheet(filename) {
  const lcFilename = filename.toLowerCase()
  return lcFilename.endsWith('.xlsx') || lcFilename.endsWith('.xls') || lcFilename.endsWith('.ods')
}
