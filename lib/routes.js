import {Router} from 'express'
import createHttpError from 'http-errors'
import {eachDayOfInterval} from 'date-fns'

import mongo from './util/mongo.js'
import w from './util/w.js'
import {downloadFile} from './util/s3.js'

import * as Dossier from './models/dossier.js'

import {
  decoratePointPrelevement,
  getPointPrelevement,
  getPointsFromPreleveur,
  getStats,
  createPointPrelevement,
  updatePointPrelevement,
  deletePointPrelevement,
  getPointsPrelevementFromTerritoire
} from './models/points-prelevement.js'

import {
  getPreleveur,
  decoratePreleveur,
  createPreleveur,
  updatePreleveur,
  deletePreleveur,
  getPreleveursFromTerritoire
} from './models/preleveur.js'

import {
  getExploitationsFromPointId,
  getExploitation,
  createExploitation,
  updateExploitation,
  deleteExploitation
} from './models/exploitation.js'

import {
  getVolumesPreleves
} from './models/volume-preleve.js'
import {
  checkPermissionOnExploitation,
  checkPermissionOnPoint,
  checkPermissionOnPreleveur,
  ensureIsAdmin
} from './auth/middleware.js'

export const handleDossier = w(async (req, res, next) => {
  const dossierId = mongo.parseObjectId(req.params.dossierId)
  req.dossier = await Dossier.getDossier(dossierId)

  if (!req.dossier) {
    throw createHttpError(404, 'Dossier not found')
  }

  next()
})

async function getTerritoireByToken(token) {
  const territoire = await mongo.db.collection('tokens').findOne({token})

  return territoire
}

async function createRoutes() {
  const app = new Router()

  // Authenticate user / runner
  app.use(w(async (req, res, next) => {
    if (!req.get('Authorization')) {
      return next()
    }

    const token = req.get('Authorization').split(' ')[1]
    const codeTerritoire = await getTerritoireByToken(token)

    if (!codeTerritoire) {
      return next(createHttpError(401, 'Unauthorized'))
    }

    req.isAdmin = true
    req.territoire = codeTerritoire.territoire

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
    .get(w(ensureIsAdmin), w(async (req, res) => {
      const prelevements = await getPointsPrelevementFromTerritoire(req.territoire)
      const decoratedPoints = await Promise.all(prelevements.map(p => decoratePointPrelevement(p)))

      res.send(decoratedPoints)
    }))
    .post(w(ensureIsAdmin), w(async (req, res) => {
      const point = await createPointPrelevement(req.body, req.territoire)
      const decoratedPoint = await decoratePointPrelevement(point)

      res.send(decoratedPoint)
    }))

  app.route('/points-prelevement/:id')
    .get(w(checkPermissionOnPoint), w(async (req, res) => {
      const pointPrelevement = await getPointPrelevement(req.params.id)

      if (!pointPrelevement) {
        throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
      }

      const decoratedPoint = await decoratePointPrelevement(pointPrelevement)

      res.send(decoratedPoint)
    }))
    .put(w(checkPermissionOnPoint), w(async (req, res) => {
      const point = await updatePointPrelevement(req.params.id, req.body)

      res.send(point)
    }))
    .delete(w(checkPermissionOnPoint), w(async (req, res) => {
      const deletedPoint = await deletePointPrelevement(req.params.id)

      if (!deletedPoint) {
        throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
      }

      res.send(deletedPoint)
    }))

  app.get('/points-prelevement/:id/exploitations', w(checkPermissionOnPoint), w(async (req, res) => {
    const exploitations = await getExploitationsFromPointId(req.params.id)

    res.send(exploitations)
  }))

  app.route('/exploitations')
    .post(w(ensureIsAdmin), w(async (req, res) => {
      const exploitation = await createExploitation(req.body, req.territoire)

      res.send(exploitation)
    }))

  app.route('/exploitations/:id')
    .get(w(checkPermissionOnExploitation), w(async (req, res) => {
      const exploitation = await getExploitation(req.params.id)

      if (!exploitation) {
        throw createHttpError(404, 'Cette exploitation est introuvable.')
      }

      res.send(exploitation)
    }))
    .put(w(checkPermissionOnExploitation), w(async (req, res) => {
      const exploitation = await updateExploitation(req.params.id, req.body)

      res.send(exploitation)
    }))
    .delete(w(ensureIsAdmin), w(async (req, res) => {
      const deletedExploitation = await deleteExploitation(req.params.id, req.territoire)

      res.send(deletedExploitation)
    }))

  app.get('/exploitations/:id/volumes-preleves', w(checkPermissionOnExploitation), w(async (req, res) => {
    const volumesPreleves = await getVolumesPreleves(req.params.id)

    const exploitation = await mongo.db.collection('exploitations').findOne(
      {id_exploitation: req.params.id}
    )

    if (!exploitation) {
      throw createHttpError(404, 'Cette exploitation est introuvable.')
    }

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

  app.route('/preleveurs')
    .get(w(ensureIsAdmin), w(async (req, res) => {
      const preleveurs = await getPreleveursFromTerritoire(req.territoire)
      const decoratedPreleveurs = await Promise.all(preleveurs.map(b => decoratePreleveur(b)))

      res.send(decoratedPreleveurs)
    }))
    .post(w(ensureIsAdmin), w(async (req, res) => {
      const preleveur = await createPreleveur(req.body, req.territoire)

      res.send(preleveur)
    }))

  app.route('/preleveurs/:id')
    .get(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const preleveur = await getPreleveur(req.params.id, req.territoire)

      if (!preleveur) {
        throw createHttpError(404, 'Ce préleveur est introuvable.')
      }

      const decoratedPreleveur = await decoratePreleveur(preleveur)

      res.send(decoratedPreleveur)
    }))
    .put(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const preleveur = await updatePreleveur(req.params.id, req.body)

      res.send(preleveur)
    }))
    .delete(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const deletedPreleveur = await deletePreleveur(req.params.id)

      res.send(deletedPreleveur)
    }))

  app.get('/preleveurs/:id/points-prelevement', w(checkPermissionOnPreleveur), w(async (req, res) => {
    const points = await getPointsFromPreleveur(req.params.id)

    res.send(points)
  }))

  app.get('/territoires/:codeTerritoire/points-prelevement', w(ensureIsAdmin), w(async (req, res) => {
    const points = await getPointsPrelevementFromTerritoire(req.params.codeTerritoire)

    res.send(points)
  }))

  app.get('/territoires/:codeTerritoire/preleveurs', w(ensureIsAdmin), w(async (req, res) => {
    const preleveurs = await getPreleveursFromTerritoire(req.params.codeTerritoire)

    res.send(preleveurs)
  }))

  app.get('/stats', w(async (req, res) => {
    const stats = await getStats()

    res.send(stats)
  }))

  return app
}

const routes = await createRoutes()
export default routes
