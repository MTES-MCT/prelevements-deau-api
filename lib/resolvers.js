import createHttpError from 'http-errors'

import mongo from './util/mongo.js'

import {
  getPointPrelevement,
  getPointBySeqId
} from './models/point-prelevement.js'

import {
  getPreleveur,
  getPreleveurBySeqId
} from './models/preleveur.js'

import {
  getExploitation,
  getExploitationBySeqId
} from './models/exploitation.js'

import * as Dossier from './models/dossier.js'
import {getDocument} from './models/document.js'

export async function handleDossier(req, res, next) {
  const dossierId = mongo.parseObjectId(req.params.dossierId)
  req.dossier = await Dossier.getDossier(dossierId)

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
  const attachmentId = mongo.parseObjectId(req.params.attachmentId)

  if (!attachmentId) {
    throw createHttpError(400, 'Invalid attachment ID')
  }

  req.attachment = await Dossier.getAttachment(attachmentId)

  if (!req.attachment) {
    throw createHttpError(404, 'Attachment not found')
  }

  if (req.attachment.dossierNumber !== req.dossier.number) {
    throw createHttpError(400, 'This attachment does not belong to the specified dossier')
  }

  next()
}

export async function handlePoint(req, res, next) {
  let pointId = mongo.parseObjectId(req.params.pointId)

  if (pointId) {
    req.point = await getPointPrelevement(pointId)
  }

  pointId ||= parsePositiveInteger(req.params.pointId)

  if (pointId && !req.point) {
    req.point = await getPointBySeqId(req.territoire.code, pointId)
  }

  if (!req.point) {
    throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
  }

  next()
}

export async function handlePreleveur(req, res, next) {
  let preleveurId = mongo.parseObjectId(req.params.preleveurId)

  if (preleveurId) {
    req.preleveur = await getPreleveur(preleveurId)
  }

  preleveurId ||= parsePositiveInteger(req.params.preleveurId)

  if (preleveurId && !req.preleveur) {
    req.preleveur = await getPreleveurBySeqId(req.territoire.code, preleveurId)
  }

  if (!req.preleveur) {
    throw createHttpError(404, 'Ce préleveur est introuvable.')
  }

  next()
}

export async function handleExploitation(req, res, next) {
  let exploitationId = mongo.parseObjectId(req.params.exploitationId)

  if (exploitationId) {
    req.exploitation = await getExploitation(exploitationId)
  }

  exploitationId ||= parsePositiveInteger(req.params.exploitationId)

  if (exploitationId && !req.exploitation) {
    req.exploitation = await getExploitationBySeqId(req.territoire.code, exploitationId)
  }

  if (!req.exploitation) {
    throw createHttpError(404, 'Cette exploitation est introuvable.')
  }

  next()
}

export async function handleDocument(req, res, next) {
  const documentId = mongo.parseObjectId(req.params.documentId)

  if (documentId) {
    req.document = await getDocument(documentId)
  }

  if (!req.document) {
    throw createHttpError(404, 'Ce document est introuvable')
  }

  next()
}
