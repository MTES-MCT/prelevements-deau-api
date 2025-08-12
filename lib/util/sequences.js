import mongo from './mongo.js'

export async function getNextSeqId(sequenceName) {
  const {nextId} = await mongo.db.collection('sequences').findOneAndUpdate(
    {name: sequenceName},
    {$inc: {nextId: 1}},
    {upsert: true, returnDocument: 'after'}
  )

  return nextId
}

export async function initSequence(sequenceName, initialValue) {
  if (initialValue) {
    await mongo.db.collection('sequences').findOneAndUpdate(
      {name: sequenceName},
      {$set: {nextId: initialValue}},
      {upsert: true}
    )
  }
}

