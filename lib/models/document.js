import mongo, {ObjectId} from '../util/mongo.js'
import createHttpError from 'http-errors'

export async function insertDocument(document, codeTerritoire) {
  document._id = new ObjectId()
  document.territoire = codeTerritoire
  document.createdAt = new Date()
  document.updatedAt = new Date()

  await mongo.db.collection('documents').insertOne(document)

  return document
}

export async function getDocument(documentId) {
  return mongo.db.collection('documents').findOne(
    {_id: documentId, deletedAt: {$exists: false}}
  )
}

export async function updateDocumentById(documentId, changes) {
  if (!changes || typeof changes !== 'object') {
    throw createHttpError(400, 'Les modifications doivent être un objet.')
  }

  const update = {
    ...changes,
    updatedAt: new Date()
  }

  const document = await mongo.db.collection('documents').findOneAndUpdate(
    {_id: documentId, deletedAt: {$exists: false}},
    {$set: update},
    {returnDocument: 'after'}
  )

  if (!document) {
    throw createHttpError(404, 'Ce document est introuvable.')
  }

  return document
}

export async function deleteDocument(documentId) {
  const document = await mongo.db.collection('documents').findOneAndUpdate(
    {_id: documentId, deletedAt: {$exists: false}},
    {$set: {
      deletedAt: new Date(),
      updatedAt: new Date()
    }},
    {returnDocument: 'after'}
  )

  if (!document) {
    throw createHttpError(404, 'Document introuvable')
  }

  return document
}

export async function getPreleveurDocuments(preleveurId) {
  return mongo.db.collection('documents').find({
    preleveur: preleveurId,
    deletedAt: {$exists: false}}
  ).toArray()
}

export async function bulkInsertDocuments(codeTerritoire, documents) {
  if (documents.length === 0) {
    return {insertedCount: 0}
  }

  const documentsToInsert = documents.map(doc => ({
    ...doc,
    territoire: codeTerritoire,
    createdAt: new Date(),
    updatedAt: new Date()
  }))

  const {insertedCount} = await mongo.db.collection('documents').insertMany(documentsToInsert)

  return {insertedCount}
}

export async function bulkDeleteDocuments(codeTerritoire) {
  await mongo.db.collection('documents').deleteMany({territoire: codeTerritoire})
}
