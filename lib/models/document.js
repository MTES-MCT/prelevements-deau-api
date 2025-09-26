import {customAlphabet} from 'nanoid'
import mongo, {ObjectId} from '../util/mongo.js'
import {validateDocumentChanges, validateDocumentCreation} from '../validation/document-validation.js'
import createHttpError from 'http-errors'
import s3 from '../util/s3.js'

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 10)

export async function createDocument(payload, file, preleveurId, territoire) {
  const document = validateDocumentCreation(payload)
  const {originalname, buffer, size} = file
  const objectKey = `${territoire.code}/${preleveurId}/${nanoid()}/${originalname}`

  if (!buffer) {
    throw createHttpError(400, 'Aucun fichier envoyé')
  }

  await s3('documents').uploadObject(objectKey, buffer, {filename: originalname})

  document._id = new ObjectId()
  document.preleveur = preleveurId
  document.nom_fichier = originalname
  document.taille = size
  document.objectKey = objectKey
  document.createdAt = new Date()
  document.updatedAt = new Date()

  try {
    await mongo.db.collection('documents').insertOne(document)

    return document
  } catch (error) {
    await s3('documents').deleteObject(objectKey)
    throw error
  }
}

export async function getDocument(documentId) {
  return mongo.db.collection('documents').findOne(
    {_id: documentId, deletedAt: {$exists: false}}
  )
}

export async function updateDocument(documentId, payload) {
  const changes = validateDocumentChanges(payload)

  if (Object.keys(changes).length === 0) {
    throw createHttpError(400, 'Aucun champ valide trouvé.')
  }

  changes.updatedAt = new Date()

  const document = await mongo.db.collection('documents').findOneAndUpdate(
    {_id: documentId, deletedAt: {$exists: false}},
    {$set: changes},
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

  await s3('documents').deleteObject(document.objectKey)

  return document
}

export async function getPreleveurDocuments(preleveurId) {
  return mongo.db.collection('documents').find({
    preleveur: preleveurId,
    deletedAt: {$exists: false}}
  ).toArray()
}

export async function decorateDocument(document) {
  const documentUrl = await s3('documents').getPresignedUrl(document.objectKey)

  return {
    ...document,
    downloadUrl: documentUrl
  }
}
