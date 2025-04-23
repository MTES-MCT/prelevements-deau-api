import {uniq} from 'lodash-es'

import mongo from '../util/mongo.js'

export async function getPointsPrelevement() {
  try {
    return await mongo.db.collection('points_prelevement').aggregate([
      {
        $lookup: {
          from: 'exploitations',
          localField: 'exploitations',
          foreignField: 'id_exploitation',
          as: 'exploitations_full'
        }
      },
      {
        $unwind: {
          path: '$exploitations_full',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $sort: {
          'exploitations_full.date_debut': 1
        }
      },
      {
        $group: {
          _id: '$_id',
          doc: {$first: '$$ROOT'},
          exploitations_sorted: {$push: '$exploitations_full'},
          first_date: {$first: '$exploitations_full.date_debut'},
          last_statut: {$last: '$exploitations_full.statut'}
        }
      },
      {
        $addFields: {
          'doc.exploitations_full': '$exploitations_sorted',
          'doc.exploitationsStartDate': '$first_date',
          'doc.exploitationsStatus': '$last_statut'
        }
      },
      {
        $replaceRoot: {
          newRoot: '$doc'
        }
      },
      {
        $unwind: {
          path: '$exploitations_full',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $lookup: {
          from: 'preleveurs',
          localField: 'exploitations_full.id_beneficiaire',
          foreignField: 'id_beneficiaire',
          as: 'preleveur'
        }
      },
      {
        $unwind: {
          path: '$preleveur',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $group: {
          _id: '$_id',
          doc: {$first: '$$ROOT'},
          exploitations_full: {$push: '$exploitations_full'},
          preleveurs: {$addToSet: '$preleveur'}
        }
      },
      {
        $addFields: {
          'doc.exploitations_full': '$exploitations_full',
          'doc.preleveurs': '$preleveurs'
        }
      },
      {
        $replaceRoot: {
          newRoot: '$doc'
        }
      },
      {
        $project: {
          all_preleveurs: 0
        }
      }
    ]).toArray()
  } catch (error) {
    console.error('\u001B[31mErreur aggregation:\u001B[0m', error)
    throw error
  }
}

export async function getPointPrelevement(pointId) {
  try {
    const result = await mongo.db.collection('points_prelevement').aggregate([
      {
        $match: {
          id_point: pointId
        }
      },
      {
        $lookup: {
          from: 'exploitations',
          localField: 'id_point',
          foreignField: 'id_point',
          as: 'exploitations'
        }
      },
      {
        $lookup: {
          from: 'preleveurs',
          localField: 'exploitations.id_beneficiaire',
          foreignField: 'id_beneficiaire',
          as: 'preleveurs'
        }
      },
      {
        $addFields: {
          preleveurs: {
            $reduce: {
              input: '$preleveurs',
              initialValue: [],
              in: {
                $cond: [
                  {$in: ['$$this.id_beneficiaire', '$$value.id_beneficiaire']},
                  '$$value',
                  {$concatArrays: ['$$value', ['$$this']]}
                ]
              }
            }
          }
        }
      }
    ]).toArray()

    return result[0]
  } catch (error) {
    console.error('\u001B[31mErreur aggregation:\u001B[0m', error)
    throw error
  }
}

export async function getPointsFromBeneficiaire(idBeneficiaire) {
  try {
    const exploitations = await mongo.db.collection('exploitations')
      .find({id_beneficiaire: idBeneficiaire})
      .toArray()

    const pointIds = [...new Set(exploitations.map(e => e.id_point))]

    return await mongo.db.collection('points_prelevement')
      .find({id_point: {$in: pointIds}})
      .toArray()
  } catch (error) {
    console.error('\u001B[31mErreur:', error, '\u001B[0m')
    throw error
  }
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
    pointsCount: await mongo.db.collection('points_prelevement').countDocuments(),
    activExploitationsCount: activExploitations.length,
    activPointsPrelevementCount: uniq(activPoints).length,
    activBeneficiairesCount: uniq(activBeneficiaires).length,
    activPointsSurfaceCount: uniq(activPointsSurface).length,
    activPointsSouterrainCount: uniq(activPointsSouterrain).length
  }
}
