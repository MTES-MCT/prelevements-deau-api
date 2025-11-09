import {ObjectId} from 'mongodb'
import createHttpError from 'http-errors'
import mongo from '../util/mongo.js'
import {getNextSeqId} from '../util/sequences.js'

export async function getPointPrelevement(pointId) {
  return mongo.db.collection('points_prelevement').findOne(
    {_id: pointId}
  )
}

// Trouve un point de prélèvement par son ID et son territoire. Les points supprimés sont renvoyés.
export async function getPointBySeqId(codeTerritoire, idPoint) {
  return mongo.db.collection('points_prelevement').findOne(
    {id_point: idPoint, territoire: codeTerritoire}
  )
}

export async function getPointsPrelevement(includeDeleted = false) {
  return mongo.db.collection('points_prelevement').find(
    {...computeDeletionCondition(includeDeleted)}
  ).toArray()
}

export async function getPointsPrelevementByIds(pointIds, includeDeleted = false) {
  return mongo.db.collection('points_prelevement').find(
    {_id: {$in: pointIds}, ...computeDeletionCondition(includeDeleted)}
  ).toArray()
}

export async function getPointsPrelevementFromTerritoire(codeTerritoire, includeDeleted = false) {
  return mongo.db.collection('points_prelevement').find(
    {...computeDeletionCondition(includeDeleted), territoire: codeTerritoire}
  ).toArray()
}

/* Insertion (utilisé par le service) */

export async function insertPointPrelevement(point, codeTerritoire) {
  const insertedPoint = {...point}
  const nextId = await getNextSeqId(`territoire-${codeTerritoire}-points`)

  insertedPoint._id = new ObjectId()
  insertedPoint.id_point = nextId
  insertedPoint.territoire = codeTerritoire
  insertedPoint.createdAt = new Date()
  insertedPoint.updatedAt = new Date()

  await mongo.db.collection('points_prelevement').insertOne(insertedPoint)

  return insertedPoint
}

/* Mise à jour par ID (utilisé par le service) */

export async function updatePointPrelevementById(pointId, changes) {
  if (!changes || typeof changes !== 'object') {
    throw createHttpError(400, 'Les modifications doivent être un objet.')
  }

  const update = {
    ...changes,
    updatedAt: new Date()
  }

  const point = await mongo.db.collection('points_prelevement').findOneAndUpdate(
    {_id: pointId, deletedAt: {$exists: false}},
    {$set: update},
    {returnDocument: 'after'}
  )

  if (!point) {
    throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
  }

  return point
}

/* Suppression par ID (utilisé par le service) */

export async function deletePointPrelevementById(pointId) {
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

/* CRUD pour imports en masse */

export async function bulkInsertPointsPrelevement(codeTerritoire, points) {
  if (points.length === 0) {
    return {insertedCount: 0}
  }

  const pointsToInsert = points.map(point => ({
    ...point,
    territoire: codeTerritoire,
    createdAt: new Date(),
    updatedAt: new Date()
  }))

  const {insertedCount} = await mongo.db.collection('points_prelevement').insertMany(pointsToInsert)

  return {insertedCount}
}

export async function bulkDeletePointsPrelevement(codeTerritoire) {
  const {deletedCount} = await mongo.db.collection('points_prelevement').deleteMany({territoire: codeTerritoire})
  return {deletedCount}
}

/* Helpers */

function computeDeletionCondition(withDeleted) {
  return withDeleted ? {} : {deletedAt: {$exists: false}}
}
