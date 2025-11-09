import mongo, {ObjectId} from '../util/mongo.js'
import createHttpError from 'http-errors'

export async function getRegle(regleId) {
  return mongo.db.collection('regles').findOne(
    {
      _id: regleId,
      deletedAt: {$exists: false}
    }
  )
}

export async function getPreleveurRegles(preleveurId) {
  return mongo.db.collection('regles').find({
    preleveur: preleveurId,
    deletedAt: {$exists: false}
  }).toArray()
}

export async function getExploitationRegles(exploitationId) {
  return mongo.db.collection('regles').find({
    exploitations: exploitationId,
    deletedAt: {$exists: false}
  }).toArray()
}

export async function preleveurHasRegles(preleveurId) {
  const count = await mongo.db.collection('regles').countDocuments({
    preleveur: preleveurId,
    deletedAt: {$exists: false}
  })

  return count > 0
}

export async function documentHasRegles(documentId) {
  const count = await mongo.db.collection('regles').countDocuments({
    document: documentId,
    deletedAt: {$exists: false}
  })

  return count > 0
}

export async function insertRegle(regle, codeTerritoire) {
  regle._id = new ObjectId()
  regle.territoire = codeTerritoire
  regle.createdAt = new Date()
  regle.updatedAt = new Date()

  await mongo.db.collection('regles').insertOne(regle)

  return regle
}

export async function updateRegleById(regleId, changes) {
  if (!changes || typeof changes !== 'object') {
    throw createHttpError(400, 'Les modifications doivent être un objet.')
  }

  const update = {
    ...changes,
    updatedAt: new Date()
  }

  const regle = await mongo.db.collection('regles').findOneAndUpdate(
    {_id: regleId, deletedAt: {$exists: false}},
    {$set: update},
    {returnDocument: 'after'}
  )

  if (!regle) {
    throw createHttpError(404, 'Cette règle est introuvable.')
  }

  return regle
}

export async function deleteRegle(regleId) {
  return mongo.db.collection('regles').findOneAndUpdate(
    {_id: regleId, deletedAt: {$exists: false}},
    {$set: {
      deletedAt: new Date(),
      updatedAt: new Date()
    }},
    {returnDocument: 'after'}
  )
}

export async function bulkInsertRegles(codeTerritoire, regles) {
  if (regles.length === 0) {
    return {insertedCount: 0}
  }

  const reglesToInsert = regles.map(regle => ({
    ...regle,
    territoire: codeTerritoire,
    createdAt: new Date(),
    updatedAt: new Date()
  }))

  const {insertedCount} = await mongo.db.collection('regles').insertMany(reglesToInsert)

  return {insertedCount}
}

export async function bulkDeleteRegles(codeTerritoire) {
  return mongo.db.collection('regles').deleteMany({territoire: codeTerritoire})
}
