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
  checkPermissionOnTerritoire,
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
  app.param('pointId', w(async (req, res, next) => {
    req.point = await getPointPrelevement(req.params.pointId)

    if (!req.point) {
      throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
    }

    next()
  }))
  app.param('preleveurId', w(async (req, res, next) => {
    req.preleveur = await getPreleveur(req.params.preleveurId)

    if (!req.preleveur) {
      throw createHttpError(404, 'Ce préleveur est introuvable.')
    }

    next()
  }))
  app.param('exploitationId', w(async (req, res, next) => {
    req.exploitation = await getExploitation(req.params.exploitationId)

    if (!req.exploitation) {
      throw createHttpError(404, 'Cette exploitation est introuvable.')
    }

    next()
  }))

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

  /* Points */

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

  app.route('/points-prelevement/:pointId')
    .get(w(checkPermissionOnPoint), w(async (req, res) => {
      const decoratedPoint = await decoratePointPrelevement(req.point)

      res.send(decoratedPoint)
    }))
    .put(w(checkPermissionOnPoint), w(async (req, res) => {
      const point = await updatePointPrelevement(req.params.pointId, req.body)

      res.send(point)
    }))
    .delete(w(checkPermissionOnPoint), w(async (req, res) => {
      const deletedPoint = await deletePointPrelevement(req.params.pointId)

      if (!deletedPoint) {
        throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
      }

      res.send(deletedPoint)
    }))

  app.get('/points-prelevement/:pointId/exploitations', w(checkPermissionOnPoint), w(async (req, res) => {
    const exploitations = await getExploitationsFromPointId(req.params.pointId)

    res.send(exploitations)
  }))

  /* Exploitations */

  app.route('/exploitations')
    .post(w(ensureIsAdmin), w(async (req, res) => {
      const exploitation = await createExploitation(req.body, req.territoire)

      res.send(exploitation)
    }))

  app.route('/exploitations/:exploitationId')
    .get(w(checkPermissionOnExploitation), w(async (req, res) => {
      res.send(req.exploitation)
    }))
    .put(w(checkPermissionOnExploitation), w(async (req, res) => {
      const exploitation = await updateExploitation(req.params.exploitationId, req.body)

      res.send(exploitation)
    }))
    .delete(w(ensureIsAdmin), w(async (req, res) => {
      const deletedExploitation = await deleteExploitation(req.params.exploitationId, req.territoire)

      res.send(deletedExploitation)
    }))

  app.get('/exploitations/:exploitationId/volumes-preleves', w(checkPermissionOnExploitation), w(async (req, res) => {
    const volumesPreleves = await getVolumesPreleves(req.params.exploitationId)

    const exploitation = await mongo.db.collection('exploitations').findOne(
      {id_exploitation: req.params.exploitationId}
    )

    if (!exploitation) {
      throw createHttpError(404, 'Cette exploitation est introuvable.')
    }

    const {regles} = exploitation
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

  /* Préleveurs */

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

  app.route('/preleveurs/:preleveurId')
    .get(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const decoratedPreleveur = await decoratePreleveur(req.preleveur)

      res.send(decoratedPreleveur)
    }))
    .put(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const preleveur = await updatePreleveur(req.params.preleveurId, req.body)

      res.send(preleveur)
    }))
    .delete(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const deletedPreleveur = await deletePreleveur(req.params.preleveurId)

      res.send(deletedPreleveur)
    }))

  app.get('/preleveurs/:preleveurId/points-prelevement', w(checkPermissionOnPreleveur), w(async (req, res) => {
    const points = await getPointsFromPreleveur(req.params.preleveurId)

    res.send(points)
  }))

  /* Territoires */

  app.get('/territoires/:codeTerritoire/points-prelevement', w(checkPermissionOnTerritoire), w(async (req, res) => {
    const points = await getPointsPrelevementFromTerritoire(req.params.codeTerritoire)

    res.send(points)
  }))

  app.get('/territoires/:codeTerritoire/preleveurs', w(checkPermissionOnTerritoire), w(async (req, res) => {
    const preleveurs = await getPreleveursFromTerritoire(req.params.codeTerritoire)

    res.send(preleveurs)
  }))

  /* Statistiques */

  app.get('/stats', w(async (req, res) => {
    const stats = await getStats()

    res.send(stats)
  }))

  return app
}

const routes = await createRoutes()
export default routes
