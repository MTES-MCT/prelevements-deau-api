import {Buffer} from 'node:buffer'

export async function readDatabase(s3, demarcheNumber) {
  const objectKey = getDatabaseObjectKey(demarcheNumber)
  const buffer = await s3.downloadObject(objectKey)
  return JSON.parse(buffer.toString('utf8'))
}

export async function writeDatabase(s3, demarcheNumber, database) {
  const objectKey = getDatabaseObjectKey(demarcheNumber)
  const buffer = Buffer.from(JSON.stringify(database), 'utf8')
  await s3.uploadObject(objectKey, buffer)
}

function getDatabaseObjectKey(demarcheNumber) {
  return `demarche-${demarcheNumber}/database.json`
}

export async function readDossier(s3, demarcheNumber, dossierNumber) {
  const objectKey = getDossierObjectKey(demarcheNumber, dossierNumber)
  const buffer = await s3.downloadObject(objectKey)
  return JSON.parse(buffer.toString('utf8'))
}

export function writeDossier(s3, demarcheNumber, dossier) {
  const objectKey = getDossierObjectKey(demarcheNumber, dossier.number)
  const buffer = Buffer.from(JSON.stringify(dossier), 'utf8')
  return s3.uploadObject(objectKey, buffer)
}

function getDossierObjectKey(demarcheNumber, dossierNumber) {
  return `demarche-${demarcheNumber}/dossiers/${dossierNumber}/dossier.json`
}
