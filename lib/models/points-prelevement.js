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

function getRegularisationsStats() {
  function getActiveDocuments() {
    const today = new Date()
    const activeDocuments = storage.documents.filter(doc => !doc.date_fin_validite || new Date(doc.date_fin_validite) >= today)
    return activeDocuments
  }

  function createBilanRegularisations() {
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

  function countExploitationsRegularisation(bilan, criteria) {
    const exploitationsSet = new Set()
    for (const b of bilan) {
      if (criteria(b)) {
        exploitationsSet.add(b.id_exploitation)
      }
    }

    return exploitationsSet.size
  }

  function getRegularisations() {
    const bilan = createBilanRegularisations()
    const results = []
    const csp = {
      regime: 'CSP',
      nb_exploitations_concernees: countExploitationsRegularisation(bilan, b => b.liste_usages.split(',').includes('1')),
      nb_exploitations_autorisees: countExploitationsRegularisation(bilan, b => b.liste_nature_document.split(',').includes('Autorisation CSP') || b.liste_nature_document.split(',').includes('Autorisation CSP - IOTA')),
      nb_exploitations_non_autorisees: countExploitationsRegularisation(bilan, b => b.liste_usages.split(',').includes('1')) - countExploitationsRegularisation(bilan, b => b.liste_nature_document.split(',').includes('Autorisation CSP') || b.liste_nature_document.split(',').includes('Autorisation CSP - IOTA'))
    }
    const hydroelectricite = {
      regime: 'Hydroélectricité',
      nb_exploitations_concernees: countExploitationsRegularisation(bilan, b => b.liste_usages.split(',').includes('6')),
      nb_exploitations_autorisees: countExploitationsRegularisation(bilan, b => b.liste_nature_document.split(',').includes('Autorisation hydroélectricité')),
      nb_exploitations_non_autorisees: countExploitationsRegularisation(bilan, b => b.liste_usages.split(',').includes('6')) - countExploitationsRegularisation(bilan, b => b.liste_nature_document.split(',').includes('Autorisation hydroélectricité'))
    }
    const icpe = {
      regime: 'ICPE',
      nb_exploitations_concernees: countExploitationsRegularisation(bilan, b => b.liste_usages.split(',').includes('5') || b.liste_usages.split(',').includes('7') || b.liste_usages.split(',').includes('9')),
      nb_exploitations_autorisees: countExploitationsRegularisation(bilan, b => b.liste_nature_document.split(',').includes('Autorisation ICPE')),
      nb_exploitations_non_autorisees: countExploitationsRegularisation(bilan, b => b.liste_usages.split(',').includes('5') || b.liste_usages.split(',').includes('7') || b.liste_usages.split(',').includes('9')) - countExploitationsRegularisation(bilan, b => b.liste_nature_document.split(',').includes('Autorisation ICPE'))
    }
    const aot = {
      regime: 'AOT',
      nb_exploitations_concernees: countExploitationsRegularisation(bilan, () => true),
      nb_exploitations_autorisees: countExploitationsRegularisation(bilan, b => b.liste_nature_document.split(',').includes('Autorisation AOT')),
      nb_exploitations_non_autorisees: countExploitationsRegularisation(bilan, () => true) - countExploitationsRegularisation(bilan, b => b.liste_nature_document.split(',').includes('Autorisation AOT'))
    }
    const iota = {
      regime: 'IOTA',
      nb_exploitations_concernees: countExploitationsRegularisation(bilan, b => b.liste_usages.split(',').includes('1') || b.liste_usages.split(',').includes('2') || b.liste_usages.split(',').includes('3') || b.liste_usages.split(',').includes('8')),
      nb_exploitations_autorisees: countExploitationsRegularisation(bilan, b => b.liste_nature_document.split(',').includes('Autorisation CSP - IOTA') || b.liste_nature_document.split(',').includes('Autorisation IOTA')),
      nb_exploitations_non_autorisees: countExploitationsRegularisation(bilan, b => b.liste_usages.split(',').includes('1') || b.liste_usages.split(',').includes('2') || b.liste_usages.split(',').includes('3') || b.liste_usages.split(',').includes('8')) - countExploitationsRegularisation(bilan, b => b.liste_nature_document.split(',').includes('Autorisation CSP - IOTA') || b.liste_nature_document.split(',').includes('Autorisation IOTA'))
    }

    results.push(csp, hydroelectricite, icpe, aot, iota)

    return results.sort((a, b) => b.nb_exploitations_concernees - a.nb_exploitations_concernees)
  }

  return getRegularisations()
}

function getDebitsReservesStats() {
  function getActiveRegles() {
    const today = new Date()
    const activeRegles = storage.regles.filter(r => !r.fin_validite || new Date(r.fin_validite) >= today)
    return activeRegles
  }

  function createBilan() {
    const activeRegles = getActiveRegles()
    const bilanMap = new Map()

    for (const e of storage.exploitations) {
      if (e.statut === 'En activité' || e.statut === 'Non renseigné') {
        const {id_exploitation} = e
        const {id_point} = e
        const point = storage.pointsPrelevement.find(p => p.id_point === id_point)

        if (point
          && point.type_milieu === 'Eau de surface'
          && !point.nom.toLowerCase().includes('source')
          && !point.nom.toLowerCase().includes('camions citernes')
        ) {
          const liste_parametres = new Set()

          for (const er of storage.exploitationsRegles) {
            if (er.id_exploitation === id_exploitation) {
              const regle = activeRegles
                .find(r => r.id_regle === er.id_regle)
              if (regle) {
                liste_parametres.add(regle.parametre)
              }
            }
          }

          const hasDebitReserve = [...liste_parametres]
            .some(param => param.includes('Débit réservé'))

          const debitReserve = hasDebitReserve
            ? 'Débit réservé défini'
            : 'Pas de débit réservé'

          bilanMap.set(id_exploitation, {
            id_exploitation,
            nom: point.nom,
            debit_reserve: debitReserve
          })
        }
      }
    }

    const bilan = [...bilanMap.values()]

    return bilan
  }

  function countExploitations(bilan, criteria) {
    return bilan.filter(criteria).length
  }

  function getResults() {
    const bilan = createBilan()
    const results = []

    results.push(
      {
        debit_reserve: 'Débit réservé défini',
        nb_exploitations: countExploitations(bilan, b => b.debit_reserve === 'Débit réservé défini')
      },
      {
        debit_reserve: 'Pas de débit réservé',
        nb_exploitations: countExploitations(bilan, b => b.debit_reserve === 'Pas de débit réservé')
      }
    )

    return results
  }

  return getResults()
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
    debitsReserves: getDebitsReservesStats(),
    regularisations: getRegularisationsStats(),
    documents: documentsWithNature,
    pointsCount: storage.pointsPrelevement.length,
    activExploitationsCount: activExploitations.length,
    activPointsPrelevementCount: uniq(activPoints).length,
    activBeneficiairesCount: uniq(activBeneficiaires).length,
    activPointsSurfaceCount: uniq(activPointsSurface).length,
    activPointsSouterrainCount: uniq(activPointsSouterrain).length
  }
}
