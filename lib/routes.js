import process from 'node:process'
import express, {Router} from 'express'
import createHttpError from 'http-errors'

import mongo from './util/mongo.js'
import w from './util/w.js'
import {downloadFile, objectExists} from './util/s3.js'

import * as Dossier from './models/dossier.js'
import {getFileS3Key} from './demarches-simplifiees/index.js'
import {validateFile} from './demarches-simplifiees/validation.js'

import {
  getPointsPrelevement,
  getPointPrelevement,
  getExploitation,
  getReglesFromExploitationId,
  getBeneficiaire,
  getRegle,
  getDocument
  getExploitationsFromPointId,
  getBeneficiairesFromPointId,
} from './models/points-prelevement.js'

export const handleDossier = w(async (req, res, next) => {
  const dossierId = mongo.parseObjectId(req.params.dossierId)
  req.dossier = await Dossier.getDossier(dossierId)

  if (!req.dossier) {
    throw createHttpError(404, 'Dossier not found')
  }

  next()
})

async function createRoutes() {
  const app = new Router()

  // Authenticate user / runner
  app.use(w(async (req, res, next) => {
    if (!req.get('Authorization')) {
      return next()
    }

    const token = req.get('Authorization').split(' ')[1]

    if (token !== process.env.TOKEN) {
      return next(createHttpError(401, 'Unauthorized'))
    }

    next()
  }))

  /* Resolvers */

  app.param('dossierId', handleDossier)

  /* Dossiers */

  app.get('/dossiers', w(async (req, res) => {
    const dossiers = await Dossier.getDossiers()
    res.send(dossiers)
  }))

  app.get('/dossiers/:dossierId', w(async (req, res) => {
    res.send(req.dossier)
  }))

  app.get('/dossiers/:dossierId/files/:checksum', w(async (req, res) => {
    const file = await Dossier.getFileFromDossier(req.dossier.number, req.params.checksum)

    if (!file) {
      throw createHttpError(404, 'File not found')
    }

    const key = getFileS3Key(req.dossier.number, file.filename)
    if (await objectExists(key)) {
      const buffer = await downloadFile(key)
      res.send(buffer)
    } else {
      throw createHttpError(404, 'File not found in S3')
    }
  }))

  app.post('/validate-file', express.raw({type: 'application/octet-stream', limit: '10mb'}), w(async (req, res) => {
    console.log('Type of req.body:', typeof req.body) // Vérifiez le type des données ici
    const buffer = req.body
    const {fileType} = req.query

    if (!Buffer.isBuffer(buffer)) {
      throw createHttpError(400, 'Invalid file format. Expected a binary buffer.')
    }

    const errors = await validateFile(fileType, buffer)
    res.send({errors})
  }))

  app.get('/points-prelevement', w(async (req, res) => {
    const prelevements = await getPointsPrelevement()

    res.send(prelevements)
  }))

  app.get('/points-prelevement/:id', w(async (req, res) => {
    const pointPrelevement = await getPointPrelevement(req.params.id)

    res.send(pointPrelevement)
  }))

  app.get('/points-prelevement/:id/beneficiaires', w(async (req, res) => {
    const beneficiaires = await getBeneficiairesFromPointId(req.params.id)

    res.send(beneficiaires)
  }))

  app.get('/points-prelevement/:id/exploitations', w(async (req, res) => {
    const exploitations = await getExploitationsFromPointId(req.params.id)

    res.send(exploitations)
  }))

  app.get('/exploitations/:id', w(async (req, res) => {
    const exploitation = await getExploitation(req.params.id)

    res.send(exploitation)
  }))


  app.get('/exploitations/:id/regles', w(async (req, res) => {
    const regles = await getReglesFromExploitationId(req.params.id)

    res.send(regles)
  }))
  app.get('/beneficiaires/:id', w(async (req, res) => {
    const beneficiaire = await getBeneficiaire(req.params.id)

    res.send(beneficiaire)
  }))

  app.get('/regles/:id', w(async (req, res) => {
    const regle = await getRegle(req.params.id)

    res.send(regle)
  }))

  app.get('/documents/:id', w(async (req, res) => {
    const document = await getDocument(req.params.id)

    res.send(document)
  }))

  return app
}

const routes = await createRoutes()
export default routes
