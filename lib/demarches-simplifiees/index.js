import 'dotenv/config'

import process from 'node:process'

import got from 'got'
import pLimit from 'p-limit'
import {startOfMonth, endOfMonth} from 'date-fns'
import {utc} from '@date-fns/utc'
import {hashSync} from 'hasha'
import {omit} from 'lodash-es'

import {uploadObject} from '../util/s3.js'

import * as Dossier from '../models/dossier.js'
import {insertVolumesPreleves} from '../models/volume-preleve.js'
import {getPreleveurByEmail} from '../models/preleveurs.js.js'
import {getMatchingExploitation} from '../models/exploitation.js'

import {validateCamionCiterneFile} from '../input-datasets/camion-citerne/index.js'
import {validateMultiParamFile} from '../input-datasets/multi-params/index.js'

import {extractDossier} from './extract.js'

import {fetchData} from './graphql/request.js'

const demarcheNumber = Number.parseInt(process.env.DS_DEMARCHE_NUMBER, 10)

function isSheet(file) {
  const lcFilename = file.filename.toLowerCase()
  return lcFilename.endsWith('.xlsx') || lcFilename.endsWith('.xls') || lcFilename.endsWith('.ods')
}

async function handleNewFile(file, context) {
  const {dossier} = context

  const objectKey = `dossier/${dossier.numero}/${file.checksum}/${file.filename}`
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

  const periodBounds = computePeriodBounds(dossier)

  if (isSheetFile && dossier.typePrelevement === 'camion-citerne') {
    attachment.errors = await validateCamionCiterneFile(buffer, periodBounds)
  }

  if (isSheetFile && dossier.typePrelevement === 'aep-zre') {
    const {data, errors} = await validateMultiParamFile(buffer, periodBounds)
    await experimentalHandleData(data, context)
    attachment.errors = errors
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

async function handleFile(file, context) {
  const {attachmentsCollector, applyLimit} = context

  file.checksum = normalizeChecksum(file.checksum)

  return applyLimit(async () => {
    const attachment = attachmentsCollector.find(a => a.checksum === file.checksum)
    if (attachment) {
      return omit(attachment, 'errors')
    }

    const newAttachment = await handleNewFile(file, context)
    attachmentsCollector.push(newAttachment)
    return omit(attachment, 'errors')
  })
}

async function experimentalHandleData(data, context) {
  try {
    const {dossier, pointsPrelevements, periodBounds} = context

    if (pointsPrelevements.length !== 1) {
      throw new Error('Le fichier ne contient pas exactement un point de prélèvement')
    }

    const preleveur = await getPreleveurByEmail(dossier.declarant.email || dossier.usager.email)

    const exploitation = await getMatchingExploitation(pointsPrelevements[0], {
      idPreleveur: preleveur?.id_preleveur,
      dateValidite: periodBounds?.startDate
    })

    if (!exploitation) {
      throw new Error('Exploitation non trouvée')
    }

    const volumesPreleves = data?.dataTabs.find(tab => tab.period === '1 jour')?.parameters?.find(p => p.nom_parametre === 'volume prélevé')

    if (!volumesPreleves) {
      throw new Error('Volumes prélevés non trouvés')
    }

    await insertVolumesPreleves(exploitation.id_exploitation, volumesPreleves.rows.map(row => ({
      date: row.date,
      volume: row.valeur,
      remarque: row.remarque
    })))

    const totalVolumePreleve = volumesPreleves.rows
      .reduce((acc, row) => acc + row.valeur, 0)

    console.log(`Point de prélèvement : ${data.metadata.pointPrelevement} | Volume prélevé : ${totalVolumePreleve.toFixed(0)} m3`)
  } catch (error) {
    console.log('Erreur lors du traitement des données', error)
  }
}

// Fonction pour traiter un dossier individuel
export async function processRawDossier(rawDossier) {
  const dossier = extractDossier(rawDossier)

  const attachments = await Dossier.getDossierAttachments(dossier.numero)
  const applyLimit = pLimit(1)

  const baseContext = {attachmentsCollector: attachments, applyLimit, dossier}

  dossier.registrePrelevementsTableur &&= await handleFile(dossier.registrePrelevementsTableur, baseContext)

  dossier.tableauSuiviPrelevements &&= await handleFile(dossier.tableauSuiviPrelevements, baseContext)

  dossier.donneesPrelevements &&= await Promise.all(dossier.donneesPrelevements.map(async d => {
    const context = {...baseContext, pointsPrelevements: d.pointsPrelevements}

    d.fichier &&= await handleFile(d.fichier, context)
    d.documentAnnexe &&= await handleFile(d.documentAnnexe, context)
    return d
  }))

  dossier.extraitsRegistrePapier &&= await Promise.all(dossier.extraitsRegistrePapier.map(async e => {
    e.fichier &&= await handleFile(e.fichier, baseContext)
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

function computePeriodBounds(dossier) {
  const startDate = dossier.moisDebutDeclaration || dossier.moisDeclaration
  const endDate = dossier.moisFinDeclaration || dossier.moisDeclaration

  if (!startDate || !endDate) {
    return {}
  }

  return {
    startDate: startOfMonth(new Date(`${startDate}-15T00:00:00.000Z`), {in: utc})
      .toISOString().slice(0, 10),
    endDate: endOfMonth(new Date(`${endDate}-15T00:00:00.000Z`), {in: utc})
      .toISOString().slice(0, 10)
  }
}

function normalizeChecksum(checksum) {
  return hashSync(checksum).slice(0, 16)
}
