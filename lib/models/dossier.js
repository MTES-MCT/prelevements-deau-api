import {omit} from 'lodash-es'
import mongo from '../util/mongo.js'

const demarcheRevisionIdToTag = {
  UHJvY2VkdXJlUmV2aXNpb24tMTM1NTYw: 'v1',
  UHJvY2VkdXJlUmV2aXNpb24tMTQyMzY1: 'v2',
  UHJvY2VkdXJlUmV2aXNpb24tMTM1NjUw: 'v3',
  UHJvY2VkdXJlUmV2aXNpb24tMTQxNzU3: 'v4',
  UHJvY2VkdXJlUmV2aXNpb24tMTQwOTIw: 'v5',
  UHJvY2VkdXJlUmV2aXNpb24tMTQ5Njc1: 'v6',
  UHJvY2VkdXJlUmV2aXNpb24tMTU1Njg4: 'v7',
  UHJvY2VkdXJlUmV2aXNpb24tMTQ5MDQy: 'v8',
  UHJvY2VkdXJlUmV2aXNpb24tMTUyOTA5: 'v9',
  UHJvY2VkdXJlUmV2aXNpb24tMTQ4NTQ0: 'v10',
  UHJvY2VkdXJlUmV2aXNpb24tMTUwOTEw: 'v11',
  UHJvY2VkdXJlUmV2aXNpb24tMTQ4NDU4: 'v12',
  UHJvY2VkdXJlUmV2aXNpb24tMTQ5Njcz: 'v13',
  UHJvY2VkdXJlUmV2aXNpb24tMTQ4NjY5: 'v14',
  UHJvY2VkdXJlUmV2aXNpb24tMTUwMjE0: 'v15',
  UHJvY2VkdXJlUmV2aXNpb24tMTU5MDkz: 'v16',
  UHJvY2VkdXJlUmV2aXNpb24tMTUxMzk2: 'v17'
}

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

export async function createDossier(data, files, isValid) {
  const dossierData = omit(data, dossierDatatoOmit)

  const dossier = {
    ...dossierData,
    demarcheVersion: demarcheRevisionIdToTag[data.demarche.revision.id] || 'unknown',
    champs: JSON.stringify(data.champs),
    isValid,
    files,
    prelevementType: data.champs.find(({label}) => label === 'Type de prélèvement')?.stringValue || 'unknown',
    createdAt: new Date(),
    updatedAt: new Date()
  }

  await mongo.db.collection('dossiers').insertOne(dossier)

  return dossier
}

export async function updateDossier(mongoId, data, files, isValid) {
  const dossierData = omit(data, dossierDatatoOmit)

  const dossier = {
    ...dossierData,
    demarcheVersion: demarcheRevisionIdToTag[data.demarche.revision.id] || 'unknown',
    champs: JSON.stringify(data.champs),
    isValid,
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
      demandeur: 1,
      isValid: 1
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
