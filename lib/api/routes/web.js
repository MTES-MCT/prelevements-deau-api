import process from 'node:process'
import express, {Router} from 'express'
import createHttpError from 'http-errors'
import cors from 'cors'

import mongo from '../../util/mongo.js'
import errorHandler from '../util/error-handler.js'
import w from '../util/w.js'

import * as Dossier from '../../models/dossier.js'

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

  // Enable CORS
  app.use(cors({origin: true, maxAge: 600}))

  // Setup JSON parsing
  app.use(express.json())

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

  // Register error handler
  app.use(errorHandler)

  return app
}

const routes = await createRoutes()
export default routes
