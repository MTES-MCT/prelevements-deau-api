import mongo from '../util/mongo.js'

export async function insertSaisieJournaliere({preleveurId, pointId}, date, {data, dataHash, source, sourceHash}) {
  if (!preleveurId || !pointId || !date || !data || !source || !sourceHash || !dataHash) {
    throw new Error('Missing argument')
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
    return query.project({data: 0}).toArray()
  }

  return query.toArray()
}
