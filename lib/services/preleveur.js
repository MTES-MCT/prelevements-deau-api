import {chain} from 'lodash-es'
import createHttpError from 'http-errors'

import * as DeclarantModel from '../models/declarant.js'
import {declarantHasExploitations, getDeclarantExploitations} from '../models/exploitation.js'

import {validateCreation, validateChanges} from '../validation/preleveur-validation.js'

/**
 * Service layer pour les préleveurs
 * Contient la logique métier et l'orchestration entre models
 */

/* Création avec validation métier */

export async function createPreleveur(payload) {
  const preleveur = validateCreation(payload)

  if (!preleveur.email) {
    throw createHttpError(400, 'L\'email est obligatoire.')
  }

  if (preleveur.declarantType === 'LEGAL_PERSON' && !preleveur.socialReason) {
    throw createHttpError(400, 'La raison sociale est obligatoire pour une personne morale.')
  }

  if (preleveur.declarantType !== 'LEGAL_PERSON' && (!preleveur.firstName || !preleveur.lastName)) {
    throw createHttpError(400, 'Le prénom et le nom sont obligatoires pour une personne physique.')
  }

  return DeclarantModel.insertDeclarant(preleveur)
}

/* Mise à jour avec validation */

export async function updatePreleveur(preleveurId, payload) {
  const changes = validateChanges(payload)

  if (Object.keys(changes).length === 0) {
    throw createHttpError(400, 'Aucun champ valide trouvé.')
  }

  return DeclarantModel.updateDeclarantById(preleveurId, changes)
}

/* Suppression avec validation métier */

export async function deletePreleveur(preleveurId) {
  if (await declarantHasExploitations(preleveurId)) {
    throw createHttpError(409, 'Ce préleveur a des exploitations associées.')
  }

  return DeclarantModel.deleteDeclarantById(preleveurId)
}

/* Décorateur */

export async function decoratePreleveur(preleveur) {
  const exploitations = await getDeclarantExploitations(
    preleveur._id,
    {usages: 1, id_exploitation: 1}
  )

  return {
    ...preleveur,
    exploitations,
    usages: chain(exploitations).map('usages').flatten().uniq().value()
  }
}
