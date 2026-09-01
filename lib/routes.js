import {Router} from 'express'
import {rateLimit} from 'express-rate-limit'
import multer from 'multer'

import {
  handleToken,
  ensureAuthenticated,
  ensureRole,
  authorizePointPrelevement,
  authorizeExploitation,
  authorizeDeclarant,
  authorizeDeclarantCreation,
  authorizeSource,
  authorizeChunk,
  authorizePointsPrelevementBatch,
  authorizeAnyZonePermission,
  authorizeAggregationRead,
  authorizeZoneAnyPermission,
  authorizeZonePermission,
  authorizeDeclarationPermission,
  ensureServiceAccountAuthenticated,
  ensureHumanSession,
  ensureNotImpersonating
} from './auth/middleware.js'
import {authorizeRegle, authorizeDocument} from './auth/resource-authorization.js'

import {getSeriesValuesHandler, getSeriesMetadataHandler, listSeriesMetadataSearch} from './handlers/series.js'
import {getAggregatedSeriesHandler} from './handlers/series-aggregation.js'
import {getAggregatedSeriesOptionsHandler} from './handlers/series-aggregation-options.js'
import {
  listPointsPrelevement,
  createPointPrelevementHandler,
  getPointPrelevementDetail,
  updatePointPrelevementHandler,
  updatePointUsageNameHandler,
  deletePointPrelevementHandler,
  getPointExploitations,
  listPointMapSummaries,
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
  listCollecteurExploitationCandidatesHandler,
  updateCollecteurExploitationsHandler
} from './handlers/collecteur-exploitations.js'
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
  searchDeclarantsHandler,
  getCollecteurPreleveursHandler,
  searchCollecteurPreleveursHandler,
  createPreleveurHandler,
  getDeclarantDetail,
  getDeclarantOverviewHandler,
  updatePreleveurHandler,
  deletePreleveurHandler,
  getPreleveurPointsPrelevement,
  getPreleveurExploitationsHandler,
  getPreleveurReglesHandler,
  createPreleveurRegle,
  getPreleveurDocumentsHandler,
  createPreleveurDocument,
  getPreleveurExploitationsViaPointsHandler,
  sendDeclarantAccountCreationNotificationHandler,
  getDeclarantZonesHandler,
  updateDeclarantZonesHandler
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
  getMesoDetailHandler,
  getWaterUsesHandler
} from './handlers/referentiels.js'
import {
  getStatsHandler
} from './handlers/stats.js'
import {
  getDashboardMapHandler,
  getDashboardTerritoryHandler
} from './handlers/dashboard.js'
import {getDashboardPointActorsHandler} from './handlers/dashboard-point-actors.js'
import {
  getInfoHandler
} from './handlers/info.js'
import {
  startAdminImpersonationHandler,
  stopAdminImpersonationHandler
} from './handlers/impersonation.js'
import {getAdminDashboardHandler} from './handlers/admin-dashboard.js'
import {
  requestAuth,
  verifyAuthToken,
  logout
} from './handlers/auth.js'
import {
  activatePasswordHandler,
  changePasswordHandler,
  getAuthConfigHandler,
  passwordLoginHandler
} from './handlers/password-auth.js'
import {
  issuePasswordActivationHandler,
  listPasswordAccessesHandler,
  revokePasswordAccessHandler
} from './handlers/admin-password-accesses.js'
import {AUTH_METHODS, readAuthMethods} from './config/auth.js'
import {
  passwordActivationRateLimiter,
  passwordLoginRateLimiter
} from './services/password-rate-limit.js'
import {
  emailVerificationConfirmationRateLimiter,
  emailVerificationRequestRateLimiter
} from './services/email-verification-rate-limit.js'
import {updateMyProfileHandler} from './handlers/user-profile.js'
import {
  cancelMyEmailVerificationHandler,
  confirmEmailVerificationHandler,
  requestPrimaryEmailChangeHandler,
  resendMyEmailVerificationHandler
} from './handlers/user-email-verifications.js'
import {
  listMyEmailAliasesHandler,
  createMyEmailAliasHandler,
  deleteMyEmailAliasHandler,
  listDeclarantEmailAliasesHandler,
  createDeclarantEmailAliasHandler,
  deleteDeclarantEmailAliasHandler
} from './handlers/user-email-aliases.js'
import {
  listDeclarantContactEmailsHandler,
  replaceDeclarantContactEmailsHandler
} from './handlers/declarant-contact-emails.js'
import {
  createDeclarationHandler,
  createQuickDeclarationHandler,
  getQuickDeclarationContextHandler,
  previewQuickDeclarationConflictsHandler,
  listMyDeclarationsHandler,
  listMyTelemetrySourcesHandler,
  getMyTelemetrySourceHandler,
  listMyAllowedDeclarationTypesHandler,
  getDeclarationDetailHandler,
  getAvailablePointsPrelevementsForDeclarationHandler,
  requestDeclarationPointsChangeHandler,
  reconcileDeclarationChunkHandler,
  deleteDeclarationHandler,
  listReplayableDeclarationsHandler,
  replayDeclarationHandler
} from './handlers/declarations.js'
import {listMyDeclarationFeedHandler} from './handlers/declaration-feed.js'
import {
  createServiceAccountAccessTokenHandler,
  listManagedDeclarantsForServiceAccountHandler,
  createDeclarantImpersonationTokenHandler,
  getDeclarantContextHandler
} from './handlers/service-accounts-auth.js'
import {
  listServiceAccountDeclarantOptionsHandler,
  listServiceAccountsHandler,
  createServiceAccountHandler,
  getServiceAccountHandler,
  updateServiceAccountHandler,
  deleteServiceAccountHandler,
  restoreServiceAccountHandler,
  listServiceAccountCredentialsHandler,
  createServiceAccountCredentialHandler,
  revokeServiceAccountCredentialHandler,
  listServiceAccountDeclarantsHandler,
  addServiceAccountDeclarantHandler,
  updateServiceAccountDeclarantHandler,
  removeServiceAccountDeclarantHandler
} from './handlers/admin-service-accounts.js'
import {
  addDeclarantDeclarationTypeHandler,
  createDeclarationTypeHandler,
  disableDeclarationTypeHandler,
  getDeclarationTypeHandler,
  listDeclarantDeclarationTypesHandler,
  listDeclarationTypesHandler,
  removeDeclarantDeclarationTypeHandler,
  restoreDeclarationTypeHandler,
  updateDeclarantDeclarationTypeHandler,
  updateDeclarationTypeHandler
} from './handlers/declaration-types.js'
import {
  handlePoint,
  handleDeclarant,
  handleExploitation,
  handleDocument,
  handleRegle
} from './resolvers.js'
import {
  addZoneInstructorHandler,
  getZoneHandler,
  getZoneInstructorHandler,
  listZoneInstructorOptionsHandler,
  listZoneOptionsHandler,
  listZoneInstructorsHandler,
  listZones,
  removeZoneInstructorHandler,
  sendZoneInstructorAccountCreationNotificationHandler,
  sendZoneInstructorAttachmentNotificationHandler
} from './handlers/zones.js'
import {
  createZoneExploitationHandler,
  createZonePointPrelevementHandler,
  deleteZoneExploitationHandler,
  deleteZonePointPrelevementHandler,
  getZoneExploitationHandler,
  getZoneDeclarationMonthlyStatusHandler,
  getZoneGeometryHandler,
  getZonePointPrelevementHandler,
  exportZoneDeclarationMissingHandler,
  listZoneDeclarantOptionsHandler,
  listZoneDeclarantsHandler,
  listZoneExploitationsHandler,
  listZoneCollecteursHandler,
  listZonePointOptionsHandler,
  listZonePointsPrelevementHandler,
  updateZoneExploitationHandler,
  updateZonePointPrelevementHandler
} from './handlers/zone-resources.js'
import {
  createZoneMonitoringStationHandler,
  deleteZoneMonitoringStationHandler,
  listZoneMonitoringStationsHandler,
  updateZoneMonitoringStationHandler
} from './handlers/zone-monitoring-stations.js'
import {getMySourceHandler, listMySourcesHandler} from './handlers/sources.js'
import {updateChunkInstructionHandler} from './handlers/chunks.js'
import {createApiImportHandler} from './handlers/api-imports.js'
import {
  getDeclarationProcessingContextHandler,
  ingestDeclarationSeriesHandler
} from './handlers/service-account-declarations.js'
import {ingestServiceAccountConnectorOutputHandler} from './handlers/service-account-connectors.js'
import {
  getZoneDeclarationSettingsHandler,
  updateZoneDeclarationSettingsHandler,
  createZoneDeclarationOverrideHandler,
  updateZoneDeclarationOverrideHandler,
  deleteZoneDeclarationOverrideHandler
} from './handlers/zone-declaration-settings.js'
import {
  getDeclarationNotificationRunHandler,
  listDeclarationNotificationSettingsHandler,
  listDeclarationNotificationRunsHandler,
  listUpcomingDeclarationNotificationsHandler,
  previewDeclarationNotificationEmailHandler,
  previewDeclarationNotificationHandler,
  retryDeclarationNotificationFailuresHandler,
  sendDeclarationNotificationNowHandler,
  updateDeclarationNotificationSettingHandler
} from './handlers/declaration-notifications.js'
import {
  createDataExportHandler,
  deleteDataExportHandler,
  getDataExportDownloadHandler,
  getDataExportHandler,
  getDataExportOptionsHandler,
  listDataExportsHandler
} from './handlers/data-exports.js'
import {
  getDashboardPiezometryHandler,
  getDashboardRiverFlowsHandler
} from './handlers/dashboard-water-resources.js'
import {getZonePermissionCatalogHandler} from './handlers/zone-permissions.js'
import {
  getAuditEventDetailHandler,
  getAuditEventFilterOptionsHandler,
  listResourceAuditHistoryHandler,
  listAuditEventsHandler
} from './handlers/audit-events.js'

const storage = multer.memoryStorage()
const upload = multer({
  storage,
  limits: {
    fileSize: 50_000_000
  }
})

export function createRoutes({authMethods = readAuthMethods()} = {}) {
  const app = new Router()
  const authMethodNotFound = (req, res) => res.status(404).send({
    code: 404,
    message: 'Méthode d’authentification non disponible.'
  })

  /* Auth routes - pas de middleware handleToken pour ces routes */

  app.get('/auth/config', (req, res) => getAuthConfigHandler(req, res, authMethods))

  // Rate limiter pour éviter les abus sur la demande d'authentification
  const authRequestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // 20 requêtes par IP
    message: 'Trop de demandes d\'authentification. Veuillez réessayer dans 15 minutes.',
    standardHeaders: true,
    legacyHeaders: false
  })

  if (authMethods.includes(AUTH_METHODS.MAGIC_LINK)) {
    app.post('/auth/request', authRequestLimiter, requestAuth)
    app.post('/auth/verify', verifyAuthToken)
  } else {
    app.post('/auth/request', authMethodNotFound)
    app.post('/auth/verify', authMethodNotFound)
  }

  if (authMethods.includes(AUTH_METHODS.PASSWORD)) {
    app.post('/auth/password', passwordLoginRateLimiter, passwordLoginHandler)
    app.post(
      '/auth/password/activate',
      passwordActivationRateLimiter,
      activatePasswordHandler
    )
  } else {
    app.post('/auth/password', authMethodNotFound)
    app.post('/auth/password/activate', authMethodNotFound)
    app.post('/auth/password/change', authMethodNotFound)
    app.get('/admin/password-accesses', authMethodNotFound)
    app.post('/admin/password-accesses', authMethodNotFound)
    app.delete('/admin/password-accesses/:userId', authMethodNotFound)
  }

  app.post(
    '/auth/email-verifications/confirm',
    emailVerificationConfirmationRateLimiter,
    confirmEmailVerificationHandler
  )

  app.post('/auth/logout', handleToken, logout)
  app.get('/healthz', (req, res) => res.json({ok: true}))

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

  if (authMethods.includes(AUTH_METHODS.PASSWORD)) {
    app.post(
      '/auth/password/change',
      ensureHumanSession,
      ensureNotImpersonating,
      changePasswordHandler
    )
  }

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

  app.get(
    '/service-accounts/declarations/:declarationId/processing-context',
    ensureServiceAccountAuthenticated,
    getDeclarationProcessingContextHandler
  )

  app.post(
    '/service-accounts/declarations/:declarationId/ingest',
    ensureServiceAccountAuthenticated,
    ingestDeclarationSeriesHandler
  )

  app.post(
    '/service-accounts/connectors/ingest',
    ensureServiceAccountAuthenticated,
    ingestServiceAccountConnectorOutputHandler
  )

  app.use(ensureHumanSession)

  /* Resolvers */

  app.param('pointId', handlePoint)
  app.param('declarantId', handleDeclarant)
  app.param('exploitationId', handleExploitation)
  app.param('documentId', handleDocument)
  app.param('regleId', handleRegle)

  app.get('/info', ensureAuthenticated, getInfoHandler)
  app.get(
    '/zone-agent-permissions',
    ensureRole('INSTRUCTOR'),
    getZonePermissionCatalogHandler
  )

  app.post(
    '/admin/impersonations',
    ensureRole('ADMIN'),
    startAdminImpersonationHandler
  )

  app.delete(
    '/auth/impersonation',
    stopAdminImpersonationHandler
  )

  app.get('/admin/dashboard', ensureRole('ADMIN'), getAdminDashboardHandler)

  if (authMethods.includes(AUTH_METHODS.PASSWORD)) {
    app.get(
      '/admin/password-accesses',
      ensureRole('ADMIN'),
      ensureNotImpersonating,
      listPasswordAccessesHandler
    )
    app.post(
      '/admin/password-accesses',
      ensureRole('ADMIN'),
      ensureNotImpersonating,
      issuePasswordActivationHandler
    )
    app.delete(
      '/admin/password-accesses/:userId',
      ensureRole('ADMIN'),
      ensureNotImpersonating,
      revokePasswordAccessHandler
    )
  }

  app.get('/admin/audit-events/options', ensureRole('ADMIN'), getAuditEventFilterOptionsHandler)
  app.get('/admin/audit-events/:eventId', ensureRole('ADMIN'), getAuditEventDetailHandler)
  app.get('/admin/audit-events', ensureRole('ADMIN'), listAuditEventsHandler)
  app.get(
    '/audit-history/:resourceType/:resourceId',
    ensureRole('INSTRUCTOR', 'ADMIN'),
    listResourceAuditHistoryHandler
  )

  app.get('/users/me/email-aliases', ensureAuthenticated, listMyEmailAliasesHandler)
  app.patch(
    '/users/me/profile',
    ensureAuthenticated,
    updateMyProfileHandler
  )
  app.post(
    '/users/me/email-change',
    ensureAuthenticated,
    emailVerificationRequestRateLimiter,
    requestPrimaryEmailChangeHandler
  )
  app.post(
    '/users/me/email-aliases',
    ensureAuthenticated,
    emailVerificationRequestRateLimiter,
    createMyEmailAliasHandler
  )
  app.delete(
    '/users/me/email-aliases/:emailAliasId',
    ensureAuthenticated,
    deleteMyEmailAliasHandler
  )
  app.post(
    '/users/me/email-verifications/:verificationId/resend',
    ensureAuthenticated,
    emailVerificationRequestRateLimiter,
    resendMyEmailVerificationHandler
  )
  app.delete(
    '/users/me/email-verifications/:verificationId',
    ensureAuthenticated,
    cancelMyEmailVerificationHandler
  )

  /* Administration - comptes de service */

  app.get(
    '/admin/service-accounts/declarants-options',
    ensureRole('ADMIN'),
    listServiceAccountDeclarantOptionsHandler
  )

  app.route('/admin/service-accounts')
    .get(ensureRole('ADMIN'), listServiceAccountsHandler)
    .post(ensureRole('ADMIN'), createServiceAccountHandler)

  app.route('/admin/service-accounts/:serviceAccountId')
    .get(ensureRole('ADMIN'), getServiceAccountHandler)
    .put(ensureRole('ADMIN'), updateServiceAccountHandler)
    .delete(ensureRole('ADMIN'), deleteServiceAccountHandler)

  app.post(
    '/admin/service-accounts/:serviceAccountId/restore',
    ensureRole('ADMIN'),
    restoreServiceAccountHandler
  )

  app.route('/admin/service-accounts/:serviceAccountId/credentials')
    .get(ensureRole('ADMIN'), listServiceAccountCredentialsHandler)
    .post(ensureRole('ADMIN'), createServiceAccountCredentialHandler)

  app.route('/admin/service-accounts/:serviceAccountId/credentials/:credentialId')
    .delete(ensureRole('ADMIN'), revokeServiceAccountCredentialHandler)

  app.route('/admin/service-accounts/:serviceAccountId/declarants')
    .get(ensureRole('ADMIN'), listServiceAccountDeclarantsHandler)
    .post(ensureRole('ADMIN'), addServiceAccountDeclarantHandler)

  app.route('/admin/service-accounts/:serviceAccountId/declarants/:linkId')
    .put(ensureRole('ADMIN'), updateServiceAccountDeclarantHandler)
    .delete(ensureRole('ADMIN'), removeServiceAccountDeclarantHandler)

  /* Administration - notifications de déclaration */

  app.get(
    '/admin/declaration-notifications/upcoming',
    ensureRole('ADMIN'),
    listUpcomingDeclarationNotificationsHandler
  )

  app.get(
    '/admin/declaration-notifications/settings',
    ensureRole('ADMIN'),
    listDeclarationNotificationSettingsHandler
  )

  app.put(
    '/admin/declaration-notifications/settings/:notificationType/:periodType',
    ensureRole('ADMIN'),
    updateDeclarationNotificationSettingHandler
  )

  app.get(
    '/admin/declaration-notifications/preview',
    ensureRole('ADMIN'),
    previewDeclarationNotificationHandler
  )

  app.post(
    '/admin/declaration-notifications/email-preview',
    ensureRole('ADMIN'),
    previewDeclarationNotificationEmailHandler
  )

  app.get(
    '/admin/declaration-notifications/runs',
    ensureRole('ADMIN'),
    listDeclarationNotificationRunsHandler
  )

  app.post(
    '/admin/declaration-notifications/send-now',
    ensureRole('ADMIN'),
    sendDeclarationNotificationNowHandler
  )

  app.get(
    '/admin/declaration-notifications/runs/:runId',
    ensureRole('ADMIN'),
    getDeclarationNotificationRunHandler
  )

  app.post(
    '/admin/declaration-notifications/runs/:runId/retry-failures',
    ensureRole('ADMIN'),
    retryDeclarationNotificationFailuresHandler
  )

  /* Administration - types de déclaration */

  app.route('/admin/declaration-types')
    .get(ensureRole('ADMIN'), listDeclarationTypesHandler)
    .post(ensureRole('ADMIN'), createDeclarationTypeHandler)

  app.route('/admin/declaration-types/:declarationTypeId')
    .get(ensureRole('ADMIN'), getDeclarationTypeHandler)
    .put(ensureRole('ADMIN'), updateDeclarationTypeHandler)
    .delete(ensureRole('ADMIN'), disableDeclarationTypeHandler)

  app.post(
    '/admin/declaration-types/:declarationTypeId/restore',
    ensureRole('ADMIN'),
    restoreDeclarationTypeHandler
  )

  /* Déclarations */
  app.post('/declarations', ensureRole('DECLARANT'), upload.array('files', 50), createDeclarationHandler)
  app.post('/declarations/quick', ensureRole('DECLARANT'), createQuickDeclarationHandler)
  app.post('/declarations/quick/conflicts', ensureRole('DECLARANT'), previewQuickDeclarationConflictsHandler)
  app.get('/declarations/quick/context', ensureRole('DECLARANT'), getQuickDeclarationContextHandler)
  app.get('/declarations/me/feed', ensureRole('DECLARANT'), listMyDeclarationFeedHandler)
  app.get('/declarations/me', ensureRole('DECLARANT'), listMyDeclarationsHandler)
  app.get('/declarations/me/telemetry-sources', ensureRole('DECLARANT'), listMyTelemetrySourcesHandler)
  app.get('/declarations/allowed-types', ensureRole('DECLARANT'), listMyAllowedDeclarationTypesHandler)
  app.get('/declarations/telemetry-sources/:sourceId', ensureRole('DECLARANT'), getMyTelemetrySourceHandler)
  app.get('/declarations/:declarationId', ensureRole('DECLARANT'), getDeclarationDetailHandler)
  app.post('/declarations/:declarationId/points-change-request', ensureRole('DECLARANT'), requestDeclarationPointsChangeHandler)
  app.get(
    '/declarations/:declarationId/available-points-prelevements',
    ensureRole('DECLARANT', 'INSTRUCTOR'),
    authorizeDeclarationPermission('declaration.reconcile'),
    getAvailablePointsPrelevementsForDeclarationHandler
  )
  app.post(
    '/declarations/:declarationId/chunks/:chunkId/reconcile',
    ensureRole('DECLARANT', 'INSTRUCTOR'),
    authorizeChunk('reconcile', 'declaration.reconcile'),
    reconcileDeclarationChunkHandler
  )
  app.get('/admin/declarations/replayable', ensureRole('ADMIN'), listReplayableDeclarationsHandler)
  app.delete('/admin/declarations/:declarationId', ensureRole('ADMIN'), deleteDeclarationHandler)
  app.post('/admin/declarations/:declarationId/replay', ensureRole('ADMIN'), replayDeclarationHandler)

  /* Collecteurs */
  app.get('/collecteurs/me/preleveurs', ensureRole('DECLARANT'), getCollecteurPreleveursHandler)
  app.get(
    '/collecteurs/me/preleveurs/search',
    ensureRole('DECLARANT'),
    searchCollecteurPreleveursHandler
  )
  app.get(
    '/collecteurs/:collecteurId/exploitations/candidates',
    ensureRole('INSTRUCTOR', 'ADMIN'),
    listCollecteurExploitationCandidatesHandler
  )
  app.patch(
    '/collecteurs/:collecteurId/exploitations',
    ensureRole('INSTRUCTOR', 'ADMIN'),
    updateCollecteurExploitationsHandler
  )

  /* Dashboard */
  app.get('/dashboard/map', ensureRole('INSTRUCTOR', 'ADMIN', 'DECLARANT'), authorizeAnyZonePermission('zone.dashboard.read'), getDashboardMapHandler)
  app.get('/dashboard/map/points/:dashboardPointId/actors', ensureRole('INSTRUCTOR', 'ADMIN', 'DECLARANT'), getDashboardPointActorsHandler)
  app.get('/dashboard/territory', ensureRole('INSTRUCTOR', 'ADMIN', 'DECLARANT'), authorizeAnyZonePermission('zone.dashboard.read'), getDashboardTerritoryHandler)
  app.get('/dashboard/water-resources/piezometry', ensureRole('INSTRUCTOR', 'ADMIN', 'DECLARANT'), authorizeAnyZonePermission('zone.dashboard.read'), getDashboardPiezometryHandler)
  app.get('/dashboard/water-resources/flows', ensureRole('INSTRUCTOR', 'ADMIN', 'DECLARANT'), authorizeAnyZonePermission('zone.dashboard.read'), getDashboardRiverFlowsHandler)

  /* Sources */
  app.get('/sources/me', ensureRole('INSTRUCTOR'), authorizeAnyZonePermission('declaration.list'), listMySourcesHandler)
  app.get('/sources/:sourceId', ensureRole('INSTRUCTOR'), authorizeSource('read', 'declaration.detail.read'), getMySourceHandler)

  /* Exports */
  app.get('/exports/options', ensureRole('INSTRUCTOR'), authorizeAnyZonePermission('export.volumes'), getDataExportOptionsHandler)
  app.route('/exports')
    .get(ensureRole('INSTRUCTOR'), authorizeAnyZonePermission('export.volumes'), listDataExportsHandler)
    .post(ensureRole('INSTRUCTOR'), authorizeAnyZonePermission('export.volumes'), createDataExportHandler)
  app.route('/exports/:exportId')
    .get(ensureRole('INSTRUCTOR'), authorizeAnyZonePermission('export.volumes'), getDataExportHandler)
    .delete(ensureRole('INSTRUCTOR'), authorizeAnyZonePermission('export.volumes'), deleteDataExportHandler)
  app.get('/exports/:exportId/download', ensureRole('INSTRUCTOR'), authorizeAnyZonePermission('export.volumes'), getDataExportDownloadHandler)

  /* Chunks */
  app.post('/chunks/:chunkId/instruction', authorizeChunk('write', 'declaration.instruct'), updateChunkInstructionHandler)

  /* Points */

  app.route('/points-prelevement')
    .get(ensureRole('INSTRUCTOR', 'DECLARANT', 'ADMIN'), authorizeAnyZonePermission('pp.list'), listPointsPrelevement)
    .post(ensureRole('INSTRUCTOR', 'ADMIN'), authorizeAnyZonePermission('pp.create'), createPointPrelevementHandler)

  app.route('/points-prelevement/options')
    .get(ensureRole('INSTRUCTOR', 'DECLARANT', 'ADMIN'), authorizeAnyZonePermission('pp.list'), listPointsPrelevementOptions)

  app.route('/points-prelevement/map')
    .get(ensureRole('INSTRUCTOR', 'DECLARANT', 'ADMIN'), authorizeAnyZonePermission('pp.map.read'), listPointMapSummaries)

  app.route('/points-prelevement/:pointId')
    .get(authorizePointPrelevement('read', 'pp.detail.read'), getPointPrelevementDetail)
    .put(authorizePointPrelevement('write', 'pp.update'), updatePointPrelevementHandler)
    .delete(authorizePointPrelevement('write', 'pp.delete'), deletePointPrelevementHandler)

  app.patch(
    '/points-prelevement/:pointId/usage-name',
    ensureRole('DECLARANT'),
    updatePointUsageNameHandler
  )

  app.route('/points-prelevement/batch')
    .post(authorizePointsPrelevementBatch('read', 'pp.detail.read'), getPointsPrelevementBatchDetail)

  app.get('/points-prelevement/:pointId/exploitations', authorizePointPrelevement('read', 'exploitation.list'), getPointExploitations)

  /* Zones */

  app.route('/zones')
    .get(ensureRole('INSTRUCTOR'), authorizeAnyZonePermission('zone.detail.read'), listZones)

  app.get('/zones/options', ensureRole('INSTRUCTOR'), listZoneOptionsHandler)

  app.route('/zones/:zoneId')
    .get(ensureRole('INSTRUCTOR'), authorizeZonePermission('zone.detail.read'), getZoneHandler)

  app.route('/zones/:zoneId/geometry')
    .get(ensureRole('INSTRUCTOR'), authorizeZonePermission('zone.geometry.read'), getZoneGeometryHandler)

  app.route('/zones/:zoneId/declarants')
    .get(ensureRole('INSTRUCTOR'), authorizeZonePermission('declarant.list'), listZoneDeclarantsHandler)

  app.route('/zones/:zoneId/collecteurs')
    .get(ensureRole('INSTRUCTOR'), authorizeZonePermission('declarant.list'), listZoneCollecteursHandler)

  app.get(
    '/zones/:zoneId/suivi-declarations/export',
    ensureRole('INSTRUCTOR'),
    authorizeZonePermission('declaration.followup.export'),
    exportZoneDeclarationMissingHandler
  )

  app.route('/zones/:zoneId/suivi-declarations')
    .get(ensureRole('INSTRUCTOR'), authorizeZonePermission('declaration.followup.read'), getZoneDeclarationMonthlyStatusHandler)

  app.route('/zones/:zoneId/declaration-settings')
    .get(ensureRole('INSTRUCTOR'), authorizeZonePermission('zone.declaration.settings.read'), getZoneDeclarationSettingsHandler)
    .put(ensureRole('INSTRUCTOR'), authorizeZonePermission('zone.declaration.settings.update'), updateZoneDeclarationSettingsHandler)

  app.route('/zones/:zoneId/declaration-period-overrides')
    .post(ensureRole('INSTRUCTOR'), authorizeZonePermission('zone.declaration.override.create'), createZoneDeclarationOverrideHandler)

  app.route('/zones/:zoneId/declaration-period-overrides/:overrideId')
    .put(ensureRole('INSTRUCTOR'), authorizeZonePermission('zone.declaration.override.update'), updateZoneDeclarationOverrideHandler)
    .delete(ensureRole('INSTRUCTOR'), authorizeZonePermission('zone.declaration.override.delete'), deleteZoneDeclarationOverrideHandler)

  app.route('/zones/:zoneId/monitoring-stations')
    .get(ensureRole('INSTRUCTOR'), authorizeZonePermission('zone.resource.list'), listZoneMonitoringStationsHandler)
    .post(ensureRole('INSTRUCTOR'), authorizeZonePermission('zone.resource.create'), createZoneMonitoringStationHandler)

  app.route('/zones/:zoneId/monitoring-stations/:associationId')
    .patch(ensureRole('INSTRUCTOR'), authorizeZonePermission('zone.resource.update'), updateZoneMonitoringStationHandler)
    .delete(ensureRole('INSTRUCTOR'), authorizeZonePermission('zone.resource.delete'), deleteZoneMonitoringStationHandler)

  app.route('/zones/:zoneId/points-prelevement')
    .get(ensureRole('INSTRUCTOR'), authorizeZonePermission('pp.list'), listZonePointsPrelevementHandler)
    .post(ensureRole('INSTRUCTOR'), authorizeZonePermission('pp.create'), createZonePointPrelevementHandler)

  app.route('/zones/:zoneId/points-prelevement/options')
    .get(ensureRole('INSTRUCTOR'), authorizeZonePermission('pp.list'), listZonePointOptionsHandler)

  app.route('/zones/:zoneId/points-prelevement/:pointId')
    .get(ensureRole('INSTRUCTOR'), authorizeZonePermission('pp.detail.read'), getZonePointPrelevementHandler)
    .put(ensureRole('INSTRUCTOR'), authorizeZonePermission('pp.update'), updateZonePointPrelevementHandler)
    .delete(ensureRole('INSTRUCTOR'), authorizeZonePermission('pp.delete'), deleteZonePointPrelevementHandler)

  app.route('/zones/:zoneId/exploitations')
    .get(ensureRole('INSTRUCTOR'), authorizeZonePermission('exploitation.list'), listZoneExploitationsHandler)
    .post(ensureRole('INSTRUCTOR'), authorizeZonePermission('exploitation.create'), createZoneExploitationHandler)

  app.route('/zones/:zoneId/exploitations/declarants-options')
    .get(
      ensureRole('INSTRUCTOR'),
      authorizeZoneAnyPermission('exploitation.create', 'exploitation.update'),
      listZoneDeclarantOptionsHandler
    )

  app.route('/zones/:zoneId/exploitations/:exploitationId')
    .get(ensureRole('INSTRUCTOR'), authorizeZonePermission('exploitation.detail.read'), getZoneExploitationHandler)
    .put(ensureRole('INSTRUCTOR'), authorizeZonePermission('exploitation.update'), updateZoneExploitationHandler)
    .delete(ensureRole('INSTRUCTOR'), authorizeZonePermission('exploitation.delete'), deleteZoneExploitationHandler)

  app.route('/zones/:zoneId/instructeurs')
    .get(ensureRole('INSTRUCTOR'), authorizeZonePermission('zone.agent.list'), listZoneInstructorsHandler)
    .post(ensureRole('INSTRUCTOR'), authorizeZonePermission('zone.agent.create'), addZoneInstructorHandler)

  app.route('/zones/:zoneId/instructeurs/options')
    .get(ensureRole('INSTRUCTOR'), authorizeZonePermission('zone.agent.create'), listZoneInstructorOptionsHandler)

  app.route('/zones/:zoneId/instructeurs/:instructorUserId')
    .get(ensureRole('INSTRUCTOR'), authorizeZonePermission('zone.agent.detail.read'), getZoneInstructorHandler)
    .patch(ensureRole('INSTRUCTOR'), authorizeZonePermission('zone.agent.update'), addZoneInstructorHandler)
    .delete(ensureRole('INSTRUCTOR'), authorizeZonePermission('zone.agent.remove'), removeZoneInstructorHandler)

  app.post(
    '/zones/:zoneId/instructeurs/:instructorUserId/notifications/account-creation',
    ensureRole('INSTRUCTOR'),
    authorizeZonePermission('zone.agent.notify'),
    sendZoneInstructorAccountCreationNotificationHandler
  )
  app.post(
    '/zones/:zoneId/instructeurs/:instructorUserId/notifications/zone-attachment',
    ensureRole('INSTRUCTOR'),
    authorizeZonePermission('zone.agent.notify'),
    sendZoneInstructorAttachmentNotificationHandler
  )

  /* Exploitations */

  app.route('/exploitations')
    .post(ensureRole('INSTRUCTOR', 'ADMIN'), authorizeAnyZonePermission('exploitation.create'), createExploitationHandler)

  app.route('/exploitations/:exploitationId')
    .get(authorizeExploitation('read', 'exploitation.detail.read'), getExploitationDetail)
    .put(authorizeExploitation('write', 'exploitation.update'), updateExploitationHandler)
    .delete(authorizeExploitation('write', 'exploitation.delete'), deleteExploitationHandler)

  app.get('/exploitations/:exploitationId/documents', authorizeExploitation('read', 'declarant.document.read'), getExploitationDocuments)

  /* Règles */

  app.route('/regles/:regleId')
    .get(authorizeRegle('read', 'declarant.rule.read'), getRegleDetail)
    .put(authorizeRegle('write', 'declarant.rule.update'), updateRegleHandler)
    .delete(authorizeRegle('write', 'declarant.rule.delete'), deleteRegleHandler)

  /* Documents */

  app.route('/documents/:documentId')
    .get(authorizeDocument('read', 'declarant.document.read'), getDocumentDetail)
    .put(authorizeDocument('write', 'declarant.document.update'), updateDocumentHandler)
    .delete(authorizeDocument('write', 'declarant.document.delete'), deleteDocumentHandler)

  /* Déclarants */

  app.get(
    '/declarants/search',
    ensureRole('INSTRUCTOR', 'ADMIN'),
    authorizeAnyZonePermission('declarant.list'),
    searchDeclarantsHandler
  )

  app.route('/declarants')
    .get(ensureRole('INSTRUCTOR', 'ADMIN'), authorizeAnyZonePermission('declarant.list'), listDeclarants)
    .post(ensureRole('INSTRUCTOR', 'ADMIN'), authorizeDeclarantCreation, createPreleveurHandler)

  app.route('/declarants/:declarantId')
    .get(authorizeDeclarant('read', 'declarant.detail.read'), getDeclarantDetail)
    .put(authorizeDeclarant('write', 'declarant.update'), updatePreleveurHandler)
    .delete(authorizeDeclarant('write', 'declarant.delete'), deletePreleveurHandler)

  app.get(
    '/declarants/:declarantId/overview',
    authorizeDeclarant('read', 'declarant.detail.read'),
    getDeclarantOverviewHandler
  )

  app.route('/declarants/:declarantId/zones')
    .get(authorizeDeclarant('read', 'declarant.detail.read'), getDeclarantZonesHandler)
    .put(authorizeDeclarant('write', 'declarant.zone.update'), updateDeclarantZonesHandler)

  app.route('/declarants/:declarantId/contact-emails')
    .get(authorizeDeclarant('read', 'declarant.detail.read'), listDeclarantContactEmailsHandler)
    .put(authorizeDeclarant('write', 'declarant.update'), replaceDeclarantContactEmailsHandler)

  app.route('/declarants/:declarantId/declaration-types')
    .get(ensureRole('INSTRUCTOR', 'ADMIN'), authorizeDeclarant('read', 'declarant.declaration-type.read'), listDeclarantDeclarationTypesHandler)
    .post(ensureRole('INSTRUCTOR', 'ADMIN'), authorizeDeclarant('write', 'declarant.declaration-type.update'), addDeclarantDeclarationTypeHandler)

  app.route('/declarants/:declarantId/declaration-types/:linkId')
    .put(ensureRole('INSTRUCTOR', 'ADMIN'), authorizeDeclarant('write', 'declarant.declaration-type.update'), updateDeclarantDeclarationTypeHandler)
    .delete(ensureRole('INSTRUCTOR', 'ADMIN'), authorizeDeclarant('write', 'declarant.declaration-type.update'), removeDeclarantDeclarationTypeHandler)

  app.post(
    '/declarants/:declarantId/notifications/account-creation',
    authorizeDeclarant('write', 'declarant.invite'),
    sendDeclarantAccountCreationNotificationHandler
  )

  app.route('/declarants/:declarantId/email-aliases')
    .get(authorizeDeclarant('read', 'declarant.email-alias.read'), listDeclarantEmailAliasesHandler)
    .post(authorizeDeclarant('write', 'declarant.email-alias.update'), createDeclarantEmailAliasHandler)

  app.delete(
    '/declarants/:declarantId/email-aliases/:emailAliasId',
    authorizeDeclarant('write', 'declarant.email-alias.update'),
    deleteDeclarantEmailAliasHandler
  )

  app.get('/preleveurs/:declarantId/points-prelevement', authorizeDeclarant('read', 'pp.list'), getPreleveurPointsPrelevement)

  app.get('/preleveurs/:declarantId/exploitations', authorizeDeclarant('read', 'exploitation.list'), getPreleveurExploitationsHandler)
  app.get('/preleveurs/:declarantId/exploitations-via-points', authorizeDeclarant('read', 'exploitation.list'), getPreleveurExploitationsViaPointsHandler)

  /* Préleveurs - Règles */

  app.route('/preleveurs/:declarantId/regles')
    .get(authorizeDeclarant('read', 'declarant.rule.read'), getPreleveurReglesHandler)
    .post(authorizeDeclarant('write', 'declarant.rule.create'), createPreleveurRegle)

  /* Préleveurs - Documents */

  app.route('/preleveurs/:declarantId/documents')
    .get(authorizeDeclarant('read', 'declarant.document.read'), getPreleveurDocumentsHandler)
    .post(authorizeDeclarant('write', 'declarant.document.create'), upload.single('document'), createPreleveurDocument)

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

  app.get('/referentiels/usages-eau', ensureAuthenticated, getWaterUsesHandler)

  /* Statistiques */

  app.get('/stats/', getStatsHandler)

  // Recherche séries métadonnées
  app.get('/series', ensureRole('INSTRUCTOR'), authorizeAnyZonePermission('pp.volumes.read'), listSeriesMetadataSearch)

  // Série: métadonnées seules
  app.get('/series/:seriesId', ensureRole('INSTRUCTOR'), authorizeAnyZonePermission('pp.volumes.read'), getSeriesMetadataHandler)

  // Série: valeurs
  app.get('/series/:seriesId/values', ensureRole('INSTRUCTOR'), authorizeAnyZonePermission('pp.volumes.read'), getSeriesValuesHandler)

  // Séries agrégées sur plusieurs points
  app.get('/aggregated-series', ensureRole('INSTRUCTOR', 'ADMIN', 'DECLARANT'), authorizeAggregationRead, getAggregatedSeriesHandler)

  // Options disponibles pour l'agrégation de séries (paramètres et plages de dates)
  app.get('/aggregated-series/options', ensureRole('INSTRUCTOR', 'ADMIN', 'DECLARANT'), authorizeAggregationRead, getAggregatedSeriesOptionsHandler)

  // Debug Sentry
  app.get('/debug-sentry', () => {
    throw new Error('Erreur test Sentry !')
  })

  return app
}

const routes = createRoutes()
export default routes
