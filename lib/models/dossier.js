import mongo from '../util/mongo.js'
import {deleteSeriesByAttachmentId} from './series.js'
import {deleteIntegrationsByAttachment} from './integration-journaliere.js'

export async function upsertDossier({territoire, ds, ...dossier}) {
  if (!territoire) {
    throw new Error('territoire is required')
  }

  if (!ds) {
    throw new Error('dossier.ds is required')
  }

  const uniqueKey = {
    territoire,
    'ds.dossierNumber': ds.dossierNumber,
    'ds.demarcheNumber': ds.demarcheNumber
  }

  const result = await mongo.db.collection('dossiers').findOneAndUpdate(
    uniqueKey,
    {$set: dossier},
    {upsert: true, returnDocument: 'after'}
  )

  return result
}

export async function updateDossierById(dossierId, changes) {
  await mongo.db.collection('dossiers').updateOne({_id: dossierId}, {$set: changes})
}

export async function markDossierForReconsolidation(dossierId) {
  const result = await mongo.db.collection('dossiers').findOneAndUpdate(
    {_id: dossierId},
    {$unset: {consolidatedAt: 1}},
    {returnDocument: 'after'}
  )

  return result
}

export async function getDossier(dossierId) {
  return mongo.db.collection('dossiers').findOne({_id: dossierId})
}

export async function getDossiers(territoire, query = {}) {
  return mongo.db.collection('dossiers').find({territoire, ...query}).sort({dateDepot: -1}).toArray()
}

export async function getUnconsolidatedDossiers() {
  const query = {consolidatedAt: {$exists: false}}

  return mongo.db.collection('dossiers')
    .find(query, {projection: {territoire: 1, ds: 1}}) // eslint-disable-line unicorn/no-array-method-this-argument
    .toArray()
}

export async function getDossiersStats(territoire) {
  const result = await mongo.db.collection('dossiers').aggregate([
    {$match: {territoire}},
    {$group: {_id: '$status', count: {$sum: 1}}}
  ]).toArray()

  return Object.fromEntries(
    result.map(r => [r._id, r.count])
  )
}

export async function getAttachmentsByDossierId(dossierId) {
  return mongo.db.collection('dossier_attachments')
    .find({dossierId})
    .toArray()
}

export async function getAttachment(attachmentId) {
  return mongo.db.collection('dossier_attachments')
    .findOne({_id: attachmentId})
}

export async function getAttachmentsSummaryByDossierId(dossierId) {
  return mongo.db.collection('dossier_attachments')
    .find({dossierId})
    .project({result: 0})
    .toArray()
}

export async function removeAttachmentsByStorageKey(dossierId, storageKeys) {
  const attachments = await mongo.db.collection('dossier_attachments')
    .find({dossierId, storageKey: {$in: storageKeys}})
    .project({_id: 1})
    .toArray()

  if (attachments.length === 0) {
    return
  }

  const attachmentIds = attachments.map(a => a._id)

  // Delete in cascade: integrations + series + values for each attachment (parallel)
  await Promise.all(
    attachmentIds.map(async id => {
      await deleteIntegrationsByAttachment(id)
      await deleteSeriesByAttachmentId(id)
    })
  )

  await mongo.db.collection('dossier_attachments').deleteMany({dossierId, storageKey: {$in: storageKeys}})

  // Invalidate consolidation so it can be recomputed without removed data
  await mongo.db.collection('dossiers').updateOne({_id: dossierId}, {$unset: {consolidatedAt: 1}})
}

export async function createAttachment({dossierId, ds, territoire, typePrelevement, storageKey}) {
  await mongo.db.collection('dossier_attachments').insertOne({
    dossierId,
    ds,
    territoire,
    typePrelevement,
    storageKey,
    processed: false
  })
}

export async function updateAttachment(attachmentId, changes) {
  await mongo.db.collection('dossier_attachments').updateOne(
    {_id: attachmentId},
    {$set: changes}
  )

  // If the attachment was processed, mark the dossier to be consolidated
  if (changes.processed) {
    const {dossierId} = await mongo.db.collection('dossier_attachments').findOne(
      {_id: attachmentId},
      {projection: {dossierId: 1}}
    )

    await mongo.db.collection('dossiers').updateOne({_id: dossierId}, {$unset: {consolidatedAt: 1}})
  }
}

export async function getUnprocessedAttachments() {
  return mongo.db.collection('dossier_attachments')
    .find({processed: false})
    .project({result: 0}) // Exclude the 'result' field from the returned documents
    .toArray()
}

export async function decorateDossier(dossier) {
  const attachments = await mongo.db.collection('dossier_attachments')
    .find({dossierId: dossier._id})
    .project({_id: 0, validationStatus: 1})
    .toArray()

  let validationStatus = null

  if (attachments && attachments.length > 0) {
    const statuses = new Set(attachments.map(a => a.validationStatus))
    const statusOrder = ['failed', 'error', null, 'warning', 'success']

    for (const status of statusOrder) {
      if (statuses.has(status)) {
        validationStatus = status
        break
      }
    }
  }

  return {
    ...dossier,
    validationStatus
  }
}
