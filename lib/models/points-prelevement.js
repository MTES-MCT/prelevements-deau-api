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
  // Fonctions pour récupérer les stats "Régularisations"
  function getActiveDocuments() {
    const today = new Date()
    const activeDocuments = storage.documents.filter(doc => !doc.date_fin_validite || new Date(doc.date_fin_validite) >= today)
    return activeDocuments
  }

  function createBilan() {
    const activeDocuments = getActiveDocuments()
    const bilanMap = new Map()

    for (const e of storage.exploitations) {
      if (e.statut === 'En activité' || e.statut === 'Non renseigné') {
        const {id_exploitation} = e
        const {id_point} = e
        const point = storage.pointsPrelevement.find(p => p.id_point === id_point)

        if (point) {
          const liste_usages = new Set()
          const liste_nature_document = new Set()

          for (const eu of storage.exploitationsUsage) {
            if (eu.id_exploitation === id_exploitation) {
              liste_usages.add(eu.id_usage)
            }
          }

          for (const ed of storage.exploitationsDocuments) {
            if (ed.id_exploitation === id_exploitation) {
              const doc = activeDocuments.find(d => d.id_document === ed.id_document)
              if (doc) {
                liste_nature_document.add(doc.nature)
              }
            }
          }

          bilanMap.set(id_exploitation, {
            id_exploitation,
            id_point,
            nom: point.nom,
            liste_usages: [...liste_usages].join(','),
            liste_nature_document: [...liste_nature_document].join(',')
          })
        }
      }
    }

    const bilan = [...bilanMap.values()]

    return bilan
  }

  function countExploitations(bilan, criteria) {
    const exploitationsSet = new Set()
    for (const b of bilan) {
      if (criteria(b)) {
        exploitationsSet.add(b.id_exploitation)
      }
    }

    return exploitationsSet.size
  }

  function getRegularisations() {
    const bilan = createBilan()
    const results = []

    // CSP
    const csp = {
      regime: 'CSP',
      nb_exploitations_concernees: countExploitations(bilan, b => b.liste_usages.split(',').includes('1')),
      nb_exploitations_autorisees: countExploitations(bilan, b => b.liste_nature_document.split(',').includes('Autorisation CSP') || b.liste_nature_document.split(',').includes('Autorisation CSP - IOTA')),
      nb_exploitations_non_autorisees: countExploitations(bilan, b => b.liste_usages.split(',').includes('1')) - countExploitations(bilan, b => b.liste_nature_document.split(',').includes('Autorisation CSP') || b.liste_nature_document.split(',').includes('Autorisation CSP - IOTA'))
    }

    // Hydroélectricité
    const hydroelectricite = {
      regime: 'Hydroélectricité',
      nb_exploitations_concernees: countExploitations(bilan, b => b.liste_usages.split(',').includes('6')),
      nb_exploitations_autorisees: countExploitations(bilan, b => b.liste_nature_document.split(',').includes('Autorisation hydroélectricité')),
      nb_exploitations_non_autorisees: countExploitations(bilan, b => b.liste_usages.split(',').includes('6')) - countExploitations(bilan, b => b.liste_nature_document.split(',').includes('Autorisation hydroélectricité'))
    }

    // ICPE
    const icpe = {
      regime: 'ICPE',
      nb_exploitations_concernees: countExploitations(bilan, b => b.liste_usages.split(',').includes('5') || b.liste_usages.split(',').includes('7') || b.liste_usages.split(',').includes('9')),
      nb_exploitations_autorisees: countExploitations(bilan, b => b.liste_nature_document.split(',').includes('Autorisation ICPE')),
      nb_exploitations_non_autorisees: countExploitations(bilan, b => b.liste_usages.split(',').includes('5') || b.liste_usages.split(',').includes('7') || b.liste_usages.split(',').includes('9')) - countExploitations(bilan, b => b.liste_nature_document.split(',').includes('Autorisation ICPE'))
    }

    // AOT
    const aot = {
      regime: 'AOT',
      nb_exploitations_concernees: countExploitations(bilan, () => true),
      nb_exploitations_autorisees: countExploitations(bilan, b => b.liste_nature_document.split(',').includes('Autorisation AOT')),
      nb_exploitations_non_autorisees: countExploitations(bilan, () => true) - countExploitations(bilan, b => b.liste_nature_document.split(',').includes('Autorisation AOT'))
    }

    // IOTA
    const iota = {
      regime: 'IOTA',
      nb_exploitations_concernees: countExploitations(bilan, b => b.liste_usages.split(',').includes('1') || b.liste_usages.split(',').includes('2') || b.liste_usages.split(',').includes('3') || b.liste_usages.split(',').includes('8')),
      nb_exploitations_autorisees: countExploitations(bilan, b => b.liste_nature_document.split(',').includes('Autorisation CSP - IOTA') || b.liste_nature_document.split(',').includes('Autorisation IOTA')),
      nb_exploitations_non_autorisees: countExploitations(bilan, b => b.liste_usages.split(',').includes('1') || b.liste_usages.split(',').includes('2') || b.liste_usages.split(',').includes('3') || b.liste_usages.split(',').includes('8')) - countExploitations(bilan, b => b.liste_nature_document.split(',').includes('Autorisation CSP - IOTA') || b.liste_nature_document.split(',').includes('Autorisation IOTA'))
    }

    results.push(csp, hydroelectricite, icpe, aot, iota)

    return results.sort((a, b) => b.nb_exploitations_concernees - a.nb_exploitations_concernees)
  }
  // Fin des fonctions pour "Régularisations"

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
    regularisations: getRegularisations(),
    documents: documentsWithNature,
    pointsCount: storage.pointsPrelevement.length,
    activExploitationsCount: activExploitations.length,
    activPointsPrelevementCount: uniq(activPoints).length,
    activBeneficiairesCount: uniq(activBeneficiaires).length,
    activPointsSurfaceCount: uniq(activPointsSurface).length,
    activPointsSouterrainCount: uniq(activPointsSouterrain).length
  }
}
