import {chain, uniq} from 'lodash-es'

import * as storage from './internal/in-memory.js'
import {usages} from '../nomenclature.js'

import {getBeneficiairesFromPointId} from './beneficiaire.js'
import {getExploitationsFromPointId} from './exploitation.js'

export async function getResultatsFromSerieId(idSerie) {
  return storage.resultatsSuivi
    .filter(rs => rs.id_serie === idSerie)
}

export async function getPointsPrelevement() {
  const pointsPrelevement = await Promise.all(storage.pointsPrelevement.map(async point => {
    const exploitations = await getExploitationsFromPointId(point.id_point)

    return ({
      ...point,
      beneficiaires: await getBeneficiairesFromPointId(point.id_point),
      exploitationsStatus: exploitations.at(-1).statut,
      exploitationsStartDate: exploitations[0].date_debut,
      usages: chain(exploitations).map('usages').flatten().uniq().value()
    })
  }))

  return pointsPrelevement
}

export async function getPointPrelevement(idPoint) {
  const point = storage.indexedPointsPrelevement[idPoint]
  const exploitations = await getExploitationsFromPointId(idPoint)
  const meContinentalesBv = storage.indexedMeContinentalesBv[point.code_me_continentales_bv]
  const bvBdCarthage = storage.indexedBvBdCarthage[point.code_bv_bdcarthage]
  const meso = storage.indexedMeso[point.code_meso]

  return {
    ...point,
    beneficiaires: await getBeneficiairesFromPointId(idPoint),
    exploitations,
    usages: chain(exploitations).map('usages').flatten().uniq().value(),
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

export async function getSeriesFromExploitationId(idExploitation) {
  return storage.exploitationsSerie
    .filter(s => s.id_exploitation === idExploitation)
    .map(s => storage.indexedSeriesDonnees[s.id_serie])
}
