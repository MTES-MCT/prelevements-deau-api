import createHttpError from 'http-errors'
import mongo from '../util/mongo.js'

export async function insertSaisieJournaliere({preleveurId, pointId}, date, {data, dataHash, source, sourceHash}) {
  if (!preleveurId || !pointId || !date || !data || !source || !sourceHash || !dataHash) {
    throw createHttpError(400, 'Missing argument')
  }

  const query = {
    preleveur: preleveurId,
    point: pointId,
    date
  }

  const attributes = {
    data,
    dataHash,
    source,
    sourceHash
  }

  await mongo.db.collection('saisies_journalieres').updateOne(
    query,
    {$set: attributes},
    {upsert: true}
  )
}

export async function deleteSaisieJournaliere({preleveurId, pointId}, date) {
  if (!preleveurId || !pointId || !date) {
    throw createHttpError(400, 'Missing argument')
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
    throw createHttpError(400, 'Missing argument')
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
    throw createHttpError(400, 'Missing argument')
  }

  const query = mongo.db.collection('saisies_journalieres').find({
    preleveur: preleveurId,
    point: pointId,
    date: {$gte: from, $lte: to}
  })

  if (!withData) {
    return query.project({data: 0}).toArray()
  }

  return query.toArray()
}

export async function getAggregatedSaisiesJournalieresByPreleveur(preleveurId, {from, to}) {
  if (!preleveurId || !from || !to) {
    throw createHttpError(400, 'Missing argument')
  }

  const matchQuery = {
    preleveur: preleveurId,
    date: {$gte: from, $lte: to}
  }

  const pipeline = [
    {$match: matchQuery},
    {$group: {
      _id: '$date',
      points: {$addToSet: '$point'},
      volumePreleveTotal: {$sum: '$data.values.volume prélevé'}
    }}
  ]

  const items = await mongo.db.collection('saisies_journalieres').aggregate(pipeline).toArray()

  return items.map(item => ({
    date: item._id,
    points: item.points.length,
    data: {values: {'volume prélevé': item.volumePreleveTotal}}
  }))
}

export async function getAggregatedSaisiesJournalieresByPoint(pointId, {from, to}) {
  if (!pointId || !from || !to) {
    throw createHttpError(400, 'Missing argument')
  }

  const matchQuery = {
    point: pointId,
    date: {$gte: from, $lte: to}
  }

  const pipeline = [
    {$match: matchQuery},
    {$group: {
      _id: '$date',
      preleveurs: {$addToSet: '$preleveur'},
      volumePreleveTotal: {$sum: '$data.values.volume prélevé'}
    }}
  ]

  const items = await mongo.db.collection('saisies_journalieres').aggregate(pipeline).toArray()

  return items.map(item => ({
    date: item._id,
    preleveurs: item.preleveurs.length,
    data: {values: {'volume prélevé': item.volumePreleveTotal}}
  }))
}
