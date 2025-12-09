import mongo from '../util/mongo.js'

export async function getTokenEntry(token) {
  return mongo.db.collection('tokens').findOne({token})
}

export async function insertToken(token, territoire, role = 'editor') {
  if (!['reader', 'editor'].includes(role)) {
    throw new Error('Le rôle doit être "reader" ou "editor"')
  }

  await mongo.db.collection('tokens').insertOne({
    token,
    territoire,
    role
  })

  return {token, territoire, role}
}

export async function deleteToken(token) {
  const result = await mongo.db.collection('tokens').deleteOne({token})
  return result.deletedCount > 0
}
