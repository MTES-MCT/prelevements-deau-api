import {Router} from 'express'
import createHttpError from 'http-errors'
import multer from 'multer'

import w from './util/w.js'

import {
  decoratePointPrelevement,
  getPointsFromPreleveur,
  createPointPrelevement,
  updatePointPrelevement,
  deletePointPrelevement
} from './services/point-prelevement.js'

import {
  getPointsPrelevementFromTerritoire
} from './models/point-prelevement.js'

import {
  createPreleveur,
  decoratePreleveur,
  deletePreleveur,
  updatePreleveur
} from './services/preleveur.js'

import {
  getPreleveurs
} from './models/preleveur.js'

import {
  createDocument,
  decorateDocument,
  deleteDocument,
  getPreleveurDocuments,
  updateDocument
} from './models/document.js'

import {
  createExploitation,
  updateExploitation
} from './services/exploitation.js'

import {
  getExploitationsFromPointId,
  deleteExploitation,
  getPreleveurExploitations
} from './models/exploitation.js'

import {
  checkPermissionOnExploitation,
  checkPermissionOnPoint,
  checkPermissionOnPreleveur,
  checkPermissionOnSeries,
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
import {getSeriesValuesHandler, getSeriesMetadataHandler, listSeriesForAttachment, listSeriesMetadataSearch} from './handlers/series.js'
import {getAggregatedSeriesHandler} from './handlers/series-aggregation.js'
import {getAggregatedSeriesOptionsHandler} from './handlers/series-aggregation-options.js'
import {
  listDossiers,
  getDossiersStatsHandler,
  getDossierDetail,
  reconsolidateDossier,
  getAttachmentDetail,
  getAttachmentIntegrations,
  reprocessAttachment,
  downloadAttachment
} from './handlers/dossiers.js'
import {
  handleDossier,
  handleAttachment,
  handlePoint,
  handlePreleveur,
  handleExploitation,
  handleDocument,
  handleSeries
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
  app.param('attachmentId', w(handleAttachment))
  app.param('seriesId', w(handleSeries))

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
  app.use('/dossiers', ensureIsAdmin)
  app.get('/dossiers', w(listDossiers))
  app.get('/dossiers/stats', w(getDossiersStatsHandler))
  app.get('/dossiers/:dossierId', w(getDossierDetail))
  app.post('/dossiers/:dossierId/reconsolidate', w(reconsolidateDossier))
  app.get('/dossiers/:dossierId/files/:attachmentId', w(getAttachmentDetail))
  app.post('/dossiers/:dossierId/files/:attachmentId/reprocess', w(reprocessAttachment))
  app.get('/dossiers/:dossierId/files/:attachmentId/integrations', w(getAttachmentIntegrations))
  app.get('/dossiers/:dossierId/files/:attachmentId/series', w(listSeriesForAttachment))
  app.get('/dossiers/:dossierId/files/:attachmentId/download', w(downloadAttachment))

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
      const document = await createDocument(req.body, req.file, req.preleveur._id, req.territoire.code)

      res.send(document)
    }))

  app.route('/preleveurs/:preleveurId/documents/:documentId')
    .put(w(checkPermissionOnPreleveur), w(async (req, res) => {
      const document = await updateDocument(req.document._id, req.body)
      const decoratedDocument = await decorateDocument(document)

      res.send(decoratedDocument)
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
    const bss = await getBss(req.params.idBss, {throwIfNotFound: true})

    res.send(bss)
  }))

  app.get('/referentiels/bnpe', w(async (req, res) => {
    const bnpeList = await getBnpeList()

    res.send(bnpeList)
  }))

  app.get('/referentiels/bnpe/:idBnpe', w(async (req, res) => {
    const bnpe = await getBnpe(req.params.idBnpe, {throwIfNotFound: true})

    res.send(bnpe)
  }))

  app.get('/referentiels/me-continentales-bv', w(async (req, res) => {
    const meContinentalesBvList = await getMeContinentalesBvList()

    res.send(meContinentalesBvList)
  }))

  app.get('/referentiels/me-continentales-bv/:idMeContinentalesBv', w(async (req, res) => {
    const meContinentalesBv = await getMeContinentalesBv(req.params.idMeContinentalesBv, {throwIfNotFound: true})

    res.send(meContinentalesBv)
  }))

  app.get('/referentiels/bv-bdcarthage', w(async (req, res) => {
    const bvBdCarthageList = await getBvBdcarthageList()

    res.send(bvBdCarthageList)
  }))

  app.get('/referentiels/bv-bdcarthage/:idBvBdcarthage', w(async (req, res) => {
    const bvBdCarthage = await getBvBdcarthage(req.params.idBvBdcarthage, {throwIfNotFound: true})

    res.send(bvBdCarthage)
  }))

  app.get('/referentiels/meso', w(async (req, res) => {
    const mesoList = await getMesoList()

    res.send(mesoList)
  }))

  app.get('/referentiels/meso/:idMeso', w(async (req, res) => {
    const meso = await getMeso(req.params.idMeso, {throwIfNotFound: true})

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

  // Recherche séries métadonnées
  app.get('/series', w(ensureIsAdmin), w(listSeriesMetadataSearch))

  // Série: métadonnées seules
  app.get('/series/:seriesId', w(checkPermissionOnSeries), w(getSeriesMetadataHandler))

  // Série: valeurs
  app.get('/series/:seriesId/values', w(checkPermissionOnSeries), w(getSeriesValuesHandler))

  // Séries agrégées sur plusieurs points
  app.get('/aggregated-series', w(ensureIsAdmin), w(getAggregatedSeriesHandler))

  // Options disponibles pour l'agrégation de séries (paramètres et plages de dates)
  app.get('/aggregated-series/options', w(ensureIsAdmin), w(getAggregatedSeriesOptionsHandler))

  return app
}

const routes = await createRoutes()
export default routes
