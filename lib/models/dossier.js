import {pick} from 'lodash-es'
import mongo from '../util/mongo.js'

const dossierDataToPick = [
  'number',
  'state',
  'demandeur'
]

export async function createDossier(data, files) {
  const dossierData = pick(data, dossierDataToPick)

  const dossier = {
    ...dossierData,
    champs: JSON.stringify(data.champs),
    files,
    prelevementType: data.champs.find(({label}) => label === 'Type de prélèvement')?.stringValue || 'unknown'
  }

  await mongo.db.collection('dossiers').insertOne(dossier)

  return dossier
}

export async function updateDossier(mongoId, data, files) {
  const dossierData = pick(data, dossierDataToPick)

  const dossier = {
    ...dossierData,
    champs: JSON.stringify(data.champs),
    files
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
  return mongo.db.collection('dossiers').find({}, {projection: {champs: 0}}).toArray()
}

export async function getFileFromDossier(number, checksum) {
  const dossier = await getDossierByNumber(number)

  if (!dossier) {
    return null
  }

  return dossier.files.find(f => f.checksum === checksum) || null
}
