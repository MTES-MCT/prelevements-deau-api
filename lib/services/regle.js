import createHttpError from 'http-errors'
import {parseObjectId} from '../util/mongo.js'

// Import des models
import * as RegleModel from '../models/regle.js'
import {getPreleveur} from '../models/preleveur.js'
import {getDocument} from '../models/document.js'
import {getExploitation} from '../models/exploitation.js'

// Import des services
import {decorateDocument} from './document.js'

// Import de la validation
import {validateRegleCreation, validateRegleChanges} from '../validation/regle-validation.js'

/**
 * Service layer pour les règles
 * Contient la logique métier et l'orchestration entre models
 */

/* Création avec validation croisée */

export async function createRegle(payload, preleveurId) {
  const regle = validateRegleCreation(payload)

  // Validation métier : le préleveur doit exister
  const preleveur = await getPreleveur(preleveurId)
  if (!preleveur) {
    throw createHttpError(400, 'Ce préleveur est introuvable.')
  }

  regle.preleveur = preleveurId

  // Validation métier : le document doit exister (si fourni)
  if (payload.document) {
    const documentId = parseObjectId(payload.document)
    const document = await getDocument(documentId)
    if (!document) {
      throw createHttpError(400, 'Ce document est introuvable.')
    }

    regle.document = documentId
  } else {
    regle.document = null
  }

  // Validation métier : les exploitations doivent exister
  if (payload.exploitations && payload.exploitations.length > 0) {
    const exploitationIds = payload.exploitations.map(id => parseObjectId(id))

    // Vérifier que toutes les exploitations existent
    const exploitations = await Promise.all(
      exploitationIds.map(id => getExploitation(id))
    )

    const missingIndex = exploitations.findIndex(e => !e)
    if (missingIndex !== -1) {
      throw createHttpError(400, `L'exploitation ${payload.exploitations[missingIndex]} est introuvable.`)
    }

    regle.exploitations = exploitationIds
  } else {
    regle.exploitations = []
  }

  return RegleModel.insertRegle(regle)
}

/* Mise à jour avec validation */

export async function updateRegle(regleId, payload) {
  const changes = validateRegleChanges(payload)

  if (Object.keys(changes).length === 0) {
    throw createHttpError(400, 'Aucun champ valide trouvé.')
  }

  // Note: le préleveur n'est pas modifiable après création

  // Si le document change, vérifier qu'il existe
  if (payload.document !== undefined) {
    if (payload.document) {
      const documentId = parseObjectId(payload.document)
      const document = await getDocument(documentId)
      if (!document) {
        throw createHttpError(400, 'Ce document est introuvable.')
      }

      changes.document = documentId
    } else {
      changes.document = null
    }
  }

  // Si les exploitations changent, vérifier qu'elles existent
  if (payload.exploitations) {
    const exploitationIds = payload.exploitations.map(id => parseObjectId(id))

    // Vérifier que toutes les exploitations existent
    const exploitations = await Promise.all(
      exploitationIds.map(id => getExploitation(id))
    )

    const missingIndex = exploitations.findIndex(e => !e)
    if (missingIndex !== -1) {
      throw createHttpError(400, `L'exploitation ${payload.exploitations[missingIndex]} est introuvable.`)
    }

    changes.exploitations = exploitationIds
  }

  return RegleModel.updateRegleById(regleId, changes)
}

/* Suppression */

export async function deleteRegle(regleId) {
  const regle = await RegleModel.getRegle(regleId)

  if (!regle) {
    throw createHttpError(404, 'Cette règle est introuvable.')
  }

  return RegleModel.deleteRegle(regleId)
}

/* Décoration */

export async function decorateRegle(regle) {
  const decorated = {...regle}

  // Résoudre le document
  if (regle.document) {
    const document = await getDocument(regle.document)
    decorated.document = document ? await decorateDocument(document) : null
  }

  // Résoudre les exploitations
  if (regle.exploitations && regle.exploitations.length > 0) {
    const exploitationsPromises = regle.exploitations.map(id => getExploitation(id))
    const exploitationsResults = await Promise.all(exploitationsPromises)
    decorated.exploitations = exploitationsResults.filter(Boolean)
  }

  return decorated
}
