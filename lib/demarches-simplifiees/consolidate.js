/* eslint-disable no-await-in-loop */
import {groupBy} from 'lodash-es'

import * as Dossier from '../models/dossier.js'
import * as Preleveur from '../models/preleveur.js'
import {getTerritoires} from '../models/territoire.js'
import {getPointBySeqId} from '../models/point-prelevement.js'
import {getSeriesByDossier, getSeriesValues, updateSeriesComputed, updateSeriesIntegratedDays} from '../models/series.js'
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

  // Liens vers le préleveur
  const preleveur = await findPreleveur(dossier)

  if (preleveur) {
    result.preleveur = preleveur._id
  }

  // Stats sur les pièces jointes
  const attachments = await Dossier.getAttachments(demarcheNumber, dossierNumber)
  const attachmentStats = computeAttachmentsStats(attachments)
  Object.assign(result, attachmentStats)

  // Stats sur les séries
  result.foundPointPrelevements = []
  result.notFoundPointPrelevements = []
  result.acceptedDaysCount = 0

  const series = await getSeriesByDossier(demarcheNumber, dossierNumber)

  const seriesByPoint = groupBy(series, 'pointPrelevement')
  for (const key of Object.keys(seriesByPoint)) {
    const seqId = Number.parseInt(key, 10) // L'utilisation de groupBy convertit les clés en string automatiquement
    const pointPrelevement = await getPointBySeqId(territoire.code, seqId)

    if (!pointPrelevement) {
      console.log(`Point de prélèvement introuvable : ${seqId}`)
      result.notFoundPointPrelevements.push(seqId)
      continue
    }

    result.foundPointPrelevements.push(seqId)

    const {acceptedDaysCount} = await processPointSeries({
      pointId: pointPrelevement._id,
      pointSeries: seriesByPoint[seqId],
      preleveur,
      dossier
    })

    result.acceptedDaysCount += acceptedDaysCount
  }

  // Enrichissement systématique des séries du dossier (preleveur + dossierStatus)
  const seriesIds = series.map(s => s._id)
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

async function processPointSeries({pointId, pointSeries, preleveur, dossier}) {
  // Nouveau résultat : acceptedDaysCount = nombre total de jours effectivement intégrés (toutes pièces jointes du point)
  const result = {status: 'found', acceptedDaysCount: 0}

  // 1. Grouper les séries du point par pièce jointe
  // (groupBy ne convient pas directement car attachmentId est un ObjectId -> risque de clé '[object Object]')
  const attachmentsMap = new Map() // Key: attachmentId.toString() | 'null' ; value: {id: ObjectId|null, series: []}
  for (const s of pointSeries) {
    const key = s.attachmentId ? s.attachmentId.toString() : 'null'
    let entry = attachmentsMap.get(key)
    if (!entry) {
      entry = {id: s.attachmentId || null, series: []}
      attachmentsMap.set(key, entry)
    }

    entry.series.push(s)
  }

  // 2. Pour chaque pièce jointe (itération séquentielle)
  for (const {id: attachmentId, series: attachmentSeries} of attachmentsMap.values()) {
    const attachmentSeriesIds = attachmentSeries.map(s => s._id)

    // Enrichissement computed.point / preleveur / dossierStatus pour toutes les séries de la PJ
    await updateSeriesComputed(attachmentSeriesIds, {
      pointId,
      preleveurId: preleveur?._id,
      dossierStatus: dossier.status
    })

    // 3. Recherche de la série des volumes prélevés en fréquence 1 jour
    const volumeSeries = attachmentSeries.find(s => s.parameter === 'volume prélevé' && s.frequency === '1 day')
    if (!volumeSeries) {
      // Pas de série volume => aucune intégration pour cette PJ, on passe à la suivante
      continue
    }

    // 4. Récupérer les valeurs journalières de la série volume seulement
    const volumeRows = await getSeriesValues(volumeSeries._id)

    // 5. Intégrer les jours si possible (idempotent via getIntegration / insertIntegration)
    const integratedDates = []
    for (const row of volumeRows) {
      const day = row.date
      // Vérifie si déjà intégré
      const existingIntegration = await getIntegration({preleveurId: preleveur._id, pointId}, day)
      if (existingIntegration) {
        continue
      }

      await insertIntegration(
        {preleveurId: preleveur._id, pointId},
        day,
        {demarcheNumber: dossier.demarcheNumber, dossierNumber: dossier.number, attachmentId}
      )

      integratedDates.push(day)
    }

    if (integratedDates.length === 0) {
      continue // Rien de nouveau à propager aux séries de la PJ
    }

    // 6. Pour chaque série de la PJ : ne rattacher que les jours intégrés compatibles avec sa plage min/max
    // updateSeriesIntegratedDays applique les dates à toutes les séries passées: il faut donc l'appeler par série
    for (const s of attachmentSeries) {
      const filtered = integratedDates.filter(d => d >= s.minDate && d <= s.maxDate)
      if (filtered.length > 0) {
        await updateSeriesIntegratedDays([s._id], filtered)
      }
    }

    // Mettre à jour le compteur global de jours effectivement intégrés
    result.acceptedDaysCount += integratedDates.length
  }

  return result
}

function computeAttachmentsStats(attachments) {
  const stats = {
    attachmentCount: attachments.length,
    unprocessedAttachmentCount: 0,
    unparsedAttachmentCount: 0,
    parsedAttachmentCounts: {}
  }

  for (const a of attachments) {
    if (!a.processed) {
      stats.unprocessedAttachmentCount++
    } else if (a.processed && !a.validationStatus) {
      stats.unparsedAttachmentCount++
    } else if (a.processed && a.validationStatus) {
      stats.parsedAttachmentCounts[a.validationStatus] ||= 0
      stats.parsedAttachmentCounts[a.validationStatus]++
    }
  }

  return stats
}
