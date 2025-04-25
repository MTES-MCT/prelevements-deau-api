import {chain, minBy, uniq} from 'lodash-es'

import mongo from '../util/mongo.js'
import {isAfter} from 'date-fns'

export async function decoratePointPrelevement(point) {
  const exploitations = await mongo.db.collection('exploitations').find(
    {id_point: point.id_point},
    {projection: {
      id_exploitation: 1,
      statut: 1,
      date_debut: 1,
      id_beneficiaire: 1,
      usages: 1
    }}
  ).toArray()

  const preleveursIds = uniq(exploitations.map(e => e.id_beneficiaire))

  const preleveurs = await mongo.db.collection('preleveurs').find({
    id_beneficiaire: {$in: preleveursIds}
  }).toArray()

  const isActive = exploitations.some(e => e.statut === 'En activité' || e.statut === 'Non renseigné')
  const oldestExploitation = minBy(exploitations, e => e.date_debut)

  return {
    ...point,
    preleveurs,
    exploitationsStatus: isActive ? 'En activité' : 'Terminée',
    exploitationsStartDate: oldestExploitation.date_debut,
    usages: chain(exploitations).map('usages').flatten().uniq().value()
  }
}

export async function getPointsPrelevement() {
  return mongo.db.collection('points_prelevement').find().toArray()
}

export async function getPointPrelevement(pointId) {
  return mongo.db.collection('points_prelevement').findOne({id_point: pointId})
}

export async function getPointsFromBeneficiaire(idBeneficiaire) {
  const exploitations = await mongo.db.collection('exploitations')
    .find({id_beneficiaire: idBeneficiaire})
    .toArray()

  const pointIds = [...new Set(exploitations.map(e => e.id_point))]

  return mongo.db.collection('points_prelevement')
    .find({id_point: {$in: pointIds}})
    .toArray()
}

async function getRegularisationsStats() {
  const regimes = [
    {
      nom: 'AOT',
      concerne: () => true, // Toutes les exploitations sont concernées
      autorise: doc => doc.nature === 'Autorisation AOT'
    },
    {
      nom: 'IOTA',
      concerne: exploitation => ['Eau potable', 'Agriculture', 'Autre', 'Non renseigné'].some(v => exploitation.usages.includes(v)),
      autorise: doc => (doc.nature === 'Autorisation IOTA' || doc.nature === 'Autorisation CSP - IOTA')
    },
    {
      nom: 'CSP',
      concerne: exploitation => exploitation.usages.includes('Eau potable'),
      autorise: doc => (doc.nature === 'Autorisation CSP' || doc.nature === 'Autorisation CSP - IOTA')
    },
    {
      nom: 'ICPE',
      concerne: exploitation => ['Eau embouteillée', 'Industrie', 'Thermalisme'].some(v => exploitation.usages.includes(v)),
      autorise: doc => doc.nature === 'Autorisation ICPE'
    },
    {
      nom: 'Hydroélectricité',
      concerne: exploitation => exploitation.usages.includes('Hydroélectricité'),
      autorise: doc => doc.nature === 'Autorisation hydroélectricité'
    }
  ]

  const activExploitations = await mongo.db.collection('exploitations').find({
    statut: {$in: ['En activité', 'Non renseigné']}
  }).toArray()

  const results = regimes.map(regime => {
    const concernees = activExploitations.filter(exploitation => regime.concerne(exploitation))
    const autorisees = activExploitations.filter(exploitation =>
      exploitation.documents.some(doc =>
        regime.autorise(doc)
          && (doc.date_fin_validite === null || isAfter(doc.date_fin_validite, new Date()))
      )
    )

    return {
      regime: regime.nom,
      nb_exploitations_concernees: concernees.length,
      nb_exploitations_autorisees: autorisees.length,
      nb_exploitations_non_autorisees: concernees.length - autorisees.length
    }
  })

  return results
}

async function getDebitsReservesStats() {
  const today = new Date()

  const pipeline = [
    {$match: {statut: {$in: ['En activité', 'Non renseigné']}}},
    {$lookup: {
      from: 'points_prelevement',
      localField: 'id_point',
      foreignField: 'id_point',
      as: 'point'
    }},
    {$unwind: '$point'},
    {$match: {
      'point.type_milieu': 'Eau de surface',
      'point.nom': {$not: /source|camions citernes/i}
    }},
    {$addFields: {
      regles_valides: {
        $filter: {
          input: '$regles',
          as: 'r',
          cond: {
            $or: [
              {$eq: ['$$r.fin_validite', null]},
              {$gte: ['$$r.fin_validite', today]}
            ]
          }
        }
      }
    }},
    {$addFields: {
      has_debit_reserve: {
        $gt: [{
          $size: {
            $filter: {
              input: '$regles_valides',
              as: 'r',
              cond: {$regexMatch: {input: '$$r.parametre', regex: /débit réservé/i}}
            }
          }
        }, 0]
      }
    }},
    {$addFields: {
      debit_reserve: {
        $cond: [
          '$has_debit_reserve',
          'Débit réservé défini',
          'Pas de débit réservé'
        ]
      }
    }},
    {$group: {
      _id: '$debit_reserve',
      nb_exploitations: {$sum: 1}
    }},
    {$project: {
      _id: 0,
      debit_reserve: '$_id',
      nb_exploitations: 1
    }}
  ]

  return mongo.db.collection('exploitations').aggregate(pipeline).toArray()
}

export async function getStats() {
  const activExploitations = await mongo.db.collection('exploitations').find({statut: 'En activité'}).toArray()
  const activBeneficiaires = []
  const activPoints = []
  for (const e of activExploitations) {
    activBeneficiaires.push(e.id_beneficiaire)
    activPoints.push(e.id_point)
  }

  const activPointsSurface = await mongo.db.collection('points_prelevement').find({
    id_point: {$in: activPoints},
    type_milieu: 'Eau de surface'
  }).toArray()

  const activPointsSouterrain = await mongo.db.collection('points_prelevement').find({
    id_point: {$in: activPoints},
    type_milieu: 'Eau souterraine'
  }).toArray()

  async function getDocumentsWithNature() {
    const pipeline = [
      {$unwind: {path: '$documents', preserveNullAndEmptyArrays: false}},
      {$project: {
        annee: {$substrBytes: ['$documents.date_signature', 0, 4]},
        nature: '$documents.nature',
        id: '$documents.id_document'
      }},
      {$group: {
        _id: '$id',
        nature: {$first: '$nature'},
        annee: {$first: '$annee'}
      }},
      {$project: {
        id: '$_id',
        nature: 1,
        annee: 1,
        _id: 0
      }},
      {$sort: {nature: 1}}
    ]

    return mongo.db.collection('exploitations').aggregate(pipeline).toArray()
  }

  return {
    debitsReserves: await getDebitsReservesStats(),
    regularisations: await getRegularisationsStats(),
    documents: await getDocumentsWithNature(),
    pointsCount: await mongo.db.collection('points_prelevement').countDocuments(),
    activExploitationsCount: activExploitations.length,
    activPointsPrelevementCount: uniq(activPoints).length,
    activBeneficiairesCount: uniq(activBeneficiaires).length,
    activPointsSurfaceCount: uniq(activPointsSurface).length,
    activPointsSouterrainCount: uniq(activPointsSouterrain).length
  }
}
