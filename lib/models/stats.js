import {uniq} from 'lodash-es'
import {isAfter} from 'date-fns'

import {
  getPointsPrelevementFromTerritoire,
  getPointsPrelevement,
  decoratePointPrelevement
} from './points-prelevement.js'

import mongo from '../util/mongo.js'

export async function getStats(territoire) {
  const activExploitations = await mongo.db.collection('exploitations').find({
    statut: 'En activité',
    deletedAt: {$exists: false},
    ...(territoire && {territoire})
  }).toArray()
  const activPreleveurs = []
  const activPoints = []
  for (const e of activExploitations) {
    activPreleveurs.push(e.preleveur)
    activPoints.push(e.point)
  }

  const points = territoire
    ? await getPointsPrelevementFromTerritoire(territoire)
    : await getPointsPrelevement()
  const decoratedPoints = await Promise.all(points.map(p => decoratePointPrelevement(p)))
  const enActivitePoints = decoratedPoints.filter(p => p.exploitationsStatus === 'En activité').length
  const termineePoints = decoratedPoints.filter(p => p.exploitationsStatus === 'Terminée').length
  const abandoneePoints = decoratedPoints.filter(p => p.exploitationsStatus === 'Abandonnée').length
  const nonRenseignePoints = decoratedPoints.filter(p => p.exploitationsStatus === 'Non renseigné').length

  const activPointsSurface = await mongo.db.collection('points_prelevement').find({
    _id: {$in: activPoints},
    type_milieu: 'Eau de surface',
    ...(territoire && {territoire})
  }).toArray()

  const activPointsSouterrain = await mongo.db.collection('points_prelevement').find({
    _id: {$in: activPoints},
    type_milieu: 'Eau souterraine',
    ...(territoire && {territoire})
  }).toArray()

  async function getDocumentsWithNature(territoire) {
    const pipeline = [
      {$match: {
        ...(territoire && {territoire}),
        deletedAt: {$exists: false}
      }},
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
    debitsReserves: await getDebitsReservesStats(territoire),
    regularisations: await getRegularisationsStats(territoire),
    documents: await getDocumentsWithNature(territoire),
    pointsCount: await mongo.db.collection('points_prelevement').countDocuments({
      deletedAt: {$exists: false},
      ...(territoire && {territoire})
    }),
    activPointsPrelevementCount: uniq(activPoints).length,
    activPreleveursCount: uniq(activPreleveurs).length,
    activPointsSurfaceCount: uniq(activPointsSurface).length,
    activPointsSouterrainCount: uniq(activPointsSouterrain).length,
    enActivitePoints,
    termineePoints,
    abandoneePoints,
    nonRenseignePoints
  }
}

async function getRegularisationsStats(territoire) {
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
    statut: {$in: ['En activité', 'Non renseigné']},
    deletedAt: {$exists: false},
    ...(territoire && {territoire})
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

async function getDebitsReservesStats(territoire) {
  const today = new Date()

  // Toutes les exploitations actives
  const activeExploitations = await mongo.db.collection('exploitations').find({
    statut: {$in: ['En activité', 'Non renseigné']},
    deletedAt: {$exists: false},
    ...(territoire && {territoire})
  }).toArray()

  // Toutes les exploitations active avec un débit réservé
  const activeExploitationsWithDebitReserve = await mongo.db.collection('exploitations').find({
    statut: {$in: ['En activité', 'Non renseigné']},
    deletedAt: {$exists: false},
    ...(territoire && {territoire}),
    regles: {
      $elemMatch: {
        parametre: 'Débit réservé',
        $or: [
          {fin_validite: null},
          {fin_validite: {$gt: today}}
        ]
      }
    }
  }).toArray()

  // Tous les points de surface, hors sources
  const pointsSurface = await mongo.db.collection('points_prelevement').find({
    type_milieu: 'Eau de surface',
    nom: {$not: /source/i}
  }).toArray()

  // Filtre les exploitations de surface et hors sources
  const debitReserve = activeExploitationsWithDebitReserve.filter(exp =>
    pointsSurface.some(p => p._id.equals(exp.point))
  )

  const noDebitReserve = activeExploitations.filter(exp =>
    pointsSurface.some(p => p._id.equals(exp.point))
  )

  return [
    {
      debitReserve: 'Débit réservé défini',
      nbExploitations: debitReserve.length
    },
    {
      debitReserve: 'Pas de débit réservé',
      nbExploitations: noDebitReserve.length - debitReserve.length
    }
  ]
}
