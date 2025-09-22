import {customAlphabet} from 'nanoid'
import mongo, {ObjectId} from '../util/mongo.js'
import {validateDocumentCreation} from '../validation/document-validation.js'
import createHttpError from 'http-errors'
import s3 from '../util/s3.js'

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 10)

export async function createDocument(payload, file, idPreleveur, territoire) {
  const document = validateDocumentCreation(payload)
  const {originalname, buffer, size} = file
  const objectKey = `${territoire.code}/${idPreleveur}/${document.date_ajout || nanoid()}/${originalname}`

  if (!buffer) {
    throw createHttpError(400, 'Aucun fichier envoyé')
  }

  const exists = await s3('documents').objectExists(objectKey)

  if (exists) {
    throw createHttpError(409, 'Ce document est déjà dans la base')
  }

  await s3('documents').uploadObject(objectKey, buffer)

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

export async function getDocument(idDocument) {
  return mongo.db.collection('documents').findOne(
    {id_document: idDocument, deletedAt: {$exists: false}}
  )
}

export async function deleteDocument(idDocument) {
  const document = await mongo.db.collection('documents').findOneAndUpdate(
    {id_document: idDocument, deletedAt: {$exists: false}},
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
