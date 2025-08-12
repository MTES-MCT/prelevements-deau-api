import {chain} from 'lodash-es'
import createHttpError from 'http-errors'
import {ObjectId} from 'mongodb'

import {validateChanges, validateCreation} from '../validation/preleveur-validation.js'
import mongo from '../util/mongo.js'
import {getNextSeqId} from '../util/sequences.js'

import {preleveurHasExploitations, getPreleveurExploitations} from './exploitation.js'

export async function getPreleveur(preleveurId) {
  return mongo.db.collection('preleveurs').findOne(
    {_id: preleveurId}
  )
}

export async function getPreleveurBySeqId(codeTerritoire, idPreleveur) {
  return mongo.db.collection('preleveurs').findOne(
    {id_preleveur: idPreleveur, territoire: codeTerritoire}
  )
}

export async function getPreleveurs(codeTerritoire, includeDeleted = false) {
  return mongo.db.collection('preleveurs').find({
    territoire: codeTerritoire,
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
    ],
    deletedAt: {$exists: false}
  })
}

export async function createPreleveur(codeTerritoire, payload) {
  const preleveur = validateCreation(payload)

  if (!preleveur.nom && !preleveur.sigle && !preleveur.raison_sociale) {
    throw createHttpError(400, 'Au moins un des champs "nom", "sigle" ou "raison_sociale" est requis')
  }

  const nextId = await getNextSeqId(`territoire-${codeTerritoire}-preleveurs`)

  preleveur._id = new ObjectId()
  preleveur.id_preleveur = nextId
  preleveur.territoire = codeTerritoire
  preleveur.createdAt = new Date()
  preleveur.updatedAt = new Date()

  await mongo.db.collection('preleveurs').insertOne(preleveur)

  return preleveur
}

export async function updatePreleveur(preleveurId, payload) {
  const changes = validateChanges(payload)

  if (Object.keys(changes).length === 0) {
    throw createHttpError(400, 'Aucun champ valide trouvé.')
  }

  changes.updatedAt = new Date()

  const preleveur = await mongo.db.collection('preleveurs').findOneAndUpdate(
    {_id: preleveurId, deletedAt: {$exists: false}},
    {$set: changes},
    {returnDocument: 'after'}
  )

  if (!preleveur) {
    throw createHttpError(404, 'Ce préleveur est introuvable.')
  }

  return preleveur
}

export async function deletePreleveur(preleveurId) {
  if (await preleveurHasExploitations(preleveurId)) {
    throw createHttpError(409, 'Ce préleveur a des exploitations associées.')
  }

  return mongo.db.collection('preleveurs').findOneAndUpdate(
    {_id: preleveurId, deletedAt: {$exists: false}},
    {$set: {
      deletedAt: new Date(),
      updatedAt: new Date()
    }},
    {returnDocument: 'after'}
  )
}

export async function bulkDeletePreleveurs(codeTerritoire) {
  await mongo.db.collection('preleveurs').deleteMany({territoire: codeTerritoire})
}

export async function bulkInsertPreleveurs(codeTerritoire, preleveurs) {
  if (preleveurs.length === 0) {
    return {insertedCount: 0}
  }

  const preleveursToInsert = preleveurs.map(preleveur => ({
    ...preleveur,
    territoire: codeTerritoire,
    createdAt: new Date(),
    updatedAt: new Date()
  }))

  const {insertedCount} = await mongo.db.collection('preleveurs').insertMany(preleveursToInsert)

  return {insertedCount}
}

/* Decorators */

export async function decoratePreleveur(preleveur) {
  const exploitations = await getPreleveurExploitations(
    preleveur._id,
    {usages: 1, id_exploitation: 1}
  )

  return {
    ...preleveur,
    exploitations,
    usages: chain(exploitations).map('usages').flatten().uniq().value()
  }
}
