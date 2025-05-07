import process from 'node:process'
import {Router} from 'express'
import createHttpError from 'http-errors'
import {eachDayOfInterval} from 'date-fns'

import mongo from './util/mongo.js'
import w from './util/w.js'
import {downloadFile} from './util/s3.js'

import * as Dossier from './models/dossier.js'

import {
  getPointsPrelevement,
  decoratePointPrelevement,
  getPointPrelevement,
  getPointsFromBeneficiaire,
  getStats,
  createPointPrelevement
} from './models/points-prelevement.js'

import {
  getBeneficiaire,
  getBeneficiaires,
  decorateBeneficiaire
} from './models/beneficiaire.js'

import {
  getExploitationsFromPointId,
  getExploitation
} from './models/exploitation.js'

import {
  getVolumesPreleves
} from './models/volume-preleve.js'
import {ensureIsAdmin} from './auth/middleware.js'

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

    req.isAdmin = true

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
    const file = req.dossier.files.find(f => f.checksum === req.params.checksum)

    if (!file) {
      throw createHttpError(404, 'File not found')
    }

    const key = file.objectKey
    const buffer = await downloadFile(key)
    res.send(buffer)
  }))

  app.route('/points-prelevement')
    .get(w(async (req, res) => {
      const prelevements = await getPointsPrelevement()
      const decoratedPoints = await Promise.all(prelevements.map(p => decoratePointPrelevement(p)))

      res.send(decoratedPoints)
    }))
    .post(w(ensureIsAdmin), w(async (req, res) => {
      const point = await createPointPrelevement(req.body)
      const decoratedPoint = await decoratePointPrelevement(point)

      res.send(decoratedPoint)
    }))

  app.get('/points-prelevement/:id', w(async (req, res) => {
    const pointPrelevement = await getPointPrelevement(req.params.id)
    const decoratedPoint = await decoratePointPrelevement(pointPrelevement)

    res.send(decoratedPoint)
  }))

  app.get('/points-prelevement/:id/exploitations', w(async (req, res) => {
    const exploitations = await getExploitationsFromPointId(req.params.id)

    res.send(exploitations)
  }))

  app.get('/exploitations/:id', w(async (req, res) => {
    const exploitation = await getExploitation(req.params.id)

    res.send(exploitation)
  }))

  app.get('/exploitations/:id/volumes-preleves', w(async (req, res) => {
    const volumesPreleves = await getVolumesPreleves(req.params.id)

    const exploitation = await mongo.db.collection('exploitations').findOne({id_exploitation: req.params.id})
    const reglesIds = exploitation.regles || []
    const regles = await mongo.db.collection('regles').find({
      id_regle: {$in: reglesIds}
    }).toArray()
    const regleVolumeJournalier = regles.find(r => r.parametre === 'Volume journalier')

    const dateDebut = volumesPreleves.at(-1)?.date
    const dateFin = volumesPreleves[0]?.date
    const volumeJournalierMax = regleVolumeJournalier?.valeur

    const result = {
      dateDebut,
      dateFin,
      volumeJournalierMax,
      valeurs: volumesPreleves
    }

    if (dateDebut && dateFin) {
      result.nbValeursAttendues = eachDayOfInterval({
        start: new Date(dateDebut), end: new Date(dateFin)
      }).length
    }

    result.nbValeursRenseignees = volumesPreleves.filter(v => v.volume !== null).length

    if (volumeJournalierMax) {
      result.valeurs = volumesPreleves.map(v => ({
        ...v,
        depassement: v.volume > volumeJournalierMax
      }))

      result.nbDepassements = result.valeurs.filter(v => v.depassement).length
    }

    res.send(result)
  }))

  app.get('/beneficiaires', w(async (req, res) => {
    const beneficiaires = await getBeneficiaires()
    const decoratedBeneficiaires = await Promise.all(beneficiaires.map(b => decorateBeneficiaire(b)))

    res.send(decoratedBeneficiaires)
  }))

  app.get('/beneficiaires/:id', w(async (req, res) => {
    const beneficiaire = await getBeneficiaire(req.params.id)
    const decoratedBeneficiaire = await decorateBeneficiaire(beneficiaire)

    res.send(decoratedBeneficiaire)
  }))

  app.get('/beneficiaires/:id/points-prelevement', w(async (req, res) => {
    const points = await getPointsFromBeneficiaire(req.params.id)

    res.send(points)
  }))

  app.get('/stats', w(async (req, res) => {
    const stats = await getStats()

    res.send(stats)
  }))

  return app
}

const routes = await createRoutes()
export default routes
