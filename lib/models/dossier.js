import mongo from '../util/mongo.js'

export async function upsertDossier(dossier) {
  const result = await mongo.db.collection('dossiers').findOneAndUpdate(
    {numero: dossier.numero},
    {$set: dossier},
    {upsert: true, returnDocument: 'after'}
  )

  return result
}

export async function getDossier(dossierId) {
  const dossier = await mongo.db.collection('dossiers').findOne({_id: dossierId})
  const files = await getDossierAttachments(dossier.numero)
  return {
    ...dossier,
    files
  }
}

export function getDossierByNumero(numero) {
  return mongo.db.collection('dossiers').findOne({numero})
}

export async function getDossiers() {
  return mongo.db.collection('dossiers').find({}).toArray()
}

export async function getDossierAttachments(numeroDossier) {
  return mongo.db.collection('dossier_attachments')
    .find({numeroDossier})
    .toArray()
}

export async function getAllAttachments() {
  return mongo.db.collection('dossier_attachments').find({}).toArray()
}

export async function createDossierAttachment(attachment) {
  await mongo.db.collection('dossier_attachments').insertOne(attachment)
}
