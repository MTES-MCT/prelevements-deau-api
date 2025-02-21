import 'dotenv/config'

import process from 'node:process'

import got from 'got'
import pLimit from 'p-limit'
import {startOfMonth, endOfMonth} from 'date-fns'

import {uploadObject} from '../util/s3.js'
import * as Dossier from '../models/dossier.js'

import {extractDossier} from './extract.js'
import validateCamionCiterneFile from './suivi-camion-citerne.js'
import validateMultiParamFile from './suivi-multi-params.js'

import {fetchData} from './graphql/request.js'

const demarcheNumber = Number.parseInt(process.env.DS_DEMARCHE_NUMBER, 10)

function isSheet(file) {
  const lcFilename = file.filename.toLowerCase()
  return lcFilename.endsWith('.xlsx') || lcFilename.endsWith('.xls') || lcFilename.endsWith('.ods')
}

async function handleNewFile(dossier, file) {
  const objectKey = `dossier/${dossier.numero}/${file.checksum.slice(0, 7)}/${file.filename}`
  const buffer = await got(file.url).buffer()
  await uploadObject(objectKey, buffer)

  const attachment = {
    numeroDossier: dossier.numero,
    filename: file.filename,
    contentType: file.contentType,
    checksum: file.checksum,
    objectKey
  }

  const isSheetFile = isSheet(file)

  const periodBounds = {
    startDate: startOfMonth((dossier.moisDebutDeclaration || dossier.moisDeclaration) + '-15'),
    endDate: endOfMonth((dossier.moisFinDeclaration || dossier.moisDeclaration) + '-15')
  }

  if (isSheetFile && dossier.typePrelevement === 'camion-citerne') {
    attachment.errors = await validateCamionCiterneFile(buffer, periodBounds)
  }

  if (isSheetFile && dossier.typePrelevement === 'aep-zre') {
    attachment.errors = await validateMultiParamFile(buffer, periodBounds)
  }

  if (attachment.errors?.length > 50) {
    attachment.errors = attachment.errors.slice(0, 50)
    attachment.errors.push({
      message: 'Le fichier contient plus de 50 erreurs. Les erreurs suivantes n’ont pas été affichées.'
    })
  }

  await Dossier.createDossierAttachment(attachment)
  return attachment
}

async function handleFile(dossier, file, attachmentsCollector, applyLimit) {
  return applyLimit(async () => {
    const attachment = attachmentsCollector.find(a => a.checksum === file.checksum)
    if (attachment) {
      return attachment
    }

    const newAttachment = await handleNewFile(dossier, file)
    attachmentsCollector.push(newAttachment)
    return newAttachment
  })
}

// Fonction pour traiter un dossier individuel
export async function processRawDossier(rawDossier) {
  const dossier = extractDossier(rawDossier)

  const attachments = await Dossier.getDossierAttachments(dossier.numero)
  const applyLimit = pLimit(1)

  dossier.registrePrelevementsTableur &&= await handleFile(dossier, dossier.registrePrelevementsTableur, attachments, applyLimit)

  dossier.tableauSuiviPrelevements &&= await handleFile(dossier, dossier.tableauSuiviPrelevements, attachments, applyLimit)

  dossier.donneesPrelevements &&= await Promise.all(dossier.donneesPrelevements.map(async d => {
    d.fichier &&= await handleFile(dossier, d.fichier, attachments, applyLimit)
    d.documentAnnexe &&= await handleFile(dossier, d.documentAnnexe, attachments, applyLimit)
    return d
  }))

  dossier.extraitsRegistrePapier &&= await Promise.all(dossier.extraitsRegistrePapier.map(async e => {
    e.fichier &&= await handleFile(dossier, e.fichier, attachments, applyLimit)
    return e
  }))

  dossier.errorsCount = attachments.reduce((acc, a) => acc + (a.errors?.length || 0), 0)

  // Sauvegarde du dossier
  await Dossier.upsertDossier(dossier)
}

export async function * fetchDossiersGenerator({includeChamps = true, cursor = null} = {}) {
  const variables = {
    demarcheNumber,
    first: 100,
    includeDossiers: true,
    includeChamps
  }

  if (cursor) {
    variables.after = cursor
  }

  const {demarche: {dossiers}} = await fetchData('getDemarche', variables)

  for (const dossier of dossiers.nodes) {
    yield dossier
  }

  if (dossiers.pageInfo.hasNextPage) {
    yield * fetchDossiersGenerator({includeChamps, cursor: dossiers.pageInfo.endCursor})
  }
}

export async function processAllDossiers() {
  console.log(`Traitement des dossiers pour la démarche ${demarcheNumber}...`)

  for await (const rawDossier of fetchDossiersGenerator({includeChamps: true})) {
    if (['en_instruction', 'accepte'].includes(rawDossier.state)) {
      try {
        console.log(`Traitement du dossier ${rawDossier.number}:`)
        await processRawDossier(rawDossier)
      } catch (error) {
        console.error(`Erreur lors du traitement du dossier ${rawDossier.number}:`, error)
      }
    }
  }
}
