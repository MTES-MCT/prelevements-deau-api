import {ObjectId} from 'mongodb'
import createHttpError from 'http-errors'
import mongo from '../util/mongo.js'

export async function insertDocument(document) {
  document._id = new ObjectId()
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
