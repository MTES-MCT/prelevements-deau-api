import {uniq} from 'lodash-es'

import * as storage from './internal/in-memory.js'
import {usages} from '../nomenclature.js'

export async function getBeneficiairesFromPointId(idPoint) {
  return storage.exploitations
    .filter(e => e.id_point === idPoint)
    .map(exploitation => storage.indexedBeneficiaires[exploitation.id_beneficiaire])
}

export async function getBeneficiairesFromExploitationId(idExploitation) {
  return storage.beneficiaires.find(b => b.id_beneficiaire === idExploitation)
}

export async function getExploitationsFromPointId(idPoint) {
  return storage.exploitations
    .filter(e => e.id_point === idPoint)
    .map(originalExploitation => {
      const exploitation = {...originalExploitation}

      // Importation des règles dans exploitation
      exploitation.regles = storage.exploitationsRegles.filter(r => r.id_exploitation === exploitation.id_exploitation) || []
      exploitation.regles = exploitation.regles.map(r => (
        storage.regles.find(re => re.id_regle === r.id_regle)
      ))

      // Importation des documents dans les règles
      for (const r of exploitation.regles) {
        r.document = storage.documents.find(d => d.id_document === r.id_document) || []
      }

      // Importation des modalités dans exploitation
      exploitation.modalites = storage.exploitationModalites.filter(e => e.id_exploitation === exploitation.id_exploitation) || []
      exploitation.modalites = exploitation.modalites.map(m => (
        storage.modalitesSuivis.find(ms => ms.id_modalite === m.id_modalite)
      ))

      // Importations des usages dans exploitation
      exploitation.usage = storage.exploitationsUsage.find(u => u.id_exploitation === exploitation.id_exploitation).id_usage

      // Importation des séries dans exploitation
      exploitation.series = storage.exploitationsSerie.filter(e => e.id_exploitation === exploitation.id_exploitation) || []
      exploitation.series = exploitation.series.map(s => (
        storage.serieDonnees.find(sd => sd.id_serie === s.id_serie)
      ))

      // Importation des résultats de suivi dans les séries
      for (const s of exploitation.series) {
        s.resultats = storage.resultatsSuivi.filter(rs => rs.id_serie === s.id_serie) || []
      }

      return exploitation
    })
}

export async function getExploitation(idExploitation) {
  return storage.indexedExploitations[idExploitation]
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

export async function getBeneficiaire(idBeneficiaire) {
  return storage.indexedBeneficiaires[idBeneficiaire]
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
    const usagesWithDuplicates = exploitations.map(e => usages[e.usage])

    return ({
      ...point,
      beneficiaires: await getBeneficiairesFromPointId(point.id_point),
      exploitations,
      usages: uniq(usagesWithDuplicates),
      typeMilieu: point.type_milieu
    })
  }))

  return pointsPrelevement
}

export async function getPointPrelevement(idPoint) {
  const point = storage.indexedPointsPrelevement[idPoint]
  const exploitations = await getExploitationsFromPointId(idPoint)
  const usagesWithDuplicates = exploitations.map(e => usages[e.usage])

  return {
    ...point,
    beneficiaires: await getBeneficiairesFromPointId(idPoint),
    exploitations,
    usages: uniq(usagesWithDuplicates),
    typeMilieu: point.type_milieu
  }
}
