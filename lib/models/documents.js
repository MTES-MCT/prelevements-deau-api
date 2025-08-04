import {nanoid} from 'nanoid'
import mongo from '../util/mongo.js'
import {validateDocumentCreation} from '../validation/document-validation.js'
import createHttpError from 'http-errors'
import s3 from '../util/s3.js'

export async function createDocument(payload, id_preleveur, codeTerritoire) {
  const document = validateDocumentCreation(payload)

  document.id_document = nanoid()
  document.territoire = codeTerritoire
  document.id_preleveur = id_preleveur
  document.createdAt = new Date()
  document.updatedAt = new Date()

  await mongo.db.collection('documents').insertOne(document)

  return document
}

export async function getDocument(idDocument) {
  return mongo.db.collection('documents').findOne(
    {id_document: idDocument, deleteAt: {$exists: false}}
  )
}

async function deleteDocumentFromS3(fileName) {
  await s3('document').deleteObject(fileName)
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

  await deleteDocumentFromS3(document.nom_fichier)
}

export async function uploadDocument(file) {
  const {originalname, buffer, size} = file

  if (!buffer) {
    throw createHttpError(400, 'Aucun fichier envoyé')
  }

  const exists = await s3('document').objectExists(originalname)

  if (exists) {
    throw createHttpError(409, 'Ce document est déjà dans la base')
  }

  await s3('document').uploadObject(originalname, buffer)

  return {
    nom: originalname,
    taille: size
  }
}

