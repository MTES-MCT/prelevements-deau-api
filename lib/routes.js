import {Router} from 'express'
import {rateLimit} from 'express-rate-limit'
import multer from 'multer'

import {
  ensureIsAdmin,
  handleToken,
  authorize
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
  requestAuth,
  verifyAuth,
  logout
} from './handlers/auth.js'
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

  /* Auth routes - pas de middleware handleToken pour ces routes */

  // Rate limiter pour éviter les abus sur la demande d'authentification
  const authRequestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // 20 requêtes par IP
    message: 'Trop de demandes d\'authentification. Veuillez réessayer dans 15 minutes.',
    standardHeaders: true,
    legacyHeaders: false
  })

  app.post('/auth/request', authRequestLimiter, requestAuth)
  app.get('/auth/verify/:token', verifyAuth)
  app.post('/auth/logout', logout)

  // Authentification pour toutes les autres routes
  app.use(handleToken)

  /* Resolvers */

  app.param('dossierId', handleDossier)
  app.param('pointId', handlePoint)
  app.param('preleveurId', handlePreleveur)
  app.param('exploitationId', handleExploitation)
  app.param('documentId', handleDocument)
  app.param('attachmentId', handleAttachment)
  app.param('seriesId', handleSeries)
  app.param('regleId', handleRegle)

  app.get('/info', handleToken, authorize('territoire', 'reader'), getInfoHandler)

  /* Dossiers */
  app.use('/dossiers', ensureIsAdmin)
  app.get('/dossiers', listDossiers)
  app.get('/dossiers/stats', getDossiersStatsHandler)
  app.get('/dossiers/:dossierId', getDossierDetail)
  app.post('/dossiers/:dossierId/reconsolidate', reconsolidateDossier)
  app.get('/dossiers/:dossierId/files/:attachmentId', getAttachmentDetail)
  app.post('/dossiers/:dossierId/files/:attachmentId/reprocess', reprocessAttachment)
  app.get('/dossiers/:dossierId/files/:attachmentId/integrations', getAttachmentIntegrations)
  app.get('/dossiers/:dossierId/files/:attachmentId/series', listSeriesForAttachment)
  app.get('/dossiers/:dossierId/files/:attachmentId/download', downloadAttachment)

  /* Points */

  app.route('/points-prelevement')
    .get(ensureIsAdmin, listPointsPrelevement)
    .post(ensureIsAdmin, createPointPrelevementHandler)

  app.route('/points-prelevement/:pointId')
    .get(authorize('point', 'reader'), getPointPrelevementDetail)
    .put(authorize('point', 'editor'), updatePointPrelevementHandler)
    .delete(authorize('point', 'editor'), deletePointPrelevementHandler)

  app.get('/points-prelevement/:pointId/exploitations', authorize('point', 'reader'), getPointExploitations)

  /* Exploitations */

  app.route('/exploitations')
    .post(ensureIsAdmin, createExploitationHandler)

  app.route('/exploitations/:exploitationId')
    .get(authorize('exploitation', 'reader'), getExploitationDetail)
    .put(authorize('exploitation', 'editor'), updateExploitationHandler)
    .delete(ensureIsAdmin, deleteExploitationHandler)

  app.get('/exploitations/:exploitationId/documents', authorize('exploitation', 'reader'), getExploitationDocuments)

  /* Règles */

  app.route('/regles/:regleId')
    .get(authorize('regle', 'reader'), getRegleDetail)
    .put(authorize('regle', 'editor'), updateRegleHandler)
    .delete(authorize('regle', 'editor'), deleteRegleHandler)

  /* Documents */

  app.route('/documents/:documentId')
    .get(authorize('document', 'reader'), getDocumentDetail)
    .put(authorize('document', 'editor'), updateDocumentHandler)
    .delete(authorize('document', 'editor'), deleteDocumentHandler)

  /* Préleveurs */

  app.route('/preleveurs')
    .get(ensureIsAdmin, listPreleveurs)
    .post(ensureIsAdmin, createPreleveurHandler)

  app.route('/preleveurs/:preleveurId')
    .get(authorize('preleveur', 'reader'), getPreleveurDetail)
    .put(authorize('preleveur', 'editor'), updatePreleveurHandler)
    .delete(authorize('preleveur', 'editor'), deletePreleveurHandler)

  app.get('/preleveurs/:preleveurId/points-prelevement', authorize('preleveur', 'reader'), getPreleveurPointsPrelevement)

  app.get('/preleveurs/:preleveurId/exploitations', authorize('preleveur', 'reader'), getPreleveurExploitationsHandler)

  /* Préleveurs - Règles */

  app.route('/preleveurs/:preleveurId/regles')
    .get(authorize('preleveur', 'reader'), getPreleveurReglesHandler)
    .post(authorize('preleveur', 'editor'), createPreleveurRegle)

  /* Préleveurs - Documents */

  app.route('/preleveurs/:preleveurId/documents')
    .get(authorize('preleveur', 'reader'), getPreleveurDocumentsHandler)
    .post(authorize('preleveur', 'editor'), upload.single('document'), createPreleveurDocument)

  /* Territoires */

  app.get('/territoires/:codeTerritoire/points-prelevement', authorize('territoire', 'reader'), getTerritoirePointsPrelevement)

  app.get('/territoires/:codeTerritoire/preleveurs', authorize('territoire', 'reader'), getTerritoirePreleveurs)

  /* Référentiels */

  app.get('/referentiels/bss', getBssListHandler)

  app.get('/referentiels/bss/:idBss', getBssDetailHandler)

  app.get('/referentiels/bnpe', getBnpeListHandler)

  app.get('/referentiels/bnpe/:idBnpe', getBnpeDetailHandler)

  app.get('/referentiels/me-continentales-bv', getMeContinentalesBvListHandler)

  app.get('/referentiels/me-continentales-bv/:idMeContinentalesBv', getMeContinentalesBvDetailHandler)

  app.get('/referentiels/bv-bdcarthage', getBvBdcarthageListHandler)

  app.get('/referentiels/bv-bdcarthage/:idBvBdcarthage', getBvBdcarthageDetailHandler)

  app.get('/referentiels/meso', getMesoListHandler)

  app.get('/referentiels/meso/:idMeso', getMesoDetailHandler)

  /* Statistiques */

  app.get('/stats/', getStatsHandler)

  app.get('/stats/:territoire', getStatsTerritoireHandler)

  // Recherche séries métadonnées
  app.get('/series', ensureIsAdmin, listSeriesMetadataSearch)

  // Série: métadonnées seules
  app.get('/series/:seriesId', authorize('series', 'reader'), getSeriesMetadataHandler)

  // Série: valeurs
  app.get('/series/:seriesId/values', authorize('series', 'reader'), getSeriesValuesHandler)

  // Séries agrégées sur plusieurs points
  app.get('/aggregated-series', ensureIsAdmin, getAggregatedSeriesHandler)

  // Options disponibles pour l'agrégation de séries (paramètres et plages de dates)
  app.get('/aggregated-series/options', ensureIsAdmin, getAggregatedSeriesOptionsHandler)

  return app
}

const routes = await createRoutes()
export default routes
