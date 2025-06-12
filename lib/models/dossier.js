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
  const attachments = await mongo.db.collection('dossier_attachments')
    .find({demarcheNumber, dossierNumber})
    .toArray()

  return attachments.map(attachment => ({
    ...attachment,
    errors: (attachment.errors || []).map(error => ({
      ...error,
      severity: error.severity || 'error',
      destinataire: 'déclarant',
      scope: 'file'
    }))
  }))
}

export async function getAttachmentsSummary(demarcheNumber, dossierNumber) {
  return mongo.db.collection('dossier_attachments')
    .find({demarcheNumber, dossierNumber})
    .project({errors: 0, data: 0})
    .toArray()
}

export async function removeAttachmentsByStorageKey(demarcheNumber, dossierNumber, storageKeys) {
  await mongo.db.collection('dossier_attachments').deleteOne({
    demarcheNumber,
    dossierNumber,
    storageKey: {$in: storageKeys}
  })
}

export async function createAttachment(demarcheNumber, dossierNumber, storageKey) {
  await mongo.db.collection('dossier_attachments').insertOne({
    demarcheNumber,
    dossierNumber,
    processed: false,
    storageKey
  })
}

export async function updateAttachment(attachmentId, changes) {
  await mongo.db.collection('dossier_attachments').updateOne(
    {_id: attachmentId},
    {$set: changes}
  )
}

export async function getUnprocessedAttachments(demarcheNumber, dossierNumber) {
  return mongo.db.collection('dossier_attachments')
    .find({demarcheNumber, dossierNumber, processed: false})
    .toArray()
}

export async function getAttachmentByStorageKey(demarcheNumber, dossierNumber, storageKey) {
  return mongo.db.collection('dossier_attachments')
    .findOne({demarcheNumber, dossierNumber, storageKey})
}
