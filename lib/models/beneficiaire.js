import {nanoid} from 'nanoid'
import mongo from '../util/mongo.js'
import {chain} from 'lodash-es'
import {validateChanges, validateCreation} from '../validation/preleveur-validation.js'
import createHttpError from 'http-errors'

export async function decorateBeneficiaire(beneficiaire) {
  const exploitations = await mongo.db.collection('exploitations').find(
    {id_beneficiaire: beneficiaire.id_beneficiaire},
    {projection: {
      usages: 1,
      id_exploitation: 1
    }}
  ).toArray()

  return {
    ...beneficiaire,
    exploitations,
    usages: chain(exploitations).map('usages').flatten().uniq().value()
  }
}

export async function getBeneficiaire(idBeneficiaire) {
  return mongo.db.collection('preleveurs').findOne(
    {id_beneficiaire: idBeneficiaire, deletedAt: {$exists: false}}
  )
}

export async function getBeneficiaires() {
  return mongo.db.collection('preleveurs').find({deletedAt: {$exists: false}}).toArray()
}

export async function getBeneficiaireByEmail(email) {
  mongo.db.collection('preleveurs').findOne({email, deletedAt: {$exists: false}})
}

export async function createPreleveur(payload) {
  const preleveur = validateCreation(payload)

  if (!preleveur.nom && !preleveur.sigle && !preleveur.raison_sociale) {
    throw createHttpError(409, 'Au moins un des champs "nom", "sigle" ou "raison_sociale"')
  }

  if (payload.commune) {
    const response = await fetch(`https://geo.api.gouv.fr/communes/${payload.commune}`)

    if (response.status === 404) {
      throw createHttpError(400, 'Ce code commune est inconnu')
    }
  }

  preleveur.id_beneficiaire = nanoid()
  preleveur.createdAt = new Date()
  preleveur.updatedAt = new Date()

  await mongo.db.collection('preleveurs').insertOne(preleveur)

  return preleveur
}

export async function updatePreleveur(idPreleveur, payload) {
  const changes = validateChanges(payload)

  if (Object.keys(changes).length === 0) {
    throw createHttpError(400, 'Aucun champ valide trouvé.')
  }

  changes.updatedAt = new Date()

  const preleveur = await mongo.db.collection('preleveurs').findOneAndUpdate(
    {id_beneficiaire: idPreleveur, deletedAt: {$exists: false}},
    {$set: changes},
    {returnDocument: 'after'}
  )

  if (!preleveur) {
    throw createHttpError(404, 'Ce préleveur est introuvable.')
  }

  return preleveur
}

export async function deletePreleveur(idPreleveur) {
  const activeExploitation = await mongo.db.collection('exploitations').findOne(
    {id_beneficiaire: idPreleveur, statut: 'En activité'}
  )

  if (activeExploitation) {
    throw createHttpError(409, 'Ce préleveur est encore en activité sur l’exploitation : ' + activeExploitation.id_exploitation)
  }

  return mongo.db.collection('preleveurs').findOneAndUpdate(
    {id_beneficiaire: idPreleveur, deletedAt: {$exists: false}},
    {$set: {
      deletedAt: new Date(),
      updatedAt: new Date()
    }},
    {returnDocument: 'after'}
  )
}
