import {Router} from 'express'
import createHttpError from 'http-errors'
import {subDays, differenceInDays} from 'date-fns'
import multer from 'multer'

import {getAttachmentObjectKey} from '@fabnum/demarches-simplifiees'

import mongo from './util/mongo.js'
import w from './util/w.js'
import s3 from './util/s3.js'

import * as Dossier from './models/dossier.js'

import {
  decoratePointPrelevement,
  getPointsFromPreleveur,
  createPointPrelevement,
  updatePointPrelevement,
  deletePointPrelevement,
  getPointsPrelevementFromTerritoire
} from './models/point-prelevement.js'

import {
  createPreleveur,
  decoratePreleveur,
  deletePreleveur,
  getPreleveurs,
  updatePreleveur
} from './models/preleveur.js'

import {
  createDocument,
  decorateDocument,
  deleteDocument,
  getPreleveurDocuments,
  updateDocument
} from './models/document.js'

import {
  getExploitationsFromPointId,
  createExploitation,
  updateExploitation,
  deleteExploitation,
  getPreleveurExploitations
} from './models/exploitation.js'

import {
  getAggregatedSaisiesJournalieresByPoint,
  getAggregatedSaisiesJournalieresByPreleveur,
  getSaisiesJournalieres
} from './models/saisie-journaliere.js'

import {
  checkPermissionOnExploitation,
  checkPermissionOnPoint,
  checkPermissionOnPreleveur,
  checkPermissionOnTerritoire,
  ensureIsAdmin,
  handleToken
} from './auth/middleware.js'

import {
  getBnpe,
  getBnpeList,
  getBss,
  getBssList,
  getBvBdcarthage,
  getBvBdcarthageList,
  getMeContinentalesBv,
  getMeContinentalesBvList,
  getMeso,
  getMesoList
} from './models/referentiels.js'

import {getStats} from './models/stats.js'

import {
  handleDossier,
  handlePoint,
  handlePreleveur,
  handleExploitation,
  handleDocument
} from './resolvers.js'

const storage = multer.memoryStorage()
const upload = multer({
  storage,
  limits: {
    fileSize: 10_000_000
  }
})

async function createRoutes() {
  const app = new Router()

  // Authenticate user / runner
  app.use(w(handleToken))

  /* Resolvers */

  app.param('dossierId', w(handleDossier))
  app.param('pointId', w(handlePoint))
  app.param('preleveurId', w(handlePreleveur))
  app.param('exploitationId', w(handleExploitation))
  app.param('documentId', w(handleDocument))

  app.get('/info', w(async (req, res) => {
    if (!req.isAdmin) {
      throw createHttpError(403, 'Vous n’êtes pas autorisé à accéder à cette ressource')
    }

    res.send({
      isAdmin: true,
      territoire: req.territoire.code
    })
  }))

  /* Dossiers */

  // Middleware pour vérifier les autorisations
  app.use('/dossiers', ensureIsAdmin)

  app.get('/dossiers', w(async (req, res) => {
    if (!req.territoire.demarcheNumber) {
      throw createHttpError(404, 'Le territoire n’est pas associé à une démarche de Démarches Simplifiées')
    }

    const query = {}

    if (req.query.status) {
      query.status = req.query.status
    }

    if (req.query.preleveur && req.query.preleveur !== 'unknown') {
      query['result.preleveur'] = mongo.parseObjectId(req.query.preleveur)
    }

    if (req.query.preleveur === 'unknown') {
      query['result.preleveur'] = {$exists: false}
    }

    if (req.query.typePrelevement) {
      query.typePrelevement = req.query.typePrelevement
    }

    if (req.query.moisDeclaration) {
      query.moisDeclaration = req.query.moisDeclaration
    }

    if (req.query.number) {
      query.number = mongo.parseObjectId(req.query.number)
    }

    const dossiers = await Dossier.getDossiers(req.territoire.demarcheNumber, query)
    const decorateDossiers = await Promise.all(dossiers.map(d => Dossier.decorateDossier(d)))
    res.send(decorateDossiers)
  }))

  app.get('/dossiers/stats', w(async (req, res) => {
    const stats = await Dossier.getDossiersStats(req.territoire.demarcheNumber)

    res.send(stats)
  }))

  app.get('/dossiers/:dossierId', w(async (req, res) => {
    const attachments = await Dossier.getAttachmentsSummary(req.dossier.demarcheNumber, req.dossier.number)
    res.send({
      ...req.dossier,
      files: attachments
    })
  }))

  app.param('storageHash', async (req, res, next) => {
    req.attachment = await Dossier.getAttachmentByStorageHash(
      req.dossier.demarcheNumber,
      req.dossier.number,
      req.params.storageHash
    )

    if (!req.attachment) {
      throw createHttpError(404, 'File not found')
    }

    next()
  })

  app.get('/dossiers/:dossierId/files/:storageHash', w(async (req, res) => {
    const attachment = await Dossier.getAttachmentByStorageKey(
      req.dossier.demarcheNumber,
      req.dossier.number,
      req.attachment.storageKey,
      true
    )

    res.send(attachment)
  }))

  app.get('/dossiers/:dossierId/files/:storageHash/download', w(async (req, res) => {
    const objectKey = getAttachmentObjectKey(
      req.dossier.demarcheNumber,
      req.dossier.number,
      req.attachment.storageKey
    )

    const buffer = await s3('ds').downloadObject(objectKey)
    res.send(buffer)
  }))

  /* Points */

  app.route('/points-prelevement')
    .get(w(ensureIsAdmin), w(async (req, res) => {
      const prelevements = await getPointsPrelevementFromTerritoire(req.territoire.code)
      const decoratedPoints = await Promise.all(prelevements.map(p => decoratePointPrelevement(p)))

      res.send(decoratedPoints)
    }))
    .post(w(ensureIsAdmin), w(async (req, res) => {
      const point = await createPointPrelevement(req.body, req.territoire.code)
      const decoratedPoint = await decoratePointPrelevement(point)

      res.send(decoratedPoint)
    }))

  app.route('/points-prelevement/:pointId')
    .get(w(checkPermissionOnPoint), w(async (req, res) => {
      const decoratedPoint = await decoratePointPrelevement(req.point)

      res.send(decoratedPoint)
    }))
    .put(w(checkPermissionOnPoint), w(async (req, res) => {
      const point = await updatePointPrelevement(req.point._id, req.body)

      res.send(point)
    }))
    .delete(w(checkPermissionOnPoint), w(async (req, res) => {
      const deletedPoint = await deletePointPrelevement(req.point._id)

      if (!deletedPoint) {
        throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
      }

      res.send(deletedPoint)
    }))

  app.route('/points-prelevement/:pointId/saisies-journalieres')
    .get(w(checkPermissionOnPoint), w(async (req, res) => {
      const {from, to} = extractFromTo(req.query)
      const saisies = await getAggregatedSaisiesJournalieresByPoint(req.point._id, {from, to})
      res.send(saisies)
    }))

  app.get('/points-prelevement/:pointId/exploitations', w(checkPermissionOnPoint), w(async (req, res) => {
    const exploitations = await getExploitationsFromPointId(req.point._id)

    res.send(exploitations)
  }))

  /* Exploitations */

  app.route('/exploitations')
    .post(w(ensureIsAdmin), w(async (req, res) => {
      const exploitation = await createExploitation(req.body, req.territoire.code)

      res.send(exploitation)
    }))

  app.route('/exploitations/:exploitationId')
    .get(w(checkPermissionOnExploitation), w(async (req, res) => {
      res.send(req.exploitation)
    }))
    .put(w(checkPermissionOnExploitation), w(async (req, res) => {
      const exploitation = await updateExploitation(req.exploitation._id, req.body)

      res.send(exploitation)
    }))
    .delete(w(ensureIsAdmin), w(async (req, res) => {
      const deletedExploitation = await deleteExploitation(req.exploitation._id)

      res.send(deletedExploitation)
    }))

  app.route('/exploitations/:exploitationId/saisies-journalieres')
    .get(w(checkPermissionOnExploitation), w(async (req, res) => {
      const from = req.exploitation.date_debut
      const to = req.exploitation.date_fin
      const {preleveur: preleveurId, point: pointId} = req.exploitation

      const saisies = await getSaisiesJournalieres({pointId, preleveurId}, {from, to})
      res.send(saisies)
    }))

  /* Préleveurs */

  app.route('/preleveurs')
    .get(w(ensureIsAdmin), w(async (req, res) => {
      const preleveurs = await getPreleveurs(req.territoire.code)
      const decoratedPreleveurs = await Promise.all(preleveurs.map(p => decoratePreleveur(p)))

      res.send(decoratedPreleveurs)
    }))
    .post(w(ensureIsAdmin), w(async (req, res) => {
      const preleveur = await createPreleveur(req.territoire.code, req.body)

      res.send(preleveur)
    }))

  app.route('/preleveurs/:preleveurId')
    .get(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const decoratedPreleveur = await decoratePreleveur(req.preleveur)

      res.send(decoratedPreleveur)
    }))
    .put(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const preleveur = await updatePreleveur(req.preleveur._id, req.body)

      res.send(preleveur)
    }))
    .delete(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const deletedPreleveur = await deletePreleveur(req.preleveur._id)

      res.send(deletedPreleveur)
    }))

  app.route('/preleveurs/:preleveurId/saisies-journalieres')
    .get(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const {from, to} = extractFromTo(req.query)

      const saisies = await getAggregatedSaisiesJournalieresByPreleveur(req.preleveur._id, {from, to})
      res.send(saisies)
    }))

  app.get('/preleveurs/:preleveurId/points-prelevement', w(checkPermissionOnPreleveur), w(async (req, res) => {
    const points = await getPointsFromPreleveur(req.preleveur._id)

    res.send(points)
  }))

  app.get('/preleveurs/:preleveurId/exploitations', w(checkPermissionOnPreleveur), w(async (req, res) => {
    const exploitations = await getPreleveurExploitations(req.preleveur._id)

    res.send(exploitations)
  }))

  /* Préleveurs - Documents */

  app.route('/preleveurs/:preleveurId/documents')
    .get(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const documents = await getPreleveurDocuments(req.preleveur._id)
      const decoratedDocuments = await Promise.all(documents.map(d => decorateDocument(d)))

      res.send(decoratedDocuments)
    }))
    .post(w(checkPermissionOnPreleveur), upload.single('document'), w(async (req, res) => {
      const document = await createDocument(req.body, req.file, req.preleveur._id, req.territoire)

      res.send(document)
    }))

  app.route('/preleveurs/:preleveurId/documents/:documentId')
    .put(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const document = await updateDocument(req.document._id, req.body)

      res.send(document)
    }))
    .delete(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const deletedDocument = await deleteDocument(req.document._id)

      res.send(deletedDocument)
    }))

  /* Territoires */

  app.get('/territoires/:codeTerritoire/points-prelevement', w(checkPermissionOnTerritoire), w(async (req, res) => {
    const points = await getPointsPrelevementFromTerritoire(req.params.codeTerritoire)

    res.send(points)
  }))

  app.get('/territoires/:codeTerritoire/preleveurs', w(checkPermissionOnTerritoire), w(async (req, res) => {
    const preleveurs = await getPreleveurs(req.params.codeTerritoire)

    res.send(preleveurs)
  }))

  /* Référentiels */

  app.get('/referentiels/bss', w(async (req, res) => {
    const bssList = await getBssList()

    res.send(bssList)
  }))

  app.get('/referentiels/bss/:idBss', w(async (req, res) => {
    const bss = await getBss(req.params.idBss)

    res.send(bss)
  }))

  app.get('/referentiels/bnpe', w(async (req, res) => {
    const bnpeList = await getBnpeList()

    res.send(bnpeList)
  }))

  app.get('/referentiels/bnpe/:idBnpe', w(async (req, res) => {
    const bnpe = await getBnpe(req.params.idBnpe)

    res.send(bnpe)
  }))

  app.get('/referentiels/me-continentales-bv', w(async (req, res) => {
    const meContinentalesBvList = await getMeContinentalesBvList()

    res.send(meContinentalesBvList)
  }))

  app.get('/referentiels/me-continentales-bv/:idMeContinentalesBv', w(async (req, res) => {
    const meContinentalesBv = await getMeContinentalesBv(req.params.idMeContinentalesBv)

    res.send(meContinentalesBv)
  }))

  app.get('/referentiels/bv-bdcarthage', w(async (req, res) => {
    const bvBdCarthageList = await getBvBdcarthageList()

    res.send(bvBdCarthageList)
  }))

  app.get('/referentiels/bv-bdcarthage/:idBvBdcarthage', w(async (req, res) => {
    const bvBdCarthage = await getBvBdcarthage(req.params.idBvBdcarthage)

    res.send(bvBdCarthage)
  }))

  app.get('/referentiels/meso', w(async (req, res) => {
    const mesoList = await getMesoList()

    res.send(mesoList)
  }))

  app.get('/referentiels/meso/:idMeso', w(async (req, res) => {
    const meso = await getMeso(req.params.idMeso)

    res.send(meso)
  }))

  /* Statistiques */

  app.get('/stats/', w(async (req, res) => {
    const stats = await getStats()

    res.send(stats)
  }))

  app.get('/stats/:territoire', w(async (req, res) => {
    const stats = await getStats(req.params.territoire)

    res.send(stats)
  }))

  return app
}

const routes = await createRoutes()
export default routes

function extractFromTo(query) {
  if (query.to && !query.from) {
    throw createHttpError(400, '"from" is required when "to" is specified')
  }

  // Default: last 90 days
  const from = query.from || subDays(new Date(), 90).toISOString().split('T')[0]
  const to = query.to || new Date().toISOString().split('T')[0]

  // Check from is before to
  if (from > to) {
    throw createHttpError(400, '"from" must be before "to"')
  }

  // Check interval is less than 180 days
  if (differenceInDays(new Date(to), new Date(from)) > 180) {
    throw createHttpError(400, 'Interval must be less than 180 days')
  }

  return {from, to}
}
