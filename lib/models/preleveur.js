import {nanoid} from 'nanoid'
import mongo from '../util/mongo.js'
import {chain} from 'lodash-es'
import {validateChanges, validateCreation} from '../validation/preleveur-validation.js'
import createHttpError from 'http-errors'

export async function decoratePreleveur(preleveur) {
  const exploitations = await mongo.db.collection('exploitations').find(
    {preleveur: preleveur._id, deletedAt: {$exists: false}},
    {projection: {
      usages: 1,
      id_exploitation: 1
    }}
  ).toArray()

  return {
    ...preleveur,
    exploitations,
    usages: chain(exploitations).map('usages').flatten().uniq().value()
  }
}

export async function getPreleveur(preleveurId) {
  return mongo.db.collection('preleveurs').findOne(
    {_id: preleveurId, deletedAt: {$exists: false}}
  )
}

export async function getPreleveurs() {
  return mongo.db.collection('preleveurs').find(
    {deletedAt: {$exists: false}}
  ).toArray()
}

export async function getPreleveursFromTerritoire(codeTerritoire) {
  return mongo.db.collection('preleveurs').find(
    {deletedAt: {$exists: false}, territoire: codeTerritoire}
  ).toArray()
}

export async function getPreleveurByEmail(email) {
  return mongo.db.collection('preleveurs').findOne({
    email: email.toLowerCase().trim(),
    deletedAt: {$exists: false}
  })
}

export async function createPreleveur(payload, codeTerritoire) {
  const preleveur = validateCreation(payload)

  if (!preleveur.nom && !preleveur.sigle && !preleveur.raison_sociale) {
    throw createHttpError(400, 'Au moins un des champs "nom", "sigle" ou "raison_sociale" est requis')
  }

  preleveur.id_preleveur = nanoid()
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
  const preleveurExploitation = await mongo.db.collection('exploitations').findOne(
    {preleveur: preleveurId, deletedAt: {$exists: false}}
  )

  if (preleveurExploitation) {
    throw createHttpError(409, 'Ce préleveur est encore rattaché à l’exploitation : ' + preleveurExploitation.id_exploitation)
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
