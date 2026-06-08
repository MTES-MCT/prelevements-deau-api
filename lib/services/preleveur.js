import {chain} from 'lodash-es'
import createHttpError from 'http-errors'

import * as DeclarantModel from '../models/declarant.js'
import {declarantHasExploitations, getDeclarantExploitations} from '../models/exploitation.js'

import {validateCreation, validateChanges} from '../validation/preleveur-validation.js'

/**
 * Service layer pour les préleveurs et collecteurs.
 * Contient la logique métier et l'orchestration entre models.
 */

function assertRequiredIdentityFields(declarant) {
  if (declarant.declarantType === 'LEGAL_PERSON' && !declarant.socialReason) {
    throw createHttpError(400, 'La raison sociale est obligatoire pour une personne morale.')
  }

  if (declarant.declarantType !== 'LEGAL_PERSON' && (!declarant.firstName || !declarant.lastName)) {
    throw createHttpError(400, 'Le prénom et le nom sont obligatoires pour une personne physique.')
  }
}

function assertEmailPolicy(declarant) {
  if (declarant.declarantRole === 'COLLECTEUR' && !declarant.email) {
    throw createHttpError(400, 'L\'email est obligatoire pour un collecteur.')
  }
}

/* Création avec validation métier */

export async function createPreleveur(payload) {
  const preleveur = validateCreation(payload)
  preleveur.declarantRole ??= 'PRELEVEUR'

  assertRequiredIdentityFields(preleveur)
  assertEmailPolicy(preleveur)

  return DeclarantModel.insertDeclarant(preleveur)
}

/* Mise à jour avec validation */

export async function updatePreleveur(preleveurId, payload) {
  const changes = validateChanges(payload)

  if (Object.keys(changes).length === 0) {
    throw createHttpError(400, 'Aucun champ valide trouvé.')
  }

  const existing = await DeclarantModel.getDeclarantById(preleveurId)
  const merged = {
    ...existing,
    ...changes,
    firstName: changes.firstName ?? existing?.firstName,
    lastName: changes.lastName ?? existing?.lastName,
    email: Object.hasOwn(changes, 'email') ? changes.email : existing?.email
  }

  assertRequiredIdentityFields(merged)
  assertEmailPolicy(merged)

  return DeclarantModel.updateDeclarantById(preleveurId, changes)
}

/* Suppression avec validation métier */

export async function deletePreleveur(preleveurId) {
  if (await declarantHasExploitations(preleveurId)) {
    throw createHttpError(409, 'Ce déclarant a des exploitations ou des droits collecteur associés.')
  }

  return DeclarantModel.deleteDeclarantById(preleveurId)
}

/* Décorateur */

export async function decoratePreleveur(preleveur) {
  const exploitations = await getDeclarantExploitations(
    preleveur._id,
    {usages: true, id: true}
  )

  return {
    ...preleveur,
    exploitations,
    usages: chain(exploitations).map('usages').flatten().uniq().value()
  }
}
