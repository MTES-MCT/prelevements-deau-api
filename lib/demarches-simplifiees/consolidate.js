/* eslint-disable no-await-in-loop */
import {chain} from 'lodash-es'

import * as Dossier from '../models/dossier.js'
import * as Preleveur from '../models/preleveur.js'
import {getTerritoires} from '../models/territoire.js'
import {getPointBySeqId} from '../models/point-prelevement.js'
import {getDailySeriesByDossier, getSeriesValues, updateSeriesComputed, updateSeriesIntegratedDays} from '../models/series.js'
import {insertIntegration, getIntegration} from '../models/integration-journaliere.js'

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

  // Récupération des séries journalières (nouvelle persistance normalisée)
  const dailySeries = await getDailySeriesByDossier(demarcheNumber, dossierNumber)

  const seriesByPoint = groupSeriesByPoint(dailySeries)
  for (const seqId of Object.keys(seriesByPoint)) {
    await processPointSeries({
      seqId,
      territoire,
      pointSeries: seriesByPoint[seqId],
      preleveur,
      dossier,
      demarcheNumber,
      result
    })
  }

  // Enrichissement des séries (toutes journalières du dossier) avec computed.* global (preleveur + dossierStatus)
  const seriesIds = dailySeries.map(s => s._id)
  if (seriesIds.length > 0) {
    await updateSeriesComputed(seriesIds, {
      preleveurId: preleveur?._id,
      dossierStatus: dossier.status
    })
  }

  await Dossier.updateDossier(
    demarcheNumber,
    dossierNumber,
    {result, consolidatedAt: new Date()}
  )
}

async function getRelatedTerritoire(demarcheNumber) {
  const territoires = await getTerritoires()
  const territoire = territoires.find(t => t.demarcheNumber === demarcheNumber)

  return territoire
}

function groupSeriesByPoint(series) {
  const seriesByPoint = {}
  for (const s of series) {
    if (!s.pointPrelevement) {
      continue
    }

    seriesByPoint[s.pointPrelevement] ||= []
    seriesByPoint[s.pointPrelevement].push(s)
  }

  return seriesByPoint
}

async function processPointSeries({seqId, territoire, pointSeries, preleveur, dossier, demarcheNumber, result}) {
  const pointPrelevement = await getPointBySeqId(territoire.code, seqId)

  if (!pointPrelevement) {
    console.log(`Point de prélèvement introuvable : ${seqId}`)
    result.notFoundPointPrelevements.push(seqId)
    return
  }

  result.foundPointPrelevements.push(seqId)

  // Enrichissement des séries de ce point avec computed.point et éventuellement preleveur/dossierStatus
  const seriesIds = pointSeries.map(s => s._id)
  await updateSeriesComputed(seriesIds, {
    pointId: pointPrelevement._id,
    preleveurId: preleveur?._id,
    dossierStatus: dossier.status
  })

  const {minDate: firstMin, maxDate: firstMax} = pointSeries[0]
  let minDate = firstMin
  let maxDate = firstMax
  for (const s of pointSeries) {
    if (s.minDate < minDate) {
      minDate = s.minDate
    }

    if (s.maxDate > maxDate) {
      maxDate = s.maxDate
    }
  }

  const dailyValuesIndex = {}
  for (const s of pointSeries) {
    const valueRows = await getSeriesValues(s._id)
    for (const row of valueRows) {
      const d = row.date
      dailyValuesIndex[d] ||= {date: d, values: {}}
      dailyValuesIndex[d].values[s.parameter] = row.values.value
    }
  }

  const dailyValues = Object.values(dailyValuesIndex).sort((a, b) => a.date.localeCompare(b.date))

  // Collecte des dates intégrées par série (toutes séries concernées partagent le même set de dates intégrées du point/dossier)
  const integratedDates = []
  for (const dailyValue of dailyValues) {
    result.acceptedEntryCount++
    const hasVolume = Object.hasOwn(dailyValue.values, 'volume prélevé')
    if (!hasVolume) {
      continue
    }

    // Idempotence garantie par index unique + upsert (via insertIntegration) mais on court-circuite lecture si déjà présent
    const existingIntegration = await getIntegration({preleveurId: preleveur._id, pointId: pointPrelevement._id}, dailyValue.date)
    if (existingIntegration) {
      continue
    }

    await insertIntegration(
      {preleveurId: preleveur._id, pointId: pointPrelevement._id},
      dailyValue.date,
      {demarcheNumber, dossierNumber: dossier.number, attachmentId: pointSeries[0].attachmentId}
    )

    integratedDates.push(dailyValue.date)
  }

  if (integratedDates.length > 0) {
    await updateSeriesIntegratedDays(seriesIds, integratedDates)
  }
}
