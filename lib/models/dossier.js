import {omit} from 'lodash-es'
import mongo from '../util/mongo.js'

const dossierDatatoOmit = [
  '__typename',
  'motivation',
  'motivationAttachment',
  'pdf',
  'groupeInstructeur',
  'demarche',
  'attestation',
  'champs',
  'connectionUsager'
]

export async function createDossier(data, files) {
  const dossierData = omit(data, dossierDatatoOmit)

  const dossier = {
    ...dossierData,
    champs: JSON.stringify(data.champs),
    files,
    prelevementType: data.champs.find(({label}) => label === 'Type de prélèvement')?.stringValue || 'unknown',
    createdAt: new Date(),
    updatedAt: new Date()
  }

  await mongo.db.collection('dossiers').insertOne(dossier)

  return dossier
}

export async function updateDossier(mongoId, data, files) {
  const dossierData = omit(data, dossierDatatoOmit)

  const dossier = {
    ...dossierData,
    champs: JSON.stringify(data.champs),
    files,
    updatedAt: new Date()
  }

  await mongo.db.collection('dossiers').updateOne({_id: mongoId}, {$set: dossier})

  return dossier
}

export function getDossier(dossierId) {
  return mongo.db.collection('dossiers').findOne({_id: dossierId})
}

export function getDossierByNumber(number) {
  return mongo.db.collection('dossiers').findOne({number})
}

export function getDossiers() {
  return mongo.db.collection('dossiers').find({}, {
    projection: {
      _id: 1,
      number: 1,
      dateDerniereModification: 1,
      state: 1,
      dateDepot: 1,
      files: 1,
      prelevementType: 1,
      demandeur: 1
    }
  }).toArray()
}

export async function getFileFromDossier(number, checksum) {
  const dossier = await getDossierByNumber(number)

  if (!dossier) {
    return null
  }

  return dossier.files.find(f => f.checksum === checksum) || null
}
