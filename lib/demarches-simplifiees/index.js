import {defer} from '../util/defer.js'
import s3 from '../util/s3.js'

import * as Dossier from '../models/dossier.js'

import {extractDossier} from './extract.js'
import {consolidateDossier} from './consolidate.js'
import {processAttachments} from './attachments.js'

import {sync, iterate} from '@fabnum/demarches-simplifiees'

export async function resyncAllDossiers(demarcheNumber) {
  async function onDossier({dossier, attachments}) {
    console.log(`Processing dossier ${demarcheNumber}/${dossier.number}`)
    await processDossier(demarcheNumber, dossier, attachments)
  }

  await iterate(demarcheNumber, {onDossier, s3: s3('ds')})
}

export async function syncUpdatedDossiers(demarcheNumber) {
  async function onDossier({dossier, attachments, isUpdated}) {
    if (isUpdated) {
      await processDossier(demarcheNumber, dossier, attachments)
    }
  }

  await sync(demarcheNumber, {onDossier, s3: s3('ds')})
}

export async function processDossier(demarcheNumber, rawDossier, storageKeys) {
  const dossier = extractDossier(rawDossier)

  const existingAttachments = await Dossier.getAttachmentsSummary(demarcheNumber, dossier.number)

  // Compute the list of attachments to remove
  const storageKeysToRemove = existingAttachments
    .filter(a => !storageKeys.includes(a.storageKey))
    .map(a => a.storageKey)

  await Dossier.removeAttachmentsByStorageKey(demarcheNumber, dossier.number, storageKeysToRemove)

  // Compute the list of storageKey to add
  const storageKeysToAdd = storageKeys
    .filter(storageKey => !existingAttachments.some(a => a.storageKey === storageKey))

  await Promise.all(
    storageKeysToAdd.map(
      storageKey => Dossier.createAttachment(
        demarcheNumber,
        dossier.number,
        dossier.typePrelevement,
        storageKey
      )
    )
  )

  // Update the dossier in the database

  const attachmentsUpdated = storageKeysToAdd.length > 0 || storageKeysToRemove.length > 0

  await Dossier.upsertDossier(
    demarcheNumber,
    attachmentsUpdated ? {...dossier, attachmentsUpdated: true, contentUpdated: true} : dossier
  )

  await processAttachments(demarcheNumber, dossier.number, dossier.typePrelevement)

  // Defer consolidation
  defer(() => consolidateDossier(demarcheNumber, dossier.number))
}
