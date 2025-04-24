import {chain, minBy, uniq} from 'lodash-es'

import mongo from '../util/mongo.js'

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
  const CSPConcernees = await mongo.db.collection('exploitations').countDocuments({
    documents: {
      $exists: true
    },
    $or: [
      {date_fin_validite: null},
      {date_fin_validite: {$gte: new Date()}}
    ],
    usages: {$in: ['Eau potable']},
    statut: {$in: ['En activité', 'Non renseigné']}
  })

  const CSPAutorisees = await mongo.db.collection('exploitations').countDocuments({
    documents: {
      $exists: true,
      $not: {$size: 0},
      $elemMatch: {nature: {$in: ['Autorisation CSP', 'Autorisation CSP - IOTA']}}
    },
    $or: [
      {date_fin_validite: null},
      {date_fin_validite: {$gte: new Date()}}
    ],
    statut: {$in: ['En activité', 'Non renseigné']}
  })

  const ICPEConcernees = await mongo.db.collection('exploitations').countDocuments({
    documents: {
      $exists: true
    },
    $or: [
      {date_fin_validite: null},
      {date_fin_validite: {$gte: new Date()}}
    ],
    usages: {$in: ['Eau embouteillée', 'Industrie', 'Thermalisme']},
    statut: {$in: ['En activité', 'Non renseigné']}
  })

  const ICPEAutorisees = await mongo.db.collection('exploitations').countDocuments({
    documents: {
      $exists: true,
      $not: {$size: 0},
      $elemMatch: {nature: {$in: ['Autorisation ICPE']}}
    },
    $or: [
      {date_fin_validite: null},
      {date_fin_validite: {$gte: new Date()}}
    ],
    usages: {$in: ['Eau embouteillée', 'Industrie', 'Thermalisme']},
    statut: {$in: ['En activité', 'Non renseigné']}
  })

  const HydroConcernees = await mongo.db.collection('exploitations').countDocuments({
    documents: {
      $exists: true
    },
    $or: [
      {date_fin_validite: null},
      {date_fin_validite: {$gte: new Date()}}
    ],
    usages: {$in: ['Hydroélectricité']},
    statut: {$in: ['En activité', 'Non renseigné']}
  })

  const HydroAutorisees = await mongo.db.collection('exploitations').countDocuments({
    documents: {
      $exists: true,
      $not: {$size: 0},
      $elemMatch: {nature: {$in: ['Autorisation hydroélectricité']}}
    },
    $or: [
      {date_fin_validite: null},
      {date_fin_validite: {$gte: new Date()}}
    ],
    usages: {$in: ['Hydroélectricité']},
    statut: {$in: ['En activité', 'Non renseigné']}
  })

  const AOTConcernees = await mongo.db.collection('exploitations').countDocuments({
    documents: {
      $exists: true
    },
    $or: [
      {date_fin_validite: null},
      {date_fin_validite: {$gte: new Date()}}
    ],
    statut: {$in: ['En activité', 'Non renseigné']}
  })

  const AOTAutorisees = await mongo.db.collection('exploitations').countDocuments({
    documents: {
      $elemMatch: {nature: {$in: ['Autorisation AOT']}}
    },
    $or: [
      {date_fin_validite: null},
      {date_fin_validite: {$gte: new Date()}}
    ],
    statut: {$in: ['En activité', 'Non renseigné']}
  })

  const IOTAConcernees = await mongo.db.collection('exploitations').countDocuments({
    documents: {
      $exists: true
    },
    $or: [
      {date_fin_validite: null},
      {date_fin_validite: {$gte: new Date()}}
    ],
    usages: {$in: ['Eau potable', 'Agriculture', 'Autre', 'Non renseigné']},
    statut: {$in: ['En activité', 'Non renseigné']}
  })

  const IOTAAutorisees = await mongo.db.collection('exploitations').countDocuments({
    documents: {
      $exists: true,
      $not: {$size: 0},
      $elemMatch: {nature: {$in: ['Autorisation IOTA', 'Autorisation CSP - IOTA']}}
    },
    $or: [
      {date_fin_validite: null},
      {date_fin_validite: {$gte: new Date()}}
    ],
    statut: {$in: ['En activité', 'Non renseigné']}
  })

  return [
    {
      regime: 'AOT',
      nb_exploitations_concernees: AOTConcernees,
      nb_exploitations_autorisees: AOTAutorisees,
      nb_exploitations_non_autorisees: AOTConcernees - AOTAutorisees
    },
    {
      regime: 'IOTA',
      nb_exploitations_concernees: IOTAConcernees,
      nb_exploitations_autorisees: IOTAAutorisees,
      nb_exploitations_non_autorisees: IOTAConcernees - IOTAAutorisees
    },
    {
      regime: 'CSP',
      nb_exploitations_concernees: CSPConcernees,
      nb_exploitations_autorisees: CSPAutorisees,
      nb_exploitations_non_autorisees: CSPConcernees - CSPAutorisees
    },
    {
      regime: 'ICPE',
      nb_exploitations_concernees: ICPEConcernees,
      nb_exploitations_autorisees: ICPEAutorisees,
      nb_exploitations_non_autorisees: ICPEConcernees - ICPEAutorisees
    },
    {
      regime: 'Hydroélectricité',
      nb_exploitations_concernees: HydroConcernees,
      nb_exploitations_autorisees: HydroAutorisees,
      nb_exploitations_non_autorisees: HydroConcernees - HydroAutorisees
    }
  ]
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
