/* eslint-disable no-await-in-loop */
import {chain, omit, keyBy} from 'lodash-es'
import {gunzipSync} from 'node:zlib'
import hashObject from 'hash-object'

import * as Dossier from '../models/dossier.js'
import * as Preleveur from '../models/preleveur.js'
import {getTerritoires} from '../models/territoire.js'
import {getPointBySeqId} from '../models/point-prelevement.js'
import {insertSaisieJournaliere, getSaisiesJournalieres} from '../models/saisie-journaliere.js'

export async function consolidateDossiers() {
  const dossiers = await Dossier.getUnconsolidatedDossiers()

  for (const dossier of dossiers) {
    await consolidateDossier(dossier.demarcheNumber, dossier.number)
  }
}

async function findPreleveur(dossier) {
  return await Preleveur.getPreleveurByEmail(dossier.usager.email)
  || Preleveur.getPreleveurByEmail(dossier.declarant.email)
}

export async function consolidateDossier(demarcheNumber, dossierNumber) {
  console.log(`Consolidation du dossier ${demarcheNumber}/${dossierNumber}`)

  const dossier = await Dossier.getDossierByNumero(demarcheNumber, dossierNumber)

  if (!dossier) {
    throw new Error(`Dossier ${demarcheNumber}/${dossierNumber} non trouvé`)
  }

  const territoire = await getRelatedTerritoire(demarcheNumber)

  if (!territoire) {
    throw new Error(`Territoire non trouvé pour la démarche ${demarcheNumber}`)
  }

  const result = {}

  const preleveur = await findPreleveur(dossier)

  if (preleveur) {
    result.preleveur = preleveur._id
  }

  const attachments = await Dossier.getAttachments(demarcheNumber, dossierNumber)

  result.attachmentCount = attachments.length
  result.unprocessedAttachmentCount = attachments.filter(a => !a.processed).length
  result.unparsedAttachmentCount = attachments.filter(a => a.processed && !a.validationStatus).length
  result.parsedAttachmentCounts = chain(attachments)
    .filter(a => a.processed && a.validationStatus)
    .countBy('validationStatus')
    .value()

  result.foundPointPrelevements = []
  result.notFoundPointPrelevements = []
  result.otherSourceEntryCount = 0
  result.acceptedEntryCount = 0

  for (const attachment of attachments) {
    await processAttachmentSeries({attachment, territoire, dossier, preleveur, result})
  }

  await Dossier.updateDossier(
    demarcheNumber,
    dossierNumber,
    {result, consolidatedAt: new Date()}
  )
}

async function processAttachmentSeries({attachment, territoire, dossier, preleveur, result}) {
  const series = inflateSeries(attachment.result)
  if (!series) {
    return
  }

  const source = {
    demarcheNumber: territoire.demarcheNumber || attachment.demarcheNumber,
    dossierNumber: dossier.number,
    attachment: attachment._id
  }

  const sourceHash = hash(source)

  const dailySeries = series.filter(s => s.frequency === '1 day')

  const seriesByPoint = {}
  for (const s of dailySeries) {
    if (!s.pointPrelevement) {
      continue
    }

    seriesByPoint[s.pointPrelevement] ||= []
    seriesByPoint[s.pointPrelevement].push(s)
  }

  for (const seqId of Object.keys(seriesByPoint)) {
    const pointPrelevement = await getPointBySeqId(territoire.code, seqId)

    if (!pointPrelevement) {
      console.log(`Point de prélèvement introuvable : ${seqId}`)
      result.notFoundPointPrelevements.push(seqId)
      continue
    }

    result.foundPointPrelevements.push(seqId)

    const [first] = seriesByPoint[seqId]
    let {minDate, maxDate} = first

    for (const s of seriesByPoint[seqId]) {
      if (s.minDate < minDate) {
        minDate = s.minDate
      }

      if (s.maxDate > maxDate) {
        maxDate = s.maxDate
      }
    }

    const existingEntries = await getSaisiesJournalieres(
      {preleveurId: preleveur._id, pointId: pointPrelevement._id},
      {from: minDate, to: maxDate}
    )
    const indexedExistingEntries = keyBy(existingEntries, 'date')

    const dailyValuesIndex = {}
    for (const s of seriesByPoint[seqId]) {
      for (const row of s.data) {
        const d = row.date
        dailyValuesIndex[d] ||= {date: d, values: {}}
        dailyValuesIndex[d].values[s.parameter] = row.value
      }
    }

    const dailyValues = Object.values(dailyValuesIndex).sort((a, b) => a.date.localeCompare(b.date))

    for (const dailyValue of dailyValues) {
      const existingEntry = indexedExistingEntries[dailyValue.date]

      if (existingEntry && sourceHash !== existingEntry.sourceHash) {
        result.otherSourceEntryCount++
        continue
      }

      result.acceptedEntryCount++

      const data = omit(dailyValue, 'date')
      const dataHash = hash(data)

      if (!existingEntry || existingEntry.dataHash !== dataHash) {
        await insertSaisieJournaliere(
          {preleveurId: preleveur._id, pointId: pointPrelevement._id},
          dailyValue.date,
          {data, dataHash, source, sourceHash}
        )
      }
    }
  }
}

async function getRelatedTerritoire(demarcheNumber) {
  const territoires = await getTerritoires()
  const territoire = territoires.find(t => t.demarcheNumber === demarcheNumber)

  return territoire
}

function hash(object) {
  return hashObject(object, {algorithm: 'sha1'}).slice(0, 8)
}

function inflateSeries(result) {
  if (!result) {
    return null
  }

  if (result.series) {
    return result.series
  }

  if (result.payload) {
    try {
      const inflated = JSON.parse(gunzipSync(result.payload).toString('utf8'))
      return inflated.series || null
    } catch (error) {
      console.error('Erreur de décompression séries', error)
      return null
    }
  }

  return null
}
