import {Router} from 'express'
import {rateLimit} from 'express-rate-limit'
import multer from 'multer'

import {
  handleToken,
  authorize,
  ensureAuthenticated,
  ensureRole,
  authorizePointPrelevement,
  authorizeExploitation,
  authorizeDeclarant,
  authorizeSource,
  authorizeChunk,
  authorizePointsPrelevementBatch,
  ensureServiceAccountAuthenticated,
  ensureHumanSession
} from './auth/middleware.js'

import {getSeriesValuesHandler, getSeriesMetadataHandler, listSeriesMetadataSearch} from './handlers/series.js'
import {getAggregatedSeriesHandler} from './handlers/series-aggregation.js'
import {getAggregatedSeriesOptionsHandler} from './handlers/series-aggregation-options.js'
import {
  listPointsPrelevement,
  createPointPrelevementHandler,
  getPointPrelevementDetail,
  updatePointPrelevementHandler,
  deletePointPrelevementHandler,
  getPointExploitations,
  listPointsPrelevementOptions,
  getPointsPrelevementBatchDetail
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
  listDeclarants,
  createPreleveurHandler,
  getDeclarantDetail,
  updatePreleveurHandler,
  deletePreleveurHandler,
  getPreleveurPointsPrelevement,
  getPreleveurExploitationsHandler,
  getPreleveurReglesHandler,
  createPreleveurRegle,
  getPreleveurDocumentsHandler,
  createPreleveurDocument,
  getPreleveurExploitationsViaPointsHandler,
  sendDeclarationReminderHandler
} from './handlers/declarants.js'
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
  getStatsHandler
} from './handlers/stats.js'
import {
  getInfoHandler
} from './handlers/info.js'
import {
  requestAuth,
  verifyAuthToken,
  logout
} from './handlers/auth.js'
import {
  createDeclarationHandler,
  listMyDeclarationsHandler,
  getDeclarationDetailHandler,
  getAvailablePointsPrelevementsForDeclarationHandler
} from './handlers/declarations.js'
import {
  createServiceAccountAccessTokenHandler,
  listManagedDeclarantsForServiceAccountHandler,
  createDeclarantImpersonationTokenHandler, getDeclarantContextHandler
} from './handlers/service-accounts-auth.js'
import {
  handlePoint,
  handleDeclarant,
  handleExploitation,
  handleDocument,
  handleRegle
} from './resolvers.js'
import {listZones} from './handlers/zones.js'
import {getMySourceHandler, listMySourcesHandler} from './handlers/sources.js'
import {updateChunkInstructionHandler} from './handlers/chunks.js'
import {createApiImportHandler} from './handlers/api-imports.js'

const storage = multer.memoryStorage()
const upload = multer({
  storage,
  limits: {
    fileSize: 50_000_000
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
  app.post('/auth/verify', verifyAuthToken)
  app.post('/auth/logout', logout)

  const serviceAccountAuthLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    message: 'Trop de tentatives d\'authentification de compte de service. Veuillez réessayer plus tard.',
    standardHeaders: true,
    legacyHeaders: false
  })

  app.post(
    '/service-accounts/token',
    serviceAccountAuthLimiter,
    createServiceAccountAccessTokenHandler
  )

  // Authentification pour toutes les autres routes
  app.use(handleToken)

  app.post(
    '/api-imports',
    ensureRole('DECLARANT'),
    createApiImportHandler
  )

  /* Routes via service account uniquement */

  app.get(
    '/service-accounts/me/declarants',
    ensureServiceAccountAuthenticated,
    listManagedDeclarantsForServiceAccountHandler
  )

  app.post(
    '/service-accounts/declarants/:declarantUserId/token',
    ensureServiceAccountAuthenticated,
    createDeclarantImpersonationTokenHandler
  )

  app.get(
    '/service-accounts/declarants/:declarantUserId/context',
    ensureServiceAccountAuthenticated,
    getDeclarantContextHandler
  )

  app.use(ensureHumanSession)

  /* Resolvers */

  app.param('pointId', handlePoint)
  app.param('declarantId', handleDeclarant)
  app.param('exploitationId', handleExploitation)
  app.param('documentId', handleDocument)
  app.param('regleId', handleRegle)

  app.get('/info', ensureAuthenticated, getInfoHandler)

  /* Déclarations */
  app.post('/declarations', ensureRole('DECLARANT'), upload.array('files', 2), createDeclarationHandler)
  app.get('/declarations/me', ensureRole('DECLARANT'), listMyDeclarationsHandler)
  app.get('/declarations/:declarationId', ensureRole('DECLARANT'), getDeclarationDetailHandler)
  app.get('/declarations/:declarationId/available-points-prelevements', ensureRole('INSTRUCTOR'), getAvailablePointsPrelevementsForDeclarationHandler)

  /* Sources */
  app.get('/sources/me', ensureRole('INSTRUCTOR'), listMySourcesHandler)
  app.get('/sources/:sourceId', ensureRole('INSTRUCTOR'), authorizeSource('read'), getMySourceHandler)

  /* Chunks */
  app.post('/chunks/:chunkId/instruction', authorizeChunk('write'), updateChunkInstructionHandler)

  /* Points */

  app.route('/points-prelevement')
    .get(ensureRole('INSTRUCTOR', 'DECLARANT'), listPointsPrelevement)
    .post(ensureRole('editor'), createPointPrelevementHandler)

  app.route('/points-prelevement/options')
    .get(ensureRole('INSTRUCTOR', 'DECLARANT'), listPointsPrelevementOptions)

  app.route('/points-prelevement/:pointId')
    .get(authorizePointPrelevement('read'), getPointPrelevementDetail)
    .put(authorize('point', 'editor'), updatePointPrelevementHandler)
    .delete(authorize('point', 'editor'), deletePointPrelevementHandler)

  app.route('/points-prelevement/batch')
    .post(authorizePointsPrelevementBatch('read'), getPointsPrelevementBatchDetail)

  app.get('/points-prelevement/:pointId/exploitations', authorizePointPrelevement('read'), getPointExploitations)

  /* Zones */

  app.route('/zones')
    .get(ensureRole('INSTRUCTOR'), listZones)

  /* Exploitations */

  app.route('/exploitations')
    .post(ensureRole('editor'), createExploitationHandler)

  app.route('/exploitations/:exploitationId')
    .get(authorizeExploitation('read'), getExploitationDetail)
    .put(authorize('exploitation', 'editor'), updateExploitationHandler)
    .delete(authorize('exploitation', 'editor'), deleteExploitationHandler)

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

  /* Déclarants */

  app.route('/declarants')
    .get(ensureRole('INSTRUCTOR'), listDeclarants)
    .post(ensureRole('editor'), createPreleveurHandler)

  app.route('/declarants/:declarantId')
    .get(authorizeDeclarant('read'), getDeclarantDetail)
    .put(authorize('preleveur', 'editor'), updatePreleveurHandler)
    .delete(authorize('preleveur', 'editor'), deletePreleveurHandler)

  app.route('/declarants/:declarantId/send-reminder')
    .post(authorizeDeclarant('write'), sendDeclarationReminderHandler)

  app.get('/preleveurs/:declarantId/points-prelevement', authorize('preleveur', 'reader'), getPreleveurPointsPrelevement)

  app.get('/preleveurs/:declarantId/exploitations', authorize('preleveur', 'reader'), getPreleveurExploitationsHandler)
  app.get('/preleveurs/:declarantId/exploitations-via-points', authorize('preleveur', 'reader'), getPreleveurExploitationsViaPointsHandler)

  /* Préleveurs - Règles */

  app.route('/preleveurs/:declarantId/regles')
    .get(authorizeDeclarant('read'), getPreleveurReglesHandler)
    .post(authorize('preleveur', 'editor'), createPreleveurRegle)

  /* Préleveurs - Documents */

  app.route('/preleveurs/:declarantId/documents')
    .get(authorize('preleveur', 'reader'), getPreleveurDocumentsHandler)
    .post(authorize('preleveur', 'editor'), upload.single('document'), createPreleveurDocument)

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

  // Recherche séries métadonnées
  app.get('/series', ensureRole('INSTRUCTOR'), listSeriesMetadataSearch)

  // Série: métadonnées seules
  app.get('/series/:seriesId', ensureRole('INSTRUCTOR'), getSeriesMetadataHandler)

  // Série: valeurs
  app.get('/series/:seriesId/values', ensureRole('INSTRUCTOR'), getSeriesValuesHandler)

  // Séries agrégées sur plusieurs points
  app.get('/aggregated-series', getAggregatedSeriesHandler)

  // Options disponibles pour l'agrégation de séries (paramètres et plages de dates)
  app.get('/aggregated-series/options', getAggregatedSeriesOptionsHandler)

  // Debug Sentry
  app.get('/debug-sentry', () => {
    throw new Error('Erreur test Sentry !')
  })

  return app
}

const routes = await createRoutes()
export default routes
