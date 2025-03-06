/* eslint-disable arrow-body-style */
import {uniq, memoize} from 'lodash-es'

import * as storage from './internal/in-memory.js'
import {usages} from '../nomenclature.js'
import {parseNomenclature} from '../../lib/models/internal/in-memory.js'

export async function getBeneficiairesFromPointId(idPoint) {
  return (storage.exploitationsIndexes.point[idPoint] || [])
    .map(exploitation => storage.indexedBeneficiaires[exploitation.id_beneficiaire])
}

export const getExploitationsFromPointId = memoize(idPoint => {
  return (storage.exploitationsIndexes.point[idPoint] || [])
    .map(originalExploitation => {
      const exploitation = {...originalExploitation}

      // Importation des règles dans exploitation
      exploitation.regles = storage.exploitationsRegles
        .filter(r => r.id_exploitation === exploitation.id_exploitation)
        .map(r => storage.indexedRegles[r.id_regle])

      // Importation des documents dans les règles
      for (const r of exploitation.regles) {
        r.document = storage.indexedDocuments[r.id_document]
      }

      exploitation.documents = storage.exploitationsDocuments
        .filter(ed => ed.id_exploitation === exploitation.id_exploitation)
        .map(ed => storage.indexedDocuments[ed.id_document])

      // Importation des modalités dans exploitation
      exploitation.modalites = storage.exploitationModalites
        .filter(e => e.id_exploitation === exploitation.id_exploitation) || []
        .map(m => (
          storage.modalitesSuivis.find(ms => ms.id_modalite === m.id_modalite)
        ))

      // Importations des usages dans exploitation
      exploitation.usage = storage.exploitationsUsage.find(u => u.id_exploitation === exploitation.id_exploitation).id_usage
      exploitation.usage = parseNomenclature(exploitation.usage, usages)

      // Importation des séries dans exploitation
      exploitation.series = storage.exploitationsSerie
        .filter(e => e.id_exploitation === exploitation.id_exploitation)
        .map(s => storage.indexedSeriesDonnees[s.id_serie])

      // Importation des résultats de suivi dans les séries
      for (const s of exploitation.series) {
        s.resultats = storage.resultatsSuivi[s.id_serie] || []
      }

      return exploitation
    })
})

export async function getExploitation(idExploitation) {
  return storage.indexedExploitations[idExploitation]
}

export async function getDocumentFromExploitationId(idExploitation) {
  return storage.exploitationsDocuments
    .filter(ed => ed.id_exploitation === idExploitation)
    .map(ed => storage.indexedDocuments[ed.id_document])
}

export async function getReglesFromExploitationId(idExploitation) {
  return storage.exploitationsRegles
    .filter(r => r.id_exploitation === idExploitation)
    .map(r => storage.indexedRegles[r.id_regle])
}

export async function getModalitesFromExploitationId(idExploitation) {
  return storage.exploitationModalites
    .filter(m => m.id_exploitation === idExploitation)
    .map(m => storage.indexedModalitesSuivis[m.id_modalite])
}

export async function getSeriesFromExploitationId(idExploitation) {
  return storage.exploitationsSerie
    .filter(s => s.id_exploitation === idExploitation)
    .map(s => storage.indexedSeriesDonnees[s.id_serie])
}

export async function getBeneficiaireExploitations(idBeneficiaire) {
  return storage.exploitations
    .filter(e => e.id_beneficiaire === idBeneficiaire)
    .map(exploitation => {
      const usage = storage.exploitationsUsage.find(u => u.id_exploitation === exploitation.id_exploitation)
      return {
        ...exploitation,
        usage: parseNomenclature(usage.id_usage, usages)
      }
    })
}

// Récupérer les usages de chaque exploitation
export function getUsagesFromExploitations(exploitations) {
  const usagesFromExploitations = exploitations.map(e => {
    const usageEntry = storage.exploitationsUsage.find(u => u.id_exploitation === e.id_exploitation)
    return parseNomenclature(usageEntry.id_usage, usages)
  })

  return uniq(usagesFromExploitations)
}

export async function getBeneficiaire(idBeneficiaire) {
  const beneficiaire = storage.indexedBeneficiaires[idBeneficiaire]
  const exploitations = await getBeneficiaireExploitations(idBeneficiaire)
  const usages = getUsagesFromExploitations(exploitations)

  return {
    ...beneficiaire,
    exploitations,
    usages
  }
}

export async function getBeneficiaires() {
  return Promise.all(storage.beneficiaires.map(b => getBeneficiaire(b.id_beneficiaire)))
}

export async function getRegle(idRegle) {
  return storage.indexedRegles[idRegle]
}

export async function getDocument(idDocument) {
  return storage.indexedDocuments[idDocument]
}

export async function getResultatsFromSerieId(idSerie) {
  return storage.resultatsSuivi
    .filter(rs => rs.id_serie === idSerie)
}

export async function getDocumentFromRegleId(idRegle) {
  const regle = storage.indexedRegles[idRegle]
  return storage.indexedDocuments[regle.id_document]
}

export async function getPointsPrelevement() {
  const pointsPrelevement = await Promise.all(storage.pointsPrelevement.map(async point => {
    const exploitations = await getExploitationsFromPointId(point.id_point)
    const usagesWithDuplicates = exploitations.map(e => e.usage)

    return ({
      ...point,
      beneficiaires: await getBeneficiairesFromPointId(point.id_point),
      exploitationsStatus: exploitations.at(-1).statut,
      exploitationsStartDate: exploitations[0].date_debut,
      usages: uniq(usagesWithDuplicates)
    })
  }))

  return pointsPrelevement
}

export async function getPointPrelevement(idPoint) {
  const point = storage.indexedPointsPrelevement[idPoint]
  const exploitations = await getExploitationsFromPointId(idPoint)
  const usagesWithDuplicates = exploitations.map(e => usages[e.usage])
  const meContinentalesBv = storage.indexedMeContinentalesBv[point.code_me_continentales_bv]
  const bvBdCarthage = storage.indexedBvBdCarthage[point.code_bv_bdcarthage]
  const meso = storage.indexedMeso[point.code_meso]

  return {
    ...point,
    beneficiaires: await getBeneficiairesFromPointId(idPoint),
    exploitations,
    usages: uniq(usagesWithDuplicates),
    typeMilieu: point?.type_milieu,
    meContinentalesBv,
    bvBdCarthage,
    meso
  }
}

export async function getPointsFromBeneficiaire(idBeneficiaire) {
  const exploitations = storage.exploitations.filter(e => e.id_beneficiaire === idBeneficiaire)
  const pointsPromises = exploitations.map(e => getPointPrelevement(e.id_point))
  const points = await Promise.all(pointsPromises)

  return points
}

export async function getBssById(idBss) {
  return storage.indexedBss[idBss]
}

export async function getBnpe(id) {
  return storage.indexedBnpe[id]
}

export async function getCommune(codeInsee) {
  return storage.indexedLibellesCommunes[codeInsee]
}
