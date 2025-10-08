import mongo from '../util/mongo.js'
import {deleteSeriesByAttachmentId} from './series.js'

export async function upsertDossier(demarcheNumber, dossier) {
  const result = await mongo.db.collection('dossiers').findOneAndUpdate(
    {demarcheNumber, number: dossier.number},
    {$set: dossier},
    {upsert: true, returnDocument: 'after'}
  )

  return result
}

export async function updateDossier(demarcheNumber, dossierNumber, changes) {
  await mongo.db.collection('dossiers').updateOne({
    demarcheNumber,
    number: dossierNumber
  }, {$set: changes})
}

export async function getDossier(dossierId) {
  return mongo.db.collection('dossiers').findOne({_id: dossierId})
}

export function getDossierByNumero(demarcheNumber, number) {
  return mongo.db.collection('dossiers').findOne({demarcheNumber, number})
}

export async function getDossiers(demarcheNumber, query = {}) {
  return mongo.db.collection('dossiers').find({demarcheNumber, ...query}).sort({dateDepot: -1}).toArray()
}

export async function getUnconsolidatedDossiers() {
  const query = {consolidatedAt: {$exists: false}}

  return mongo.db.collection('dossiers')
    .find(query, {projection: {demarcheNumber: 1, number: 1}}) // eslint-disable-line unicorn/no-array-method-this-argument
    .toArray()
}

export async function getDossiersStats(demarcheNumber) {
  const result = await mongo.db.collection('dossiers').aggregate([
    {$match: {demarcheNumber}},
    {$group: {_id: '$status', count: {$sum: 1}}}
  ]).toArray()

  return Object.fromEntries(
    result.map(r => [r._id, r.count])
  )
}

export async function getAttachments(demarcheNumber, dossierNumber) {
  return mongo.db.collection('dossier_attachments')
    .find({demarcheNumber, dossierNumber})
    .toArray()
}

export async function getAttachment(attachmentId) {
  return mongo.db.collection('dossier_attachments')
    .findOne({_id: attachmentId})
}

export async function getAttachmentsSummary(demarcheNumber, dossierNumber) {
  return mongo.db.collection('dossier_attachments')
    .find({demarcheNumber, dossierNumber})
    .project({result: 0})
    .toArray()
}

export async function removeAttachmentsByStorageKey(demarcheNumber, dossierNumber, storageKeys) {
  const attachments = await mongo.db.collection('dossier_attachments')
    .find({demarcheNumber, dossierNumber, storageKey: {$in: storageKeys}})
    .project({_id: 1})
    .toArray()

  if (attachments.length === 0) {
    return
  }

  const attachmentIds = attachments.map(a => a._id)

  // Delete series + values for each attachment (parallel)
  await Promise.all(attachmentIds.map(id => deleteSeriesByAttachmentId(id)))

  await mongo.db.collection('dossier_attachments').deleteMany({
    demarcheNumber,
    dossierNumber,
    storageKey: {$in: storageKeys}
  })

  // Invalidate consolidation so it can be recomputed without removed data
  await mongo.db.collection('dossiers').updateOne(
    {demarcheNumber, dossierNumber},
    {$unset: {consolidatedAt: 1}}
  )
}

export async function createAttachment(demarcheNumber, dossierNumber, typePrelevement, storageKey) {
  await mongo.db.collection('dossier_attachments').insertOne({
    demarcheNumber,
    dossierNumber,
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
    const {demarcheNumber, dossierNumber} = await mongo.db.collection('dossier_attachments').findOne(
      {_id: attachmentId},
      {projection: {demarcheNumber: 1, dossierNumber: 1}}
    )

    await mongo.db.collection('dossiers').updateOne(
      {demarcheNumber, number: dossierNumber},
      {$unset: {consolidatedAt: 1}}
    )
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
    .find({demarcheNumber: dossier.demarcheNumber, dossierNumber: dossier.number})
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
