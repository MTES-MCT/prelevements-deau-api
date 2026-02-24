import createHttpError from 'http-errors'

import {parseObjectId} from './util/mongo.js'

import {
  getPointPrelevement, getPointPrelevementByName
} from './models/point-prelevement.js'

import {
  getDeclarant
} from './models/declarant.js'

import {
  getExploitation
} from './models/exploitation.js'

import {
  getSeriesById
} from './models/series.js'

import {
  getDossier,
  getAttachment
} from './models/dossier.js'

import {getDocument} from './models/document.js'

import {getRegle} from './models/regle.js'
import Joi from "joi";

export async function handleDossier(req, res, next) {
  const dossierId = parseObjectId(req.params.dossierId)
  req.dossier = await getDossier(dossierId)

  if (!req.dossier) {
    throw createHttpError(404, 'Dossier not found')
  }

  next()
}

function parsePositiveInteger(string) {
  const n = Number(string)
  if (Number.isInteger(n) && n > 0) {
    return n
  }

  return null
}

export async function handleAttachment(req, res, next) {
  const attachmentId = parseObjectId(req.params.attachmentId)

  if (!attachmentId) {
    throw createHttpError(400, 'Invalid attachment ID')
  }

  req.attachment = await getAttachment(attachmentId)

  if (!req.attachment) {
    throw createHttpError(404, 'Attachment not found')
  }

  if (!req.attachment.dossierId.equals(req.dossier._id)) {
    throw createHttpError(400, 'This attachment does not belong to the specified dossier')
  }

  next()
}

export async function handlePoint(req, res, next) {
  const {pointId} = req.params

  let point

  const isUuid = Joi.string()
    .guid({version: 'uuidv4'})
    .validate(pointId).error === undefined

  console.log('isUuid', isUuid)

  if (isUuid) {
    point = await getPointPrelevement(pointId)
  } else {
    point = await getPointPrelevementByName(pointId)
  }

  if (!point) {
    throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
  }

  req.point = point

  next()
}

export async function handlePreleveur(req, res, next) {
  const preleveurId = parseObjectId(req.params.preleveurId)

  if (preleveurId) {
    req.preleveur = await getDeclarant(preleveurId)
  }

  if (!req.preleveur) {
    throw createHttpError(404, 'Ce préleveur est introuvable.')
  }

  next()
}

export async function handleDeclarant(req, res, next) {
  const declarantId = req.params.declarantId

  if (declarantId) {
    req.preleveur = await getDeclarant(declarantId)
  }

  if (!req.preleveur) {
    throw createHttpError(404, 'Ce déclarant est introuvable.')
  }

  next()
}

export async function handleExploitation(req, res, next) {
  const exploitationId = req.params.exploitationId

  if (exploitationId) {
    req.exploitation = await getExploitation(exploitationId)
  }

  if (!req.exploitation) {
    throw createHttpError(404, 'Cette exploitation est introuvable.')
  }

  next()
}

export async function handleDocument(req, res, next) {
  const documentId = parseObjectId(req.params.documentId)

  if (documentId) {
    req.document = await getDocument(documentId)
  }

  if (!req.document) {
    throw createHttpError(404, 'Ce document est introuvable')
  }

  next()
}

export async function handleSeries(req, res, next) {
  const seriesId = parseObjectId(req.params.seriesId)

  if (!seriesId) {
    throw createHttpError(400, 'Identifiant de série invalide')
  }

  req.series = await getSeriesById(seriesId)

  if (!req.series) {
    throw createHttpError(404, 'Série introuvable')
  }

  next()
}

export async function handleRegle(req, res, next) {
  const regleId = parseObjectId(req.params.regleId)

  if (!regleId) {
    throw createHttpError(400, 'Identifiant de règle invalide')
  }

  req.regle = await getRegle(regleId)

  if (!req.regle) {
    throw createHttpError(404, 'Cette règle est introuvable.')
  }

  next()
}
