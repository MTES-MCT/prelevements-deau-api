import {customAlphabet} from 'nanoid'
import mongo, {ObjectId} from '../util/mongo.js'
import {validateDocumentCreation} from '../validation/document-validation.js'
import createHttpError from 'http-errors'
import s3 from '../util/s3.js'

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 10)

export async function createDocument(payload, file, idPreleveur, territoire) {
  const document = validateDocumentCreation(payload)
  const {originalname, buffer, size} = file
  const objectKey = `${territoire.code}/${idPreleveur}/${nanoid()}/${originalname}`

  if (!buffer) {
    throw createHttpError(400, 'Aucun fichier envoyé')
  }

  await s3('documents').uploadObject(objectKey, buffer, {filename: originalname})

  document._id = new ObjectId()
  document.id_document = objectKey
  document.territoire = territoire
  document.preleveur = idPreleveur
  document.nom_fichier = originalname
  document.taille = size
  document.createdAt = new Date()
  document.updatedAt = new Date()

  try {
    await mongo.db.collection('documents').insertOne(document)

    return document
  } catch (error) {
    await s3('documents').deleteObject(objectKey)

    throw createHttpError(500, 'Erreur lors de la création du document en base : ' + error.message)
  }
}

export async function getDocument(documentId) {
  return mongo.db.collection('documents').findOne(
    {_id: documentId, deletedAt: {$exists: false}}
  )
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

  await s3('documents').deleteObject(document.id_document)

  return document
}

export async function getPreleveurDocuments(idPreleveur) {
  return mongo.db.collection('documents').find({
    preleveur: idPreleveur,
    deletedAt: {$exists: false}}
  ).toArray()
}
