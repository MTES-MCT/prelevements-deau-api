/* eslint-disable no-await-in-loop */
import s3 from '../util/s3.js'

import * as Dossier from '../models/dossier.js'
import * as DossierService from '../services/dossier.js'
import {getTerritoires} from '../models/territoire.js'
import {createLogger} from '../util/logger.js'

import {extractDossier} from './extract.js'

import {sync, iterate} from '@fabnum/demarches-simplifiees'

export async function resyncAllDossiers() {
  const territoires = await getTerritoires()

  for (const territoire of territoires) {
    if (!territoire.demarcheNumber) {
      continue
    }

    await resyncAllDossiersDemarche(territoire.demarcheNumber, territoire.code)
  }
}

async function resyncAllDossiersDemarche(demarcheNumber, territoire, logger = createLogger()) {
  async function onDossier({dossier, attachments}) {
    logger.log(`Processing dossier ${demarcheNumber}/${dossier.number}`)
    await processDossier(demarcheNumber, territoire, dossier, attachments)
  }

  await iterate(demarcheNumber, {onDossier, s3: s3('ds')})
}

export async function syncUpdatedDossiers(logger = createLogger()) {
  const territoires = await getTerritoires()

  for (const territoire of territoires) {
    if (!territoire.demarcheNumber) {
      continue
    }

    await syncUpdatedDossiersDemarche(territoire.demarcheNumber, territoire.code, logger)
  }
}

async function syncUpdatedDossiersDemarche(demarcheNumber, territoire, logger = createLogger()) {
  async function onDossier({dossier, attachments, isUpdated}) {
    if (isUpdated) {
      logger.log(`Processing dossier ${demarcheNumber}/${dossier.number}`)
      await processDossier(demarcheNumber, territoire, dossier, attachments)
    }
  }

  await sync(demarcheNumber, {onDossier, s3: s3('ds')})
}

export async function processDossier(demarcheNumber, territoire, rawDossier, storageKeys) {
  const {number, ...dossier} = extractDossier(rawDossier)
  const ds = {
    demarcheNumber,
    dossierNumber: number
  }

  // Upsert dossier first to obtain _id (dossierId)
  const upsertResult = await Dossier.upsertDossier({
    territoire,
    ds,
    ...dossier
  })
  const dossierId = upsertResult._id

  const existingAttachments = await Dossier.getAttachmentsSummaryByDossierId(dossierId)

  // Compute the list of attachments to remove
  const storageKeysToRemove = existingAttachments
    .filter(a => !storageKeys.includes(a.storageKey))
    .map(a => a.storageKey)

  await DossierService.removeAttachmentsByStorageKey(dossierId, storageKeysToRemove)

  // Compute the list of storageKey to add
  const storageKeysToAdd = storageKeys
    .filter(storageKey => !existingAttachments.some(a => a.storageKey === storageKey))

  await Promise.all(
    storageKeysToAdd.map(
      storageKey => DossierService.createAttachment({
        dossierId,
        ds,
        territoire,
        typePrelevement: dossier.typePrelevement,
        storageKey
      })
    )
  )

  // Si le dossier était déjà consolidé et qu'il n'y a pas eu de changements d'attachments,
  // il faut quand même reconsolider car d'autres champs peuvent avoir changé (status, etc.)
  if (storageKeysToAdd.length === 0 && storageKeysToRemove.length === 0 && upsertResult.consolidatedAt) {
    await DossierService.markDossierForReconsolidation(dossierId)
  }
}
