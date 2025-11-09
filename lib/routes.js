import {Router} from 'express'
import multer from 'multer'

import w from './util/w.js'

import {
  checkPermissionOnExploitation,
  checkPermissionOnPoint,
  checkPermissionOnPreleveur,
  checkPermissionOnSeries,
  checkPermissionOnTerritoire,
  checkPermissionOnRegle,
  checkPermissionOnDocument,
  ensureIsAdmin,
  handleToken
} from './auth/middleware.js'

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
  listPointsPrelevement,
  createPointPrelevementHandler,
  getPointPrelevementDetail,
  updatePointPrelevementHandler,
  deletePointPrelevementHandler,
  getPointExploitations
} from './handlers/points-prelevement.js'
import {
  createExploitationHandler,
  getExploitationDetail,
  updateExploitationHandler,
  deleteExploitationHandler,
  getExploitationDocuments
} from './handlers/exploitations.js'
import {
  getRegleDetail,
  updateRegleHandler,
  deleteRegleHandler
} from './handlers/regles.js'
import {
  getDocumentDetail,
  updateDocumentHandler,
  deleteDocumentHandler
} from './handlers/documents.js'
import {
  listPreleveurs,
  createPreleveurHandler,
  getPreleveurDetail,
  updatePreleveurHandler,
  deletePreleveurHandler,
  getPreleveurPointsPrelevement,
  getPreleveurExploitationsHandler,
  getPreleveurReglesHandler,
  createPreleveurRegle,
  getPreleveurDocumentsHandler,
  createPreleveurDocument
} from './handlers/preleveurs.js'
import {
  getTerritoirePointsPrelevement,
  getTerritoirePreleveurs
} from './handlers/territoires.js'
import {
  getBssListHandler,
  getBssDetailHandler,
  getBnpeListHandler,
  getBnpeDetailHandler,
  getMeContinentalesBvListHandler,
  getMeContinentalesBvDetailHandler,
  getBvBdcarthageListHandler,
  getBvBdcarthageDetailHandler,
  getMesoListHandler,
  getMesoDetailHandler
} from './handlers/referentiels.js'
import {
  getStatsHandler,
  getStatsTerritoireHandler
} from './handlers/stats.js'
import {
  getInfoHandler
} from './handlers/info.js'
import {
  handleDossier,
  handleAttachment,
  handlePoint,
  handlePreleveur,
  handleExploitation,
  handleDocument,
  handleSeries,
  handleRegle
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
  app.param('regleId', w(handleRegle))

  app.get('/info', w(getInfoHandler))

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
    .get(w(ensureIsAdmin), w(listPointsPrelevement))
    .post(w(ensureIsAdmin), w(createPointPrelevementHandler))

  app.route('/points-prelevement/:pointId')
    .get(w(checkPermissionOnPoint), w(getPointPrelevementDetail))
    .put(w(checkPermissionOnPoint), w(updatePointPrelevementHandler))
    .delete(w(checkPermissionOnPoint), w(deletePointPrelevementHandler))

  app.get('/points-prelevement/:pointId/exploitations', w(checkPermissionOnPoint), w(getPointExploitations))

  /* Exploitations */

  app.route('/exploitations')
    .post(w(ensureIsAdmin), w(createExploitationHandler))

  app.route('/exploitations/:exploitationId')
    .get(w(checkPermissionOnExploitation), w(getExploitationDetail))
    .put(w(checkPermissionOnExploitation), w(updateExploitationHandler))
    .delete(w(ensureIsAdmin), w(deleteExploitationHandler))

  app.get('/exploitations/:exploitationId/documents', w(checkPermissionOnExploitation), w(getExploitationDocuments))

  /* Règles */

  app.route('/regles/:regleId')
    .get(w(checkPermissionOnRegle), w(getRegleDetail))
    .put(w(checkPermissionOnRegle), w(updateRegleHandler))
    .delete(w(checkPermissionOnRegle), w(deleteRegleHandler))

  /* Documents */

  app.route('/documents/:documentId')
    .get(w(checkPermissionOnDocument), w(getDocumentDetail))
    .put(w(checkPermissionOnDocument), w(updateDocumentHandler))
    .delete(w(checkPermissionOnDocument), w(deleteDocumentHandler))

  /* Préleveurs */

  app.route('/preleveurs')
    .get(w(ensureIsAdmin), w(listPreleveurs))
    .post(w(ensureIsAdmin), w(createPreleveurHandler))

  app.route('/preleveurs/:preleveurId')
    .get(w(checkPermissionOnPreleveur), w(getPreleveurDetail))
    .put(w(checkPermissionOnPreleveur), w(updatePreleveurHandler))
    .delete(w(checkPermissionOnPreleveur), w(deletePreleveurHandler))

  app.get('/preleveurs/:preleveurId/points-prelevement', w(checkPermissionOnPreleveur), w(getPreleveurPointsPrelevement))

  app.get('/preleveurs/:preleveurId/exploitations', w(checkPermissionOnPreleveur), w(getPreleveurExploitationsHandler))

  /* Préleveurs - Règles */

  app.route('/preleveurs/:preleveurId/regles')
    .get(w(checkPermissionOnPreleveur), w(getPreleveurReglesHandler))
    .post(w(checkPermissionOnPreleveur), w(createPreleveurRegle))

  /* Préleveurs - Documents */

  app.route('/preleveurs/:preleveurId/documents')
    .get(w(checkPermissionOnPreleveur), w(getPreleveurDocumentsHandler))
    .post(w(checkPermissionOnPreleveur), upload.single('document'), w(createPreleveurDocument))

  /* Territoires */

  app.get('/territoires/:codeTerritoire/points-prelevement', w(checkPermissionOnTerritoire), w(getTerritoirePointsPrelevement))

  app.get('/territoires/:codeTerritoire/preleveurs', w(checkPermissionOnTerritoire), w(getTerritoirePreleveurs))

  /* Référentiels */

  app.get('/referentiels/bss', w(getBssListHandler))

  app.get('/referentiels/bss/:idBss', w(getBssDetailHandler))

  app.get('/referentiels/bnpe', w(getBnpeListHandler))

  app.get('/referentiels/bnpe/:idBnpe', w(getBnpeDetailHandler))

  app.get('/referentiels/me-continentales-bv', w(getMeContinentalesBvListHandler))

  app.get('/referentiels/me-continentales-bv/:idMeContinentalesBv', w(getMeContinentalesBvDetailHandler))

  app.get('/referentiels/bv-bdcarthage', w(getBvBdcarthageListHandler))

  app.get('/referentiels/bv-bdcarthage/:idBvBdcarthage', w(getBvBdcarthageDetailHandler))

  app.get('/referentiels/meso', w(getMesoListHandler))

  app.get('/referentiels/meso/:idMeso', w(getMesoDetailHandler))

  /* Statistiques */

  app.get('/stats/', w(getStatsHandler))

  app.get('/stats/:territoire', w(getStatsTerritoireHandler))

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
