import {chain, minBy, uniq} from 'lodash-es'

import mongo, {ObjectId} from '../util/mongo.js'
import {isAfter} from 'date-fns'
import {validateCreation, validateChanges} from '../validation/point-validation.js'
import {nanoid} from 'nanoid'
import createHttpError from 'http-errors'

function getStatut(exploitations) {
  if (exploitations.some(e => e.statut === 'En activité')) {
    return 'En activité'
  }

  if (exploitations.some(e => e.statut === 'Non renseigné')) {
    return 'Non renseigné'
  }

  if (exploitations.some(e => e.statut === 'Abandonnée')) {
    return 'Abandonnée'
  }

  if (exploitations.some(e => e.statut === 'Terminée')) {
    return 'Terminée'
  }
}

export async function decoratePointPrelevement(point) {
  const exploitations = await mongo.db.collection('exploitations').find(
    {
      point: point._id,
      territoire: point.territoire,
      deletedAt: {$exists: false}
    },
    {projection: {
      id_exploitation: 1,
      statut: 1,
      date_debut: 1,
      preleveur: 1,
      usages: 1
    }}
  ).toArray()

  const hasExploitations = exploitations.length > 0

  const preleveursIds = uniq(exploitations.map(e => e.preleveur))

  const preleveurs = await mongo.db.collection('preleveurs').find(
    {
      _id: {$in: preleveursIds},
      territoire: point.territoire,
      deletedAt: {$exists: false}
    }
  ).toArray()

  const oldestExploitation = minBy(exploitations, e => e.date_debut)

  return {
    ...point,
    preleveurs,
    exploitationsStatus: hasExploitations ? getStatut(exploitations) : null,
    exploitationsStartDate: hasExploitations ? oldestExploitation.date_debut : null,
    usages: chain(exploitations).map('usages').flatten().uniq().value()
  }
}

async function enrichPointPrelevement(payload, point) {
  if (payload.bss) {
    const bss = await mongo.db.collection('bss').findOne({id_bss: payload.bss})

    if (!bss) {
      throw createHttpError(400, 'Code BSS inconnu.')
    }

    point.bss = {
      id_bss: bss.id_bss,
      lien: bss.lien_infoterre
    }
  }

  if (payload.bnpe) {
    const bnpe = await mongo.db.collection('bnpe').findOne({code_point_prelevement: payload.bnpe})

    if (!bnpe) {
      throw createHttpError(400, 'Code BNPE inconnu.')
    }

    point.bnpe = {
      point: bnpe.code_point_prelevement,
      lien: bnpe.uri_ouvrage,
      nom: bnpe.nom_ouvrage
    }
  }

  if (payload.meso) {
    const meso = await mongo.db.collection('meso').findOne({code: payload.meso})

    if (!meso) {
      throw createHttpError(400, 'Code MESO inconnu.')
    }

    point.meso = {
      code: meso.code,
      nom: meso.nom_provis
    }
  }

  if (payload.meContinentalesBv) {
    const meContinentalesBv = await mongo.db.collection('me_continentales_bv').findOne({code_dce: payload.meContinentalesBv})

    if (!meContinentalesBv) {
      throw createHttpError(400, 'Code meContinentalesBv inconnu.')
    }

    point.meContinentalesBv = {
      code: meContinentalesBv.code_dce,
      nom: meContinentalesBv.nom
    }
  }

  if (payload.bvBdCarthage) {
    const bvBdCarthage = await mongo.db.collection('bv_bdcarthage').findOne({code_cours: payload.bvBdCarthage})

    if (!bvBdCarthage) {
      throw createHttpError(400, 'Code bvBdCarthage inconnu.')
    }

    point.bvBdCarthage = {
      code: bvBdCarthage.code_cours,
      nom: bvBdCarthage.toponyme_t
    }
  }

  if (payload.commune) {
    const response = await fetch(`https://geo.api.gouv.fr/communes/${payload.commune}`)

    if (response.status === 404) {
      throw createHttpError(400, 'Ce code commune est inconnu')
    }

    const data = await response.json()

    point.commune = {
      code: data.code,
      nom: data.nom
    }
  }

  return point
}

export async function getPointsPrelevement() {
  return mongo.db.collection('points_prelevement').find(
    {deletedAt: {$exists: false}}
  ).toArray()
}

export async function getPointsPrelevementFromTerritoire(codeTerritoire) {
  return mongo.db.collection('points_prelevement').find(
    {deletedAt: {$exists: false}, territoire: codeTerritoire}
  ).toArray()
}

export async function createPointPrelevement(payload, codeTerritoire) {
  const point = validateCreation(payload)

  const enrichedPoint = await enrichPointPrelevement(payload, point)

  enrichedPoint._id = new ObjectId()
  enrichedPoint.id_point = nanoid()
  enrichedPoint.territoire = codeTerritoire
  enrichedPoint.createdAt = new Date()
  enrichedPoint.updatedAt = new Date()

  await mongo.db.collection('points_prelevement').insertOne(enrichedPoint)

  return enrichedPoint
}

export async function updatePointPrelevement(idPoint, payload) {
  const changes = validateChanges(payload)

  if (Object.keys(changes).length === 0) {
    throw createHttpError(400, 'Aucun champ valide trouvé.')
  }

  const enrichedPoint = await enrichPointPrelevement(payload, changes)

  enrichedPoint.updatedAt = new Date()

  const point = await mongo.db.collection('points_prelevement').findOneAndUpdate(
    {_id: idPoint, deletedAt: {$exists: false}},
    {$set: enrichedPoint},
    {returnDocument: 'after'}
  )

  if (!point) {
    throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
  }

  return point
}

export async function getPointPrelevement(pointId) {
  return mongo.db.collection('points_prelevement').findOne(
    {_id: pointId, deletedAt: {$exists: false}}
  )
}

export async function deletePointPrelevement(pointId) {
  const activeExploitation = await mongo.db.collection('exploitations').findOne(
    {
      point: pointId,
      statut: 'En activité',
      deletedAt: {$exists: false}
    }
  )

  if (activeExploitation) {
    throw createHttpError(409, 'Ce point est toujours en exploitation : ' + activeExploitation.id_exploitation)
  }

  return mongo.db.collection('points_prelevement').findOneAndUpdate(
    {
      _id: pointId,
      deletedAt: {$exists: false}
    },
    {$set: {
      deletedAt: new Date(),
      updatedAt: new Date()
    }},
    {returnDocument: 'after'}
  )
}

export async function getPointsFromPreleveur(idPreleveur) {
  const exploitations = await mongo.db.collection('exploitations')
    .find({preleveur: idPreleveur})
    .toArray()

  const pointIds = [...new Set(exploitations.map(e => e.point))]

  return mongo.db.collection('points_prelevement')
    .find({_id: {$in: pointIds}, deletedAt: {$exists: false}})
    .toArray()
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
    pointsSurface.some(p => p._id === exp.point)
  )

  const noDebitReserve = activeExploitations.filter(exp =>
    pointsSurface.some(p => p._id === exp.point)
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
