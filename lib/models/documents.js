import {nanoid} from 'nanoid'
import mongo, {ObjectId} from '../util/mongo.js'
import {validateDocumentCreation} from '../validation/document-validation.js'
import createHttpError from 'http-errors'
import s3 from '../util/s3.js'

export async function createDocument(payload, file, idPreleveur, codeTerritoire) {
  const document = validateDocumentCreation(payload)
  const objectKey = nanoid()

  await uploadDocument(file, objectKey)

  document._id = new ObjectId()
  document.id_document = objectKey
  document.territoire = codeTerritoire
  document.preleveur = idPreleveur
  document.createdAt = new Date()
  document.updatedAt = new Date()

  try {
    await mongo.db.collection('documents').insertOne(document)

    return document
  } catch (error) {
    await deleteDocumentFromS3(objectKey)

    throw createHttpError(500, 'Erreur lors de la création du document en base : ' + error.message)
  }
}

export async function getDocument(idDocument) {
  return mongo.db.collection('documents').findOne(
    {id_document: idDocument, deletedAt: {$exists: false}}
  )
}

async function deleteDocumentFromS3(fileName) {
  await s3('documents').deleteObject(fileName)
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

  await deleteDocumentFromS3(document.id_document)
}

export async function uploadDocument(file, objectKey) {
  const {originalname, buffer, size} = file

  if (!buffer) {
    throw createHttpError(400, 'Aucun fichier envoyé')
  }

  const exists = await s3('documents').objectExists(objectKey)

  if (exists) {
    throw createHttpError(409, 'Ce document est déjà dans la base')
  }

  await s3('documents').uploadObject(objectKey, buffer)

  return {
    nom_fichier: originalname,
    objectKey,
    taille: size
  }
}

export async function getPreleveurDocuments(idPreleveur) {
  return mongo.db.collection('documents').find({
    preleveur: idPreleveur,
    deletedAt: {$exists: false}}
  ).toArray()
}
