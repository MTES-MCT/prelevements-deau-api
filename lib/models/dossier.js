import mongo from '../util/mongo.js'

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

export async function getDossiers(demarcheNumber) {
  return mongo.db.collection('dossiers').find({demarcheNumber}).toArray()
}

export async function getAttachments(demarcheNumber, dossierNumber) {
  return mongo.db.collection('dossier_attachments')
    .find({demarcheNumber, dossierNumber})
    .toArray()
}

export async function getAttachmentsSummary(demarcheNumber, dossierNumber) {
  return mongo.db.collection('dossier_attachments')
    .find({demarcheNumber, dossierNumber})
    .project({result: 0})
    .toArray()
}

export async function removeAttachmentsByStorageKey(demarcheNumber, dossierNumber, storageKeys) {
  await mongo.db.collection('dossier_attachments').deleteOne({
    demarcheNumber,
    dossierNumber,
    storageKey: {$in: storageKeys}
  })
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
}

export async function getUnprocessedAttachments() {
  return mongo.db.collection('dossier_attachments')
    .find({processed: false})
    .project({result: 0}) // Exclude the 'result' field from the returned documents
    .toArray()
}

export async function getAttachmentByStorageKey(demarcheNumber, dossierNumber, storageKey, withDataAndErrors = false) {
  const projection = withDataAndErrors ? {} : {result: 0}

  return mongo.db.collection('dossier_attachments')
    .findOne({demarcheNumber, dossierNumber, storageKey}, {projection})
}

export async function getAttachmentByStorageHash(demarcheNumber, dossierNumber, storageHash, withDataAndErrors = false) {
  const storageKeys = await mongo.db.collection('dossier_attachments').distinct('storageKey', {demarcheNumber, dossierNumber})

  const storageKey = storageKeys.find(key => key.startsWith(storageHash))

  if (storageKey) {
    return getAttachmentByStorageKey(demarcheNumber, dossierNumber, storageKey, withDataAndErrors)
  }
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
