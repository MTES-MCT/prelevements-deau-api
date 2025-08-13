import {chain, minBy} from 'lodash-es'

import mongo, {ObjectId} from '../util/mongo.js'
import {validateCreation, validateChanges} from '../validation/point-validation.js'
import createHttpError from 'http-errors'
import {getNextSeqId} from '../util/sequences.js'

import {getPreleveursByIds} from './preleveur.js'

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

  const preleveursIds = chain(exploitations)
    .map(e => e.preleveur)
    .uniqBy(id => id.toString())
    .value()

  const preleveurs = await getPreleveursByIds(preleveursIds)

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

  const nextId = await getNextSeqId(`territoire-${codeTerritoire}-points`)

  enrichedPoint._id = new ObjectId()
  enrichedPoint.id_point = nextId
  enrichedPoint.territoire = codeTerritoire
  enrichedPoint.createdAt = new Date()
  enrichedPoint.updatedAt = new Date()

  await mongo.db.collection('points_prelevement').insertOne(enrichedPoint)

  return enrichedPoint
}

export async function updatePointPrelevement(pointId, payload) {
  const changes = validateChanges(payload)

  if (Object.keys(changes).length === 0) {
    throw createHttpError(400, 'Aucun champ valide trouvé.')
  }

  const enrichedPoint = await enrichPointPrelevement(payload, changes)

  enrichedPoint.updatedAt = new Date()

  const point = await mongo.db.collection('points_prelevement').findOneAndUpdate(
    {_id: pointId, deletedAt: {$exists: false}},
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

// Trouve un point de prélèvement par son ID et son territoire. Les points supprimés sont renvoyés.
export async function findPointPrelevementByIdPoint(codeTerritoire, idPoint) {
  return mongo.db.collection('points_prelevement').findOne(
    {id_point: idPoint, territoire: codeTerritoire}
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

export async function getPointsFromPreleveur(preleveurId) {
  const pointIds = await mongo.db.collection('exploitations')
    .distinct('point', {preleveur: preleveurId})

  return mongo.db.collection('points_prelevement')
    .find({_id: {$in: pointIds}, deletedAt: {$exists: false}})
    .toArray()
}

