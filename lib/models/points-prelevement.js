import {uniq} from 'lodash-es'

import * as storage from './internal/in-memory.js'
import {usages} from '../nomenclature.js'

export async function getBeneficiairesFromPoint(idPoint) {
  return storage.exploitations
    .filter(e => e.id_point === idPoint)
    .map(exploitation => storage.indexedBeneficiaires[exploitation.id_beneficiaire])
}

export async function getBeneficiaireFromExploitationId(idExploitation) {
  return storage.beneficiaires.find(b => b.id_beneficiaire === idExploitation)
}

export async function getExploitationsFromPoint(idPoint) {
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

export async function getBeneficiaire(idBeneficiaire) {
  return storage.indexedBeneficiaires[idBeneficiaire]
}

export async function getRegle(idRegle) {
  return storage.indexedRegles[idRegle]
}

export async function getDocument(idDocument) {
  return storage.indexedDocuments[idDocument]
}

export async function getPointsPrelevement() {
  const pointsPrelevement = await Promise.all(storage.pointsPrelevement.map(async point => {
    const exploitations = await getExploitationsFromPoint(point.id_point)
    const usagesWithDuplicates = exploitations.map(e => usages[e.usage])

    return ({
      ...point,
      beneficiaires: await getBeneficiairesFromPoint(point.id_point),
      exploitations,
      usages: uniq(usagesWithDuplicates),
      typeMilieu: point.type_milieu
    })
  }))

  return pointsPrelevement
}

export async function getPointPrelevement(idPoint) {
  const point = storage.indexedPointsPrelevement[idPoint]
  const exploitations = await getExploitationsFromPoint(idPoint)
  const usagesWithDuplicates = exploitations.map(e => usages[e.usage])

  return {
    ...point,
    beneficiaires: await getBeneficiairesFromPoint(idPoint),
    exploitations,
    usages: uniq(usagesWithDuplicates),
    typeMilieu: point.type_milieu
  }
}
