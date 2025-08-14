import {ObjectId} from 'mongodb'
import mongo from '../util/mongo.js'

export async function insertSaisieJournaliere({preleveurId, pointId}, date, data, source) {
  if (!preleveurId || !pointId || !date || !data || !source) {
    throw new Error('Missing argument')
  }

  const item = {
    _id: new ObjectId(),
    preleveur: preleveurId,
    point: pointId,
    date,
    data,
    source
  }

  await mongo.db.collection('saisies_journalieres').insertOne(item)

  return item
}

export async function deleteSaisieJournaliere({preleveurId, pointId}, date) {
  if (!preleveurId || !pointId || !date) {
    throw new Error('Missing argument')
  }

  const query = {
    preleveur: preleveurId,
    point: pointId,
    date
  }

  await mongo.db.collection('saisies_journalieres').deleteOne(query)
}

export async function getSaisieJournaliere({preleveurId, pointId}, date) {
  if (!preleveurId || !pointId || !date) {
    throw new Error('Missing argument')
  }

  const query = {
    preleveur: preleveurId,
    point: pointId,
    date
  }

  return mongo.db.collection('saisies_journalieres').findOne(query)
}

export async function getSaisiesJournalieres({preleveurId, pointId}, {from, to}, withData = false) {
  if (!preleveurId || !pointId || !from || !to) {
    throw new Error('Missing argument')
  }

  const query = mongo.db.collection('saisies_journalieres').find({
    preleveur: preleveurId,
    point: pointId,
    date: {$gte: from, $lte: to}
  })

  if (!withData) {
    return query.projection({data: 0}).toArray()
  }

  return query.toArray()
}
