import createHttpError from 'http-errors'
import {ObjectId} from 'mongodb'

import mongo from '../util/mongo.js'
import {getNextSeqId} from '../util/sequences.js'

export async function getPreleveur(preleveurId) {
  return mongo.db.collection('preleveurs').findOne(
    {_id: preleveurId}
  )
}

export async function getPreleveurBySeqId(idPreleveur) {
  return mongo.db.collection('preleveurs').findOne(
    {id_preleveur: idPreleveur}
  )
}

export async function getPreleveurs(includeDeleted = false) {
  return mongo.db.collection('preleveurs').find({
    ...(includeDeleted ? {} : {deletedAt: {$exists: false}})
  }).toArray()
}

export async function getPreleveursByIds(preleveurIds, includeDeleted = false) {
  return mongo.db.collection('preleveurs').find({
    _id: {$in: preleveurIds},
    ...(includeDeleted ? {} : {deletedAt: {$exists: false}})
  }).toArray()
}

export async function getPreleveurByEmail(email) {
  const candidate = email.toLowerCase().trim()

  return mongo.db.collection('preleveurs').findOne({
    $or: [
      {email: candidate},
      {autresEmails: candidate}
    ]
  })
}

/* Insertion (utilisé par le service) */

export async function insertPreleveur(codeTerritoire, preleveur) {
  const nextId = await getNextSeqId('preleveurs')

  preleveur._id = new ObjectId()
  preleveur.id_preleveur = nextId
  preleveur.createdAt = new Date()
  preleveur.updatedAt = new Date()

  await mongo.db.collection('preleveurs').insertOne(preleveur)

  return preleveur
}

/* Mise à jour par ID (utilisé par le service) */

export async function updatePreleveurById(preleveurId, changes) {
  if (!changes || typeof changes !== 'object') {
    throw createHttpError(400, 'Les modifications doivent être un objet.')
  }

  const update = {
    ...changes,
    updatedAt: new Date()
  }

  const preleveur = await mongo.db.collection('preleveurs').findOneAndUpdate(
    {_id: preleveurId, deletedAt: {$exists: false}},
    {$set: update},
    {returnDocument: 'after'}
  )

  if (!preleveur) {
    throw createHttpError(404, 'Ce préleveur est introuvable.')
  }

  return preleveur
}

/* Suppression par ID (utilisé par le service) */

export async function deletePreleveurById(preleveurId) {
  return mongo.db.collection('preleveurs').findOneAndUpdate(
    {_id: preleveurId, deletedAt: {$exists: false}},
    {$set: {
      deletedAt: new Date(),
      updatedAt: new Date()
    }},
    {returnDocument: 'after'}
  )
}

/* CRUD pour imports en masse */

export async function bulkInsertPreleveurs(preleveurs) {
  if (preleveurs.length === 0) {
    return {insertedCount: 0}
  }

  const preleveursToInsert = preleveurs.map(preleveur => ({
    ...preleveur,
    createdAt: new Date(),
    updatedAt: new Date()
  }))

  const {insertedCount} = await mongo.db.collection('preleveurs').insertMany(preleveursToInsert)

  return {insertedCount}
}
