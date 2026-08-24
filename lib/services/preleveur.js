import createHttpError from 'http-errors'

import * as DeclarantModel from '../models/declarant.js'
import {declarantHasExploitations, getDeclarantExploitations} from '../models/exploitation.js'

import {validateCreation, validateChanges} from '../validation/preleveur-validation.js'
import {
  getExploitationWaterUses,
  serializeExploitationUsageFields
} from './exploitation-usages.js'
import {serializeWaterUse} from './sandre-water-uses.js'
import {normalizePreleveurType} from './preleveur-types.js'

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

function assertPreleveurTypeUpdatePolicy(existing, changes, merged) {
  const typeWasProvided = Object.hasOwn(changes, 'preleveurType')

  if (merged.declarantRole === 'COLLECTEUR') {
    if (typeWasProvided && changes.preleveurType !== null) {
      throw createHttpError(400, 'Le type de préleveur ne s’applique pas aux collecteurs.')
    }

    return
  }

  const becomesPreleveur = existing?.declarantRole === 'COLLECTEUR'
    && merged.declarantRole === 'PRELEVEUR'

  if ((becomesPreleveur && !typeWasProvided)
    || (typeWasProvided && !changes.preleveurType)) {
    throw createHttpError(400, 'Le type de préleveur est obligatoire pour un préleveur.')
  }
}

/* Création avec validation métier */

export async function createPreleveur(payload, options = {}, {
  strictPreleveurType = true,
  declarantModel = DeclarantModel
} = {}) {
  const preleveur = validateCreation(payload, {
    requirePreleveurType: strictPreleveurType
  })
  preleveur.declarantRole ??= 'PRELEVEUR'

  if (strictPreleveurType
    && preleveur.declarantRole === 'COLLECTEUR'
    && preleveur.preleveurType !== undefined
    && preleveur.preleveurType !== null) {
    throw createHttpError(400, 'Le type de préleveur ne s’applique pas aux collecteurs.')
  }

  preleveur.preleveurType = normalizePreleveurType(preleveur)

  assertRequiredIdentityFields(preleveur)
  assertEmailPolicy(preleveur)

  return declarantModel.insertDeclarant(preleveur, options)
}

/* Mise à jour avec validation */

export async function updatePreleveur(preleveurId, payload, {
  strictPreleveurType = true,
  declarantModel = DeclarantModel
} = {}) {
  const changes = validateChanges(payload)

  if (Object.keys(changes).length === 0) {
    throw createHttpError(400, 'Aucun champ valide trouvé.')
  }

  const existing = await declarantModel.getDeclarantById(preleveurId)
  const merged = {
    ...existing,
    ...changes,
    firstName: changes.firstName ?? existing?.firstName,
    lastName: changes.lastName ?? existing?.lastName,
    email: Object.hasOwn(changes, 'email') ? changes.email : existing?.email
  }

  assertRequiredIdentityFields(merged)
  assertEmailPolicy(merged)
  if (strictPreleveurType) {
    assertPreleveurTypeUpdatePolicy(existing, changes, merged)
  }

  const preleveurType = normalizePreleveurType(merged)
  if (preleveurType !== merged.preleveurType) {
    changes.preleveurType = preleveurType
  }

  return declarantModel.updateDeclarantById(preleveurId, changes)
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
    {
      usage: true,
      secondaryUsageLinks: {
        include: {usage: true}
      }
    }
  )
  const usagesById = new Map()

  for (const exploitation of exploitations) {
    for (const usage of getExploitationWaterUses(exploitation)) {
      if (usage.id) {
        usagesById.set(usage.id, serializeWaterUse(usage))
      }
    }
  }

  return {
    ...preleveur,
    exploitations: exploitations.map(serializeExploitationUsageFields),
    usages: [...usagesById.values()]
  }
}
