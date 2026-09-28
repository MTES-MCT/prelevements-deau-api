import createHttpError from 'http-errors'

import {
  getPointPrelevement, getPointPrelevementByName
} from './models/point-prelevement.js'

import {
  getDeclarant
} from './models/declarant.js'

import {
  getExploitation
} from './models/exploitation.js'

import {getDocument} from './models/document.js'

import {getRegle} from './models/regle.js'
import Joi from 'joi'
import {resourceIdSchema} from './validation/resource-id.js'
import {prisma} from '../db/prisma.js'
import {resolvePointImportAlias} from './services/import-aliases.js'
import {addAuditMetadata, setAuditTarget} from './audit/context.js'
import {captureInitialAuditMutation} from './audit/mutations.js'

export function createPointResolver({
  resolveAlias = id => resolvePointImportAlias(prisma, id),
  getById = getPointPrelevement,
  getByName = getPointPrelevementByName,
  captureMutation = req => captureInitialAuditMutation(req, req.auditAction, prisma)
} = {}) {
  return async function handlePoint(req, res, next) {
    const {pointId} = req.params

    const isUuid = resourceIdSchema.validate(pointId).error === undefined
    let canonicalId = pointId
    if (isUuid) {
      try {
        canonicalId = await resolveAlias(pointId)
      } catch (error) {
        if (error.message.startsWith('IMPORT_ALIAS_')) throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
        throw error
      }
    }
    const point = await (isUuid ? getById(canonicalId) : getByName(pointId))

    if (!point || point.deletedAt) {
      throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
    }

    req.point = point
    if (canonicalId !== pointId) {
      req.params.pointId = canonicalId
      addAuditMetadata(req, {requestedPointId: pointId})
      if (req.auditAction?.target?.param === 'pointId') {
        setAuditTarget(req, {type: 'POINT', id: canonicalId})
        // Audit starts before route parameters are resolved. Replace its stale
        // source snapshot and scopes before any write to the surviving point.
        req.auditAction.params.pointId = canonicalId
        await captureMutation(req)
      }
    }

    next()
  }
}

export const handlePoint = createPointResolver()

export async function handleDeclarant(req, res, next) {
  const {declarantId} = req.params

  if (declarantId) {
    req.declarant = await getDeclarant(declarantId)
  }

  if (!req.declarant) {
    throw createHttpError(404, 'Ce déclarant est introuvable.')
  }

  next()
}

export async function handleExploitation(req, res, next) {
  const {exploitationId} = req.params

  if (exploitationId) {
    req.exploitation = await getExploitation(exploitationId)
  }

  if (!req.exploitation) {
    throw createHttpError(404, 'Cette exploitation est introuvable.')
  }

  next()
}

export async function handleDocument(req, res, next) {
  const {documentId} = req.params

  const isUuid = Joi.string().guid({version: 'uuidv4'}).validate(documentId).error === undefined

  if (isUuid) {
    req.document = await getDocument(documentId)
  }

  if (!req.document) {
    throw createHttpError(isUuid ? 404 : 400, isUuid ? 'Ce document est introuvable' : 'Identifiant de document invalide')
  }

  next()
}

export async function handleRegle(req, res, next) {
  const {regleId} = req.params

  const isUuid = Joi.string().guid({version: 'uuidv4'}).validate(regleId).error === undefined

  if (isUuid) {
    req.regle = await getRegle(regleId)
  }

  if (!req.regle) {
    throw createHttpError(isUuid ? 404 : 400, isUuid ? 'Cette règle est introuvable.' : 'Identifiant de règle invalide')
  }

  next()
}
