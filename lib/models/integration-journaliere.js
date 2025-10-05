import createHttpError from 'http-errors'
import mongo from '../util/mongo.js'

// Collection: integrations_journalieres
// Document shape:
// {
//   _id,
//   preleveur: ObjectId,
//   point: ObjectId,
//   date: 'YYYY-MM-DD',
//   demarcheNumber,
//   dossierNumber,
//   attachmentId,
//   createdAt
// }
// Index unique: {preleveur:1, point:1, date:1}

export async function insertIntegration({preleveurId, pointId}, date, {demarcheNumber, dossierNumber, attachmentId}) {
  if (!preleveurId || !pointId || !date || !demarcheNumber || !dossierNumber || !attachmentId) {
    throw createHttpError(400, 'Missing argument')
  }

  const query = {preleveur: preleveurId, point: pointId, date}
  const now = new Date()
  const update = {$setOnInsert: {demarcheNumber, dossierNumber, attachmentId, createdAt: now}}

  const coll = mongo.db.collection('integrations_journalieres')
  const {value} = await coll.findOneAndUpdate(
    query,
    update,
    {upsert: true, returnDocument: 'after', projection: {_id: 1, preleveur: 1, point: 1, date: 1, demarcheNumber: 1, dossierNumber: 1, attachmentId: 1, createdAt: 1}}
  )

  if (value) {
    return value
  }

  // Fallback improbable (cas race condition driver) : on relit
  return coll.findOne(query, {projection: {_id: 1, preleveur: 1, point: 1, date: 1, demarcheNumber: 1, dossierNumber: 1, attachmentId: 1, createdAt: 1}})
}

export async function getIntegration({preleveurId, pointId}, date) {
  if (!preleveurId || !pointId || !date) {
    throw createHttpError(400, 'Missing argument')
  }

  return mongo.db.collection('integrations_journalieres').findOne({preleveur: preleveurId, point: pointId, date})
}

export async function listIntegrationsByAttachment(attachmentId) {
  if (!attachmentId) {
    throw createHttpError(400, 'Missing argument')
  }

  return mongo.db.collection('integrations_journalieres')
    .find({attachmentId})
    .project({point: 1, date: 1, _id: 0})
    .toArray()
}
