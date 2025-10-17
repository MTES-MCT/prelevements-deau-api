/* eslint-disable no-await-in-loop */
import s3 from '../util/s3.js'

import * as Dossier from '../models/dossier.js'
import {getTerritoires} from '../models/territoire.js'

import {extractDossier} from './extract.js'

import {sync, iterate} from '@fabnum/demarches-simplifiees'

export async function resyncAllDossiers() {
  const territoires = await getTerritoires()

  for (const territoire of territoires) {
    if (!territoire.demarcheNumber) {
      continue
    }

    await resyncAllDossiersDemarche(territoire.demarcheNumber)
  }
}

async function resyncAllDossiersDemarche(demarcheNumber) {
  async function onDossier({dossier, attachments}) {
    console.log(`Processing dossier ${demarcheNumber}/${dossier.number}`)
    await processDossier(demarcheNumber, dossier, attachments)
  }

  await iterate(demarcheNumber, {onDossier, s3: s3('ds')})
}

export async function syncUpdatedDossiers() {
  const territoires = await getTerritoires()

  for (const territoire of territoires) {
    if (!territoire.demarcheNumber) {
      continue
    }

    await syncUpdatedDossiersDemarche(territoire.demarcheNumber)
  }
}

async function syncUpdatedDossiersDemarche(demarcheNumber) {
  async function onDossier({dossier, attachments, isUpdated}) {
    if (isUpdated) {
      await processDossier(demarcheNumber, dossier, attachments)
    }
  }

  await sync(demarcheNumber, {onDossier, s3: s3('ds')})
}

export async function processDossier(demarcheNumber, rawDossier, storageKeys) {
  const dossier = extractDossier(rawDossier)

  // Upsert dossier first to obtain _id (dossierId)
  const upsertResult = await Dossier.upsertDossier(
    demarcheNumber,
    {...dossier}
  )
  const dossierId = upsertResult._id

  const existingAttachments = await Dossier.getAttachmentsSummaryByDossierId(dossierId)

  // Compute the list of attachments to remove
  const storageKeysToRemove = existingAttachments
    .filter(a => !storageKeys.includes(a.storageKey))
    .map(a => a.storageKey)

  await Dossier.removeAttachmentsByStorageKey(dossierId, storageKeysToRemove)

  // Compute the list of storageKey to add
  const storageKeysToAdd = storageKeys
    .filter(storageKey => !existingAttachments.some(a => a.storageKey === storageKey))

  await Promise.all(
    storageKeysToAdd.map(
      storageKey => Dossier.createAttachment({
        dossierId,
        dossierNumber: dossier.number,
        demarcheNumber,
        typePrelevement: dossier.typePrelevement,
        storageKey
      })
    )
  )
}
