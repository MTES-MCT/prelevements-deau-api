/* eslint-disable no-await-in-loop */
import {chain, omit, keyBy, zipObject} from 'lodash-es'
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
    if (!attachment.result?.data) {
      continue
    }

    const source = {
      demarcheNumber,
      dossierNumber: dossier.number,
      attachment: attachment._id
    }

    const sourceHash = hash(source)

    const points = Array.isArray(attachment.result.data) ? attachment.result.data : [attachment.result.data]

    for (const p of points) {
      if (!p.pointPrelevement) {
        continue
      }

      const pointPrelevement = await getPointBySeqId(territoire.code, p.pointPrelevement)

      if (!pointPrelevement) {
        console.log(`Point de prélèvement introuvable : ${p.pointPrelevement}`)
        result.notFoundPointPrelevements.push(p.pointPrelevement)
        continue
      }

      result.foundPointPrelevements.push(p.pointPrelevement)

      const existingEntries = await getSaisiesJournalieres(
        {preleveurId: preleveur._id, pointId: pointPrelevement._id},
        {from: p.minDate, to: p.maxDate}
      )

      const indexedExistingEntries = keyBy(existingEntries, 'date')

      const dailyValues = prepareData(p)

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

  await Dossier.updateDossier(
    demarcheNumber,
    dossierNumber,
    {result, consolidatedAt: new Date()}
  )
}

function compactData(values, parameters) {
  return zipObject(
    parameters.map(p => p.nom_parametre),
    values
  )
}

function prepareData(point) {
  const {dailyParameters, fifteenMinutesParameters, dailyValues} = point

  return dailyValues.map(raw => {
    const prepared = {
      date: raw.date,
      values: compactData(raw.values, dailyParameters)
    }

    if (raw.fifteenMinutesValues) {
      prepared.fifteenMinutesValues = raw.fifteenMinutesValues.map(({heure, values}) => ({
        heure,
        values: compactData(values, fifteenMinutesParameters)
      }))
    }

    return prepared
  })
}

async function getRelatedTerritoire(demarcheNumber) {
  const territoires = await getTerritoires()
  const territoire = territoires.find(t => t.demarcheNumber === demarcheNumber)

  return territoire
}

function hash(object) {
  return hashObject(object, {algorithm: 'sha1'}).slice(0, 8)
}
