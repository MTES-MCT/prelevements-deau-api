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
  if (
    typeof initialValue !== 'number'
    || !Number.isInteger(initialValue)
    || initialValue <= 0
  ) {
    throw new Error('initialValue must be a positive integer')
  }

  await mongo.db.collection('sequences').findOneAndUpdate(
    {name: sequenceName},
    {$set: {nextId: initialValue}},
    {upsert: true}
  )
}

