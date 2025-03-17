import {chain, uniq} from 'lodash-es'

import * as storage from './internal/in-memory.js'

import {getBeneficiairesFromPointId} from './beneficiaire.js'
import {getExploitationsFromPointId} from './exploitation.js'

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

export async function getStats() {
  const activExploitations = storage.exploitations.filter(e => e.statut === 'En activité')
  const activBeneficiaires = []
  const activPoints = []
  const activPointsSurface = []
  const activPointsSouterrain = []
  for (const e of activExploitations) {
    activBeneficiaires.push(e.id_beneficiaire)
    activPoints.push(e.id_point)
  }

  for (const p of activPoints) {
    if (storage.indexedPointsPrelevement[p].type_milieu === 'Eau de surface') {
      activPointsSurface.push(p)
    }

    if (storage.indexedPointsPrelevement[p].type_milieu === 'Eau souterraine') {
      activPointsSouterrain.push(p)
    }
  }

  const documentsWithNature = storage.documents.map(d => ({
    annee: d.date_signature.slice(0, 4),
    nature: d.nature,
    id: d.id_document
  }))

  return {
    documents: documentsWithNature,
    pointsCount: storage.pointsPrelevement.length,
    activExploitationsCount: activExploitations.length,
    activPointsPrelevementCount: uniq(activPoints).length,
    activBeneficiairesCount: uniq(activBeneficiaires).length,
    activPointsSurfaceCount: uniq(activPointsSurface).length,
    activPointsSouterrainCount: uniq(activPointsSouterrain).length
  }
}
