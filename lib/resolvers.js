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
  getExploitation
} from './models/exploitation.js'

import * as Dossier from './models/dossier.js'

export async function handleDossier(req, res, next) {
  const dossierId = mongo.parseObjectId(req.params.dossierId)
  req.dossier = await Dossier.getDossier(dossierId)

  if (!req.dossier) {
    throw createHttpError(404, 'Dossier not found')
  }

  next()
}

export async function handlePoint(req, res, next) {
  const pointId = mongo.parseObjectId(req.params.pointId)

  req.point = pointId
    ? await getPointPrelevement(pointId)
    : await getPointBySeqId(req.territoire.code, req.params.pointId)

  if (!req.point) {
    throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
  }

  next()
}

export async function handlePreleveur(req, res, next) {
  const preleveurId = mongo.parseObjectId(req.params.preleveurId)

  req.preleveur = preleveurId
    ? await getPreleveur(preleveurId)
    : await getPreleveurBySeqId(req.territoire.code, req.params.preleveurId)

  if (!req.preleveur) {
    throw createHttpError(404, 'Ce préleveur est introuvable.')
  }

  next()
}

export async function handleExploitation(req, res, next) {
  const exploitationId = mongo.parseObjectId(req.params.exploitationId)

  req.exploitation = await getExploitation(exploitationId)

  if (!req.exploitation) {
    throw createHttpError(404, 'Cette exploitation est introuvable.')
  }

  next()
}
