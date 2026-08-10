import {match} from 'path-to-regexp'

/* eslint-disable max-params, @stylistic/max-len -- Les entrées restent volontairement lisibles sur une ligne. */

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i

export const AUDIT_ACTION_CATEGORIES = Object.freeze({
  AUTHENTICATION: 'Authentification',
  IMPERSONATION: 'Impersonation',
  DECLARATION: 'Déclarations',
  DATA_INGESTION: 'Ingestion de données',
  EXPORT: 'Exports et téléchargements',
  POINT: 'Points de prélèvement',
  EXPLOITATION: 'Exploitations',
  DECLARANT: 'Déclarants',
  ZONE: 'Zones et droits',
  DOCUMENT: 'Documents et règles',
  SERVICE_ACCOUNT: 'Comptes de service',
  NOTIFICATION: 'Notifications',
  CONFIGURATION: 'Configuration',
  AUDIT: 'Journal de sécurité'
})

function action(method, path, type, category, label, options = {}) {
  return {
    method,
    path,
    type,
    category,
    categoryLabel: AUDIT_ACTION_CATEGORIES[category],
    label,
    ...options
  }
}

export const AUDIT_ACTIONS = Object.freeze([
  action('POST', '/auth/request', 'AUTH.LOGIN_LINK_REQUESTED', 'AUTHENTICATION', 'Demande de lien de connexion'),
  action('POST', '/auth/verify', 'AUTH.LOGIN_VERIFIED', 'AUTHENTICATION', 'Connexion avec un lien sécurisé'),
  action('POST', '/auth/logout', 'AUTH.LOGOUT', 'AUTHENTICATION', 'Déconnexion'),
  action('POST', '/service-accounts/token', 'AUTH.SERVICE_ACCOUNT_TOKEN_CREATED', 'AUTHENTICATION', 'Authentification d’un compte de service'),

  action('POST', '/admin/impersonations', 'IMPERSONATION.ADMIN_STARTED', 'IMPERSONATION', 'Démarrage d’une impersonation', {
    subject: {body: 'userId'},
    target: {type: 'USER', body: 'userId'}
  }),
  action('DELETE', '/auth/impersonation', 'IMPERSONATION.ADMIN_STOPPED', 'IMPERSONATION', 'Arrêt d’une impersonation'),
  action('POST', '/service-accounts/declarants/:declarantUserId/token', 'IMPERSONATION.SERVICE_ACCOUNT_TOKEN_CREATED', 'IMPERSONATION', 'Création d’un accès déclarant pour un compte de service', {
    subject: {param: 'declarantUserId'},
    target: {type: 'USER', param: 'declarantUserId'}
  }),

  action('POST', '/declarations', 'DECLARATION.FILE_CREATED', 'DECLARATION', 'Dépôt d’une déclaration par fichier', {
    subject: {body: 'declarantUserId'},
    target: {type: 'DECLARATION'}
  }),
  action('POST', '/declarations/quick', 'DECLARATION.QUICK_CREATED', 'DECLARATION', 'Dépôt d’une déclaration rapide', {
    subject: {body: 'declarantUserId'},
    target: {type: 'DECLARATION'}
  }),
  action('GET', '/declarations/:declarationId', 'DECLARATION.SENSITIVE_DETAIL_VIEWED', 'DECLARATION', 'Consultation des fichiers d’une déclaration', {
    target: {type: 'DECLARATION', param: 'declarationId'},
    requireUuidParams: ['declarationId']
  }),
  action('GET', '/declarations/telemetry-sources/:sourceId', 'DECLARATION.TELEMETRY_SOURCE_VIEWED', 'DECLARATION', 'Consultation d’une transmission de télérelève', {
    target: {type: 'SOURCE', param: 'sourceId'},
    requireUuidParams: ['sourceId']
  }),
  action('POST', '/declarations/:declarationId/points-change-request', 'DECLARATION.POINT_CHANGE_REQUESTED', 'DECLARATION', 'Demande de modification des points d’une déclaration', {target: {type: 'DECLARATION', param: 'declarationId'}}),
  action('POST', '/declarations/:declarationId/chunks/:chunkId/reconcile', 'DECLARATION.CHUNK_RECONCILED', 'DECLARATION', 'Rapprochement d’une ligne de déclaration', {target: {type: 'CHUNK', param: 'chunkId'}}),
  action('POST', '/chunks/:chunkId/instruction', 'DECLARATION.CHUNK_INSTRUCTED', 'DECLARATION', 'Instruction d’une ligne de déclaration', {target: {type: 'CHUNK', param: 'chunkId'}}),
  action('DELETE', '/admin/declarations/:declarationId', 'DECLARATION.DELETED', 'DECLARATION', 'Suppression d’une déclaration', {target: {type: 'DECLARATION', param: 'declarationId'}}),
  action('POST', '/admin/declarations/:declarationId/replay', 'DECLARATION.REPLAYED', 'DECLARATION', 'Rejeu d’une déclaration', {target: {type: 'DECLARATION', param: 'declarationId'}}),

  action('POST', '/api-imports', 'INGESTION.API_IMPORT_CREATED', 'DATA_INGESTION', 'Création d’un import API', {target: {type: 'API_IMPORT'}}),
  action('GET', '/service-accounts/me/declarants', 'INGESTION.SERVICE_ACCOUNT_DECLARANTS_VIEWED', 'DATA_INGESTION', 'Consultation des déclarants autorisés par un compte de service'),
  action('GET', '/service-accounts/declarants/:declarantUserId/context', 'INGESTION.DECLARANT_CONTEXT_VIEWED', 'DATA_INGESTION', 'Consultation du contexte d’ingestion d’un déclarant', {
    subject: {param: 'declarantUserId'},
    target: {type: 'USER', param: 'declarantUserId'}
  }),
  action('GET', '/service-accounts/declarations/:declarationId/processing-context', 'INGESTION.DECLARATION_CONTEXT_VIEWED', 'DATA_INGESTION', 'Consultation du contexte de traitement d’une déclaration', {target: {type: 'DECLARATION', param: 'declarationId'}}),
  action('POST', '/service-accounts/declarations/:declarationId/ingest', 'INGESTION.DECLARATION_SERIES_INGESTED', 'DATA_INGESTION', 'Ingestion des séries d’une déclaration', {target: {type: 'DECLARATION', param: 'declarationId'}}),
  action('POST', '/service-accounts/connectors/ingest', 'INGESTION.CONNECTOR_OUTPUT_INGESTED', 'DATA_INGESTION', 'Ingestion de données d’un connecteur'),

  action('POST', '/exports', 'EXPORT.CREATED', 'EXPORT', 'Demande d’un export', {target: {type: 'DATA_EXPORT'}}),
  action('DELETE', '/exports/:exportId', 'EXPORT.DELETED', 'EXPORT', 'Suppression d’un export', {target: {type: 'DATA_EXPORT', param: 'exportId'}}),
  action('GET', '/exports/:exportId/download', 'EXPORT.DOWNLOADED', 'EXPORT', 'Téléchargement d’un export', {target: {type: 'DATA_EXPORT', param: 'exportId'}}),
  action('GET', '/zones/:zoneId/suivi-declarations/export', 'EXPORT.DECLARATION_FOLLOWUP_DOWNLOADED', 'EXPORT', 'Export du suivi des déclarations', {
    target: {type: 'ZONE', param: 'zoneId'},
    safeQueryFields: ['startDate', 'endDate', 'periodType', 'period']
  }),
  action('GET', '/sources/:sourceId', 'EXPORT.SOURCE_FILE_ACCESSED', 'EXPORT', 'Accès au fichier source d’une déclaration', {
    target: {type: 'SOURCE', param: 'sourceId'},
    requireUuidParams: ['sourceId']
  }),

  action('POST', '/points-prelevement', 'POINT.CREATED', 'POINT', 'Création d’un point de prélèvement', {target: {type: 'POINT'}}),
  action('PUT', '/points-prelevement/:pointId', 'POINT.UPDATED', 'POINT', 'Modification d’un point de prélèvement', {target: {type: 'POINT', param: 'pointId'}}),
  action('DELETE', '/points-prelevement/:pointId', 'POINT.DELETED', 'POINT', 'Suppression d’un point de prélèvement', {target: {type: 'POINT', param: 'pointId'}}),
  action('PATCH', '/points-prelevement/:pointId/usage-name', 'POINT.USAGE_NAME_UPDATED', 'POINT', 'Modification du nom d’usage d’un point', {target: {type: 'POINT', param: 'pointId'}}),
  action('POST', '/zones/:zoneId/points-prelevement', 'POINT.CREATED_IN_ZONE', 'POINT', 'Création d’un point dans une zone', {target: {type: 'ZONE', param: 'zoneId'}}),
  action('PUT', '/zones/:zoneId/points-prelevement/:pointId', 'POINT.UPDATED_IN_ZONE', 'POINT', 'Modification d’un point dans une zone', {target: {type: 'POINT', param: 'pointId'}}),
  action('DELETE', '/zones/:zoneId/points-prelevement/:pointId', 'POINT.DELETED_FROM_ZONE', 'POINT', 'Suppression d’un point depuis une zone', {target: {type: 'POINT', param: 'pointId'}}),

  action('POST', '/exploitations', 'EXPLOITATION.CREATED', 'EXPLOITATION', 'Création d’une exploitation', {target: {type: 'EXPLOITATION'}}),
  action('PUT', '/exploitations/:exploitationId', 'EXPLOITATION.UPDATED', 'EXPLOITATION', 'Modification d’une exploitation', {target: {type: 'EXPLOITATION', param: 'exploitationId'}}),
  action('DELETE', '/exploitations/:exploitationId', 'EXPLOITATION.DELETED', 'EXPLOITATION', 'Suppression d’une exploitation', {target: {type: 'EXPLOITATION', param: 'exploitationId'}}),
  action('POST', '/zones/:zoneId/exploitations', 'EXPLOITATION.CREATED_IN_ZONE', 'EXPLOITATION', 'Création d’une exploitation dans une zone', {target: {type: 'ZONE', param: 'zoneId'}}),
  action('PUT', '/zones/:zoneId/exploitations/:exploitationId', 'EXPLOITATION.UPDATED_IN_ZONE', 'EXPLOITATION', 'Modification d’une exploitation dans une zone', {target: {type: 'EXPLOITATION', param: 'exploitationId'}}),
  action('DELETE', '/zones/:zoneId/exploitations/:exploitationId', 'EXPLOITATION.DELETED_FROM_ZONE', 'EXPLOITATION', 'Suppression d’une exploitation depuis une zone', {target: {type: 'EXPLOITATION', param: 'exploitationId'}}),

  action('POST', '/declarants', 'DECLARANT.CREATED', 'DECLARANT', 'Création d’un déclarant', {target: {type: 'DECLARANT'}}),
  action('PUT', '/declarants/:declarantId', 'DECLARANT.UPDATED', 'DECLARANT', 'Modification d’un déclarant', {
    subject: {param: 'declarantId'},
    target: {type: 'DECLARANT', param: 'declarantId'}
  }),
  action('DELETE', '/declarants/:declarantId', 'DECLARANT.DELETED', 'DECLARANT', 'Suppression d’un déclarant', {
    subject: {param: 'declarantId'},
    target: {type: 'DECLARANT', param: 'declarantId'}
  }),
  action('PUT', '/declarants/:declarantId/zones', 'DECLARANT.ZONES_UPDATED', 'DECLARANT', 'Modification des zones d’un déclarant', {
    subject: {param: 'declarantId'},
    target: {type: 'DECLARANT', param: 'declarantId'}
  }),
  action('POST', '/declarants/:declarantId/declaration-types', 'DECLARANT.DECLARATION_TYPE_ADDED', 'DECLARANT', 'Ajout d’un type de déclaration autorisé', {subject: {param: 'declarantId'}, target: {type: 'DECLARANT', param: 'declarantId'}}),
  action('PUT', '/declarants/:declarantId/declaration-types/:linkId', 'DECLARANT.DECLARATION_TYPE_UPDATED', 'DECLARANT', 'Modification d’un type de déclaration autorisé', {subject: {param: 'declarantId'}, target: {type: 'DECLARANT_DECLARATION_TYPE', param: 'linkId'}}),
  action('DELETE', '/declarants/:declarantId/declaration-types/:linkId', 'DECLARANT.DECLARATION_TYPE_REMOVED', 'DECLARANT', 'Retrait d’un type de déclaration autorisé', {subject: {param: 'declarantId'}, target: {type: 'DECLARANT_DECLARATION_TYPE', param: 'linkId'}}),
  action('POST', '/declarants/:declarantId/notifications/account-creation', 'DECLARANT.ACCOUNT_NOTIFICATION_SENT', 'DECLARANT', 'Envoi d’une invitation à un déclarant', {subject: {param: 'declarantId'}, target: {type: 'DECLARANT', param: 'declarantId'}}),
  action('POST', '/users/me/email-aliases', 'DECLARANT.EMAIL_ALIAS_ADDED', 'DECLARANT', 'Ajout d’une adresse email secondaire'),
  action('DELETE', '/users/me/email-aliases/:emailAliasId', 'DECLARANT.EMAIL_ALIAS_REMOVED', 'DECLARANT', 'Suppression d’une adresse email secondaire', {target: {type: 'EMAIL_ALIAS', param: 'emailAliasId'}}),
  action('POST', '/declarants/:declarantId/email-aliases', 'DECLARANT.EMAIL_ALIAS_ADDED_BY_AGENT', 'DECLARANT', 'Ajout d’une adresse email secondaire par un agent', {subject: {param: 'declarantId'}, target: {type: 'DECLARANT', param: 'declarantId'}}),
  action('DELETE', '/declarants/:declarantId/email-aliases/:emailAliasId', 'DECLARANT.EMAIL_ALIAS_REMOVED_BY_AGENT', 'DECLARANT', 'Suppression d’une adresse email secondaire par un agent', {subject: {param: 'declarantId'}, target: {type: 'EMAIL_ALIAS', param: 'emailAliasId'}}),

  action('PUT', '/zones/:zoneId/declaration-settings', 'ZONE.DECLARATION_SETTINGS_UPDATED', 'ZONE', 'Modification des paramètres de déclaration d’une zone', {target: {type: 'ZONE', param: 'zoneId'}}),
  action('POST', '/zones/:zoneId/declaration-period-overrides', 'ZONE.DECLARATION_OVERRIDE_CREATED', 'ZONE', 'Création d’une exception de période de déclaration', {target: {type: 'ZONE', param: 'zoneId'}}),
  action('PUT', '/zones/:zoneId/declaration-period-overrides/:overrideId', 'ZONE.DECLARATION_OVERRIDE_UPDATED', 'ZONE', 'Modification d’une exception de période de déclaration', {target: {type: 'DECLARATION_OVERRIDE', param: 'overrideId'}}),
  action('DELETE', '/zones/:zoneId/declaration-period-overrides/:overrideId', 'ZONE.DECLARATION_OVERRIDE_DELETED', 'ZONE', 'Suppression d’une exception de période de déclaration', {target: {type: 'DECLARATION_OVERRIDE', param: 'overrideId'}}),
  action('POST', '/zones/:zoneId/monitoring-stations', 'ZONE.MONITORING_STATION_ADDED', 'ZONE', 'Ajout d’une station de suivi à une zone', {target: {type: 'ZONE', param: 'zoneId'}}),
  action('PATCH', '/zones/:zoneId/monitoring-stations/:associationId', 'ZONE.MONITORING_STATION_UPDATED', 'ZONE', 'Modification d’une station de suivi d’une zone', {target: {type: 'ZONE_MONITORING_STATION', param: 'associationId'}}),
  action('DELETE', '/zones/:zoneId/monitoring-stations/:associationId', 'ZONE.MONITORING_STATION_REMOVED', 'ZONE', 'Retrait d’une station de suivi d’une zone', {target: {type: 'ZONE_MONITORING_STATION', param: 'associationId'}}),
  action('POST', '/zones/:zoneId/instructeurs', 'ZONE.AGENT_ADDED', 'ZONE', 'Ajout d’un agent à une zone', {target: {type: 'ZONE', param: 'zoneId'}, subject: {body: 'userId'}}),
  action('PATCH', '/zones/:zoneId/instructeurs/:instructorUserId', 'ZONE.AGENT_PERMISSIONS_UPDATED', 'ZONE', 'Modification des droits d’un agent', {target: {type: 'ZONE', param: 'zoneId'}, subject: {param: 'instructorUserId'}}),
  action('DELETE', '/zones/:zoneId/instructeurs/:instructorUserId', 'ZONE.AGENT_REMOVED', 'ZONE', 'Retrait d’un agent d’une zone', {target: {type: 'ZONE', param: 'zoneId'}, subject: {param: 'instructorUserId'}}),
  action('POST', '/zones/:zoneId/instructeurs/:instructorUserId/notifications/account-creation', 'ZONE.AGENT_ACCOUNT_NOTIFICATION_SENT', 'ZONE', 'Envoi d’une invitation à un agent', {target: {type: 'ZONE', param: 'zoneId'}, subject: {param: 'instructorUserId'}}),
  action('POST', '/zones/:zoneId/instructeurs/:instructorUserId/notifications/zone-attachment', 'ZONE.AGENT_ATTACHMENT_NOTIFICATION_SENT', 'ZONE', 'Notification de rattachement d’un agent à une zone', {target: {type: 'ZONE', param: 'zoneId'}, subject: {param: 'instructorUserId'}}),

  action('GET', '/documents/:documentId', 'DOCUMENT.FILE_ACCESSED', 'DOCUMENT', 'Accès à un document', {target: {type: 'DOCUMENT', param: 'documentId'}, requireUuidParams: ['documentId']}),
  action('POST', '/preleveurs/:declarantId/documents', 'DOCUMENT.CREATED', 'DOCUMENT', 'Ajout d’un document', {subject: {param: 'declarantId'}, target: {type: 'DECLARANT', param: 'declarantId'}}),
  action('PUT', '/documents/:documentId', 'DOCUMENT.UPDATED', 'DOCUMENT', 'Modification d’un document', {target: {type: 'DOCUMENT', param: 'documentId'}}),
  action('DELETE', '/documents/:documentId', 'DOCUMENT.DELETED', 'DOCUMENT', 'Suppression d’un document', {target: {type: 'DOCUMENT', param: 'documentId'}}),
  action('POST', '/preleveurs/:declarantId/regles', 'RULE.CREATED', 'DOCUMENT', 'Ajout d’une règle', {subject: {param: 'declarantId'}, target: {type: 'DECLARANT', param: 'declarantId'}}),
  action('PUT', '/regles/:regleId', 'RULE.UPDATED', 'DOCUMENT', 'Modification d’une règle', {target: {type: 'RULE', param: 'regleId'}}),
  action('DELETE', '/regles/:regleId', 'RULE.DELETED', 'DOCUMENT', 'Suppression d’une règle', {target: {type: 'RULE', param: 'regleId'}}),

  action('POST', '/admin/service-accounts', 'SERVICE_ACCOUNT.CREATED', 'SERVICE_ACCOUNT', 'Création d’un compte de service', {target: {type: 'SERVICE_ACCOUNT'}}),
  action('PUT', '/admin/service-accounts/:serviceAccountId', 'SERVICE_ACCOUNT.UPDATED', 'SERVICE_ACCOUNT', 'Modification d’un compte de service', {target: {type: 'SERVICE_ACCOUNT', param: 'serviceAccountId'}}),
  action('DELETE', '/admin/service-accounts/:serviceAccountId', 'SERVICE_ACCOUNT.DISABLED', 'SERVICE_ACCOUNT', 'Désactivation d’un compte de service', {target: {type: 'SERVICE_ACCOUNT', param: 'serviceAccountId'}}),
  action('POST', '/admin/service-accounts/:serviceAccountId/restore', 'SERVICE_ACCOUNT.RESTORED', 'SERVICE_ACCOUNT', 'Réactivation d’un compte de service', {target: {type: 'SERVICE_ACCOUNT', param: 'serviceAccountId'}}),
  action('POST', '/admin/service-accounts/:serviceAccountId/credentials', 'SERVICE_ACCOUNT.CREDENTIAL_CREATED', 'SERVICE_ACCOUNT', 'Création d’un identifiant de compte de service', {target: {type: 'SERVICE_ACCOUNT', param: 'serviceAccountId'}}),
  action('DELETE', '/admin/service-accounts/:serviceAccountId/credentials/:credentialId', 'SERVICE_ACCOUNT.CREDENTIAL_REVOKED', 'SERVICE_ACCOUNT', 'Révocation d’un identifiant de compte de service', {target: {type: 'SERVICE_ACCOUNT_CREDENTIAL', param: 'credentialId'}}),
  action('POST', '/admin/service-accounts/:serviceAccountId/declarants', 'SERVICE_ACCOUNT.DECLARANT_ADDED', 'SERVICE_ACCOUNT', 'Autorisation d’un déclarant pour un compte de service', {target: {type: 'SERVICE_ACCOUNT', param: 'serviceAccountId'}, subject: {body: 'declarantUserId'}}),
  action('PUT', '/admin/service-accounts/:serviceAccountId/declarants/:linkId', 'SERVICE_ACCOUNT.DECLARANT_LINK_UPDATED', 'SERVICE_ACCOUNT', 'Modification d’une autorisation de compte de service', {target: {type: 'SERVICE_ACCOUNT_DECLARANT', param: 'linkId'}}),
  action('DELETE', '/admin/service-accounts/:serviceAccountId/declarants/:linkId', 'SERVICE_ACCOUNT.DECLARANT_REMOVED', 'SERVICE_ACCOUNT', 'Retrait d’un déclarant d’un compte de service', {target: {type: 'SERVICE_ACCOUNT_DECLARANT', param: 'linkId'}}),

  action('PUT', '/admin/declaration-notifications/settings/:notificationType/:periodType', 'NOTIFICATION.SETTING_UPDATED', 'NOTIFICATION', 'Modification d’un paramètre de notification', {target: {type: 'NOTIFICATION_SETTING'}, safeParamFields: ['notificationType', 'periodType']}),
  action('POST', '/admin/declaration-notifications/send-now', 'NOTIFICATION.SENT_MANUALLY', 'NOTIFICATION', 'Envoi manuel de notifications'),
  action('POST', '/admin/declaration-notifications/runs/:runId/retry-failures', 'NOTIFICATION.FAILURES_RETRIED', 'NOTIFICATION', 'Nouvelle tentative des notifications en échec', {target: {type: 'NOTIFICATION_RUN', param: 'runId'}}),

  action('POST', '/admin/declaration-types', 'CONFIGURATION.DECLARATION_TYPE_CREATED', 'CONFIGURATION', 'Création d’un type de déclaration', {target: {type: 'DECLARATION_TYPE'}}),
  action('PUT', '/admin/declaration-types/:declarationTypeId', 'CONFIGURATION.DECLARATION_TYPE_UPDATED', 'CONFIGURATION', 'Modification d’un type de déclaration', {target: {type: 'DECLARATION_TYPE', param: 'declarationTypeId'}}),
  action('DELETE', '/admin/declaration-types/:declarationTypeId', 'CONFIGURATION.DECLARATION_TYPE_DISABLED', 'CONFIGURATION', 'Désactivation d’un type de déclaration', {target: {type: 'DECLARATION_TYPE', param: 'declarationTypeId'}}),
  action('POST', '/admin/declaration-types/:declarationTypeId/restore', 'CONFIGURATION.DECLARATION_TYPE_RESTORED', 'CONFIGURATION', 'Réactivation d’un type de déclaration', {target: {type: 'DECLARATION_TYPE', param: 'declarationTypeId'}}),

  action('GET', '/admin/audit-events', 'AUDIT.LOG_VIEWED', 'AUDIT', 'Consultation du journal d’audit', {
    safeQueryFields: ['page', 'pageSize', 'from', 'to', 'period', 'actionTypes', 'outcomes']
  })
])

const compiledActions = AUDIT_ACTIONS.map(entry => ({
  ...entry,
  matcher: match(entry.path, {decode: decodeURIComponent, end: true})
}))

function hasRequiredUuidParams(entry, params) {
  return (entry.requireUuidParams ?? []).every(name => UUID_PATTERN.test(params[name] ?? ''))
}

export function findAuditAction(method, path) {
  for (const entry of compiledActions) {
    if (entry.method !== method.toUpperCase()) {
      continue
    }

    const result = entry.matcher(path)

    if (result && hasRequiredUuidParams(entry, result.params)) {
      return {
        ...entry,
        matcher: undefined,
        params: result.params
      }
    }
  }

  return null
}

export function getAuditActionOptions() {
  return Object.entries(AUDIT_ACTION_CATEGORIES).map(([category, label]) => ({
    category,
    label,
    actions: AUDIT_ACTIONS
      .filter(actionEntry => actionEntry.category === category)
      .map(actionEntry => ({
        value: actionEntry.type,
        label: actionEntry.label
      }))
  }))
}

/* eslint-enable max-params, @stylistic/max-len */
