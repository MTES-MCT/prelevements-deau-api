import createHttpError from 'http-errors'

import * as RegleModel from '../models/regle.js'
import {getDeclarant} from '../models/declarant.js'
import {getDocument} from '../models/document.js'
import {getExploitation} from '../models/exploitation.js'
import {decorateDocument} from './document.js'
import {validateRegleCreation, validateRegleChanges} from '../validation/regle-validation.js'

async function assertDocumentBelongsToDeclarant(documentId, declarantUserId) {
  if (!documentId) {
    return null
  }

  const document = await getDocument(documentId)
  if (!document) {
    throw createHttpError(400, 'Ce document est introuvable.')
  }

  if (document.declarantUserId !== declarantUserId) {
    throw createHttpError(400, 'Ce document n’est pas rattaché à ce déclarant.')
  }

  return document
}

async function assertExploitationsBelongToDeclarant(exploitationIds, declarantUserId) {
  if (!Array.isArray(exploitationIds) || exploitationIds.length === 0) {
    throw createHttpError(400, 'Au moins une exploitation est obligatoire.')
  }

  const exploitations = await Promise.all(
    exploitationIds.map(async exploitationId => getExploitation(exploitationId))
  )

  const missingIndex = exploitations.findIndex(exploitation => !exploitation)
  if (missingIndex !== -1) {
    throw createHttpError(400, `L'exploitation ${exploitationIds[missingIndex]} est introuvable.`)
  }

  const foreignIndex = exploitations.findIndex(
    exploitation => exploitation.declarantUserId !== declarantUserId
  )

  if (foreignIndex !== -1) {
    throw createHttpError(400, `L'exploitation ${exploitationIds[foreignIndex]} n’est pas rattachée à ce déclarant.`)
  }

  return exploitations
}

export async function createRegle(payload, declarantUserId) {
  const regle = validateRegleCreation(payload)

  const declarant = await getDeclarant(declarantUserId)
  if (!declarant) {
    throw createHttpError(400, 'Ce déclarant est introuvable.')
  }

  await assertDocumentBelongsToDeclarant(regle.documentId, declarantUserId)
  await assertExploitationsBelongToDeclarant(regle.exploitationIds, declarantUserId)

  return RegleModel.insertRegle({
    ...regle,
    declarantUserId
  })
}

export async function updateRegle(regleId, payload) {
  const existing = await RegleModel.getRegle(regleId)

  if (!existing) {
    throw createHttpError(404, 'Cette règle est introuvable.')
  }

  const changes = validateRegleChanges(payload)

  if (Object.keys(changes).length === 0) {
    throw createHttpError(400, 'Aucun champ valide trouvé.')
  }

  if (Object.hasOwn(changes, 'documentId')) {
    await assertDocumentBelongsToDeclarant(changes.documentId, existing.declarantUserId)
  }

  if (Object.hasOwn(changes, 'exploitationIds')) {
    await assertExploitationsBelongToDeclarant(changes.exploitationIds, existing.declarantUserId)
  }

  return RegleModel.updateRegleById(regleId, changes)
}

export async function deleteRegle(regleId) {
  const regle = await RegleModel.getRegle(regleId)

  if (!regle) {
    throw createHttpError(404, 'Cette règle est introuvable.')
  }

  return RegleModel.deleteRegle(regleId)
}

export async function decorateRegle(regle) {
  if (!regle) {
    return null
  }

  const document = regle.document
    ? await decorateDocument(regle.document)
    : null

  const exploitations = (regle.exploitations ?? [])
    .map(link => link.declarantPointPrelevement)
    .filter(Boolean)

  return {
    ...regle,
    document,
    documentId: document?.id ?? regle.documentId ?? null,
    exploitations,
    exploitationIds: exploitations.map(exploitation => exploitation.id)
  }
}
