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

export async function handlePoint(req, res, next) {
  const {pointId} = req.params

  const isUuid = Joi.string()
    .guid({version: 'uuidv4'})
    .validate(pointId).error === undefined

  const point = await (isUuid ? getPointPrelevement(pointId) : getPointPrelevementByName(pointId))

  if (!point) {
    throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
  }

  req.point = point

  next()
}

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
