/* eslint-disable @stylistic/array-element-newline -- Les listes de champs restent groupées par domaine. */

import {getExploitationSecondaryUsages} from '../services/exploitation-usages.js'

const REDACTED_FIELDS = new Set([
  'abandonReason',
  'comment',
  'connectorParameters',
  'content',
  'description',
  'error',
  'errorMessage',
  'html',
  'internalComment',
  'locationDescription',
  'metadata',
  'password',
  'reason',
  'secret',
  'secretHash',
  'storageKey',
  'token',
  'tokenHash'
])

const IGNORED_FIELDS = new Set([
  '_count',
  'accountCreationMailSentAt',
  'authVersion',
  'createdAt',
  'lastDeclarationAt',
  'lastLoginAt',
  'lastUsedAt',
  'updatedAt'
])

const ENTITY_FIELDS = Object.freeze({
  POINT: [
    'name', 'usageName', 'waterBodyType', 'flowType', 'pointKind', 'nature',
    'withdrawalType', 'commissioningDate', 'waterAgencyInternalIdentifier',
    'isReferencePoint', 'isWaterBodyConnectedToStream',
    'isWaterBodyConnectedToGroundwater', 'otherNames', 'names', 'identifiers',
    'depth', 'isZre', 'isBiologicalReservoir', 'streamName',
    'locationDescription', 'geometryPrecision', 'communeCode', 'communeName',
    'watershed', 'underWatershed', 'resourceName', 'managementUnit',
    'managementSubUnit', 'aquiferName', 'sourceId', 'codeEUMasseDEau',
    'codePTP', 'codeOPR', 'codeBDLISA', 'codeBSS', 'codeAIOT',
    'codeBDCarthage', 'codeBDTopage', 'codeSISPEA', 'codeBNPE', 'codeMESO',
    'codeMEContinentalesBV', 'codeSISEAUX', 'codeINSEE', 'codeROE',
    'coordinates'
  ],
  EXPLOITATION: [
    'declarantUserId', 'pointPrelevementId', 'status', 'startDate', 'endDate',
    'usage', 'secondaryUsages', 'pointPrelevementNameAliases', 'sourceId',
    'mostRecentAvailableDate', 'collecteurUserIds', 'connectors'
  ],
  DECLARANT: [
    'email', 'firstName', 'lastName', 'declarantType', 'declarantRole', 'preleveurType',
    'quickDeclarationEnabled', 'declarationNotificationsEnabled', 'jobTitle',
    'socialReason', 'civility', 'addressLine1', 'addressLine2', 'poBox',
    'postalCode', 'city', 'siret', 'phoneNumber', 'sourceId', 'deletedAt'
  ],
  USER_PROFILE: [
    'firstName', 'lastName', 'jobTitle', 'socialReason', 'civility',
    'addressLine1', 'addressLine2', 'poBox', 'postalCode', 'city', 'phoneNumber'
  ],
  DECLARANT_ZONES: ['declarantUserId', 'zones'],
  ZONE: ['code', 'type', 'name'],
  ZONE_DECLARATION_SETTINGS: ['zoneId', 'defaultPeriodType'],
  DECLARATION_OVERRIDE: ['zoneId', 'periodType', 'reason', 'label', 'startDate', 'endDate'],
  ZONE_MONITORING_STATION: [
    'zoneId', 'monitoringStationId', 'enabled', 'label', 'stationCode',
    'siteCode', 'type', 'provider'
  ],
  ZONE_AGENT_ASSIGNMENT: [
    'zoneId', 'instructorUserId', 'isAdmin', 'startDate', 'endDate', 'permissions'
  ],
  DOCUMENT: [
    'declarantUserId', 'declarantPointPrelevementIds', 'title', 'reference',
    'nature', 'signatureDate', 'validityEndDate', 'filename', 'mimeType', 'size',
    'deletedAt'
  ],
  RULE: [
    'declarantUserId', 'documentId', 'parameter', 'frequency', 'unit', 'value',
    'constraint', 'validityStartDate', 'validityEndDate',
    'annualPeriodStartDate', 'annualPeriodEndDate', 'exploitationIds', 'deletedAt'
  ],
  SERVICE_ACCOUNT: ['name', 'isActive', 'sourceId', 'deletedAt'],
  SERVICE_ACCOUNT_CREDENTIAL: [
    'serviceAccountId', 'keyId', 'name', 'expiresAt', 'revokedAt'
  ],
  SERVICE_ACCOUNT_DECLARANT: [
    'serviceAccountId', 'declarantUserId', 'startDate', 'endDate'
  ],
  DECLARATION_TYPE: ['code', 'name', 'version', 'isAvailable'],
  DECLARANT_DECLARATION_TYPE: [
    'declarantUserId', 'declarationTypeId', 'startDate', 'endDate'
  ],
  NOTIFICATION_SETTING: ['notificationType', 'periodType', 'enabled'],
  EMAIL_ALIAS: ['userId', 'email'],
  DECLARATION: [
    'declarantUserId', 'createdByDeclarantUserId', 'dataSourceType',
    'waterWithdrawalType', 'processingStatus', 'deletedAt'
  ],
  DATA_EXPORT: ['requestedByUserId', 'requestedByRole', 'status', 'filters', 'fileName', 'rowCount'],
  CHUNK: [
    'sourceId', 'pointPrelevementId', 'preleveurUserId', 'submittedByDeclarantUserId',
    'collecteurUserId', 'status', 'flowType', 'instructionStatus'
  ]
})

function profile(operation, entityType, options = {}) {
  return {operation, entityType, ...options}
}

export const AUDIT_MUTATION_PROFILES = Object.freeze({
  'POINT.CREATED': profile('CREATE', 'POINT'),
  'POINT.UPDATED': profile('UPDATE', 'POINT', {requestResource: 'point', idParam: 'pointId'}),
  'POINT.DELETED': profile('DELETE', 'POINT', {requestResource: 'point', idParam: 'pointId'}),
  'POINT.USAGE_NAME_UPDATED': profile('UPDATE', 'POINT', {requestResource: 'point', idParam: 'pointId'}),
  'POINT.CREATED_IN_ZONE': profile('CREATE', 'POINT'),
  'POINT.UPDATED_IN_ZONE': profile('UPDATE', 'POINT', {idParam: 'pointId'}),
  'POINT.DELETED_FROM_ZONE': profile('DELETE', 'POINT', {idParam: 'pointId'}),

  'EXPLOITATION.CREATED': profile('CREATE', 'EXPLOITATION'),
  'EXPLOITATION.UPDATED': profile('UPDATE', 'EXPLOITATION', {requestResource: 'exploitation', idParam: 'exploitationId'}),
  'EXPLOITATION.DELETED': profile('DELETE', 'EXPLOITATION', {requestResource: 'exploitation', idParam: 'exploitationId'}),
  'EXPLOITATION.CREATED_IN_ZONE': profile('CREATE', 'EXPLOITATION'),
  'EXPLOITATION.UPDATED_IN_ZONE': profile('UPDATE', 'EXPLOITATION', {idParam: 'exploitationId'}),
  'EXPLOITATION.DELETED_FROM_ZONE': profile('DELETE', 'EXPLOITATION', {idParam: 'exploitationId'}),

  'DECLARANT.CREATED': profile('CREATE', 'DECLARANT'),
  'DECLARANT.UPDATED': profile('UPDATE', 'DECLARANT', {requestResource: 'declarant', idParam: 'declarantId'}),
  'DECLARANT.DELETED': profile('DELETE', 'DECLARANT', {requestResource: 'declarant', idParam: 'declarantId'}),
  'DECLARANT.ZONES_UPDATED': profile('UPDATE', 'DECLARANT_ZONES', {idParam: 'declarantId'}),
  'DECLARANT.DECLARATION_TYPE_ADDED': profile('CREATE', 'DECLARANT_DECLARATION_TYPE'),
  'DECLARANT.DECLARATION_TYPE_UPDATED': profile('UPDATE', 'DECLARANT_DECLARATION_TYPE', {idParam: 'linkId'}),
  'DECLARANT.DECLARATION_TYPE_REMOVED': profile('DELETE', 'DECLARANT_DECLARATION_TYPE', {idParam: 'linkId'}),
  'DECLARANT.EMAIL_ALIAS_ADDED': profile('CREATE', 'EMAIL_ALIAS'),
  'DECLARANT.EMAIL_ALIAS_REMOVED': profile('DELETE', 'EMAIL_ALIAS', {idParam: 'emailAliasId'}),
  'DECLARANT.EMAIL_ALIAS_ADDED_BY_AGENT': profile('CREATE', 'EMAIL_ALIAS'),
  'DECLARANT.EMAIL_ALIAS_REMOVED_BY_AGENT': profile('DELETE', 'EMAIL_ALIAS', {idParam: 'emailAliasId'}),
  'ACCOUNT.PROFILE_UPDATED': profile('UPDATE', 'USER_PROFILE'),
  'ACCOUNT.EMAIL_ALIAS_REMOVED': profile('DELETE', 'EMAIL_ALIAS', {idParam: 'emailAliasId'}),

  'ZONE.DECLARATION_SETTINGS_UPDATED': profile('UPDATE', 'ZONE_DECLARATION_SETTINGS', {idParam: 'zoneId'}),
  'ZONE.DECLARATION_OVERRIDE_CREATED': profile('CREATE', 'DECLARATION_OVERRIDE'),
  'ZONE.DECLARATION_OVERRIDE_UPDATED': profile('UPDATE', 'DECLARATION_OVERRIDE', {idParam: 'overrideId'}),
  'ZONE.DECLARATION_OVERRIDE_DELETED': profile('DELETE', 'DECLARATION_OVERRIDE', {idParam: 'overrideId'}),
  'ZONE.MONITORING_STATION_ADDED': profile('CREATE', 'ZONE_MONITORING_STATION'),
  'ZONE.MONITORING_STATION_UPDATED': profile('UPDATE', 'ZONE_MONITORING_STATION', {idParam: 'associationId'}),
  'ZONE.MONITORING_STATION_REMOVED': profile('DELETE', 'ZONE_MONITORING_STATION', {idParam: 'associationId'}),
  'ZONE.AGENT_ADDED': profile('CREATE', 'ZONE_AGENT_ASSIGNMENT'),
  'ZONE.AGENT_PERMISSIONS_UPDATED': profile('UPDATE', 'ZONE_AGENT_ASSIGNMENT'),
  'ZONE.AGENT_REMOVED': profile('DELETE', 'ZONE_AGENT_ASSIGNMENT'),

  'DOCUMENT.CREATED': profile('CREATE', 'DOCUMENT'),
  'DOCUMENT.UPDATED': profile('UPDATE', 'DOCUMENT', {requestResource: 'document', idParam: 'documentId'}),
  'DOCUMENT.DELETED': profile('DELETE', 'DOCUMENT', {requestResource: 'document', idParam: 'documentId'}),
  'RULE.CREATED': profile('CREATE', 'RULE'),
  'RULE.UPDATED': profile('UPDATE', 'RULE', {requestResource: 'regle', idParam: 'regleId'}),
  'RULE.DELETED': profile('DELETE', 'RULE', {requestResource: 'regle', idParam: 'regleId'}),

  'SERVICE_ACCOUNT.CREATED': profile('CREATE', 'SERVICE_ACCOUNT'),
  'SERVICE_ACCOUNT.UPDATED': profile('UPDATE', 'SERVICE_ACCOUNT', {idParam: 'serviceAccountId'}),
  'SERVICE_ACCOUNT.DISABLED': profile('UPDATE', 'SERVICE_ACCOUNT', {idParam: 'serviceAccountId'}),
  'SERVICE_ACCOUNT.RESTORED': profile('UPDATE', 'SERVICE_ACCOUNT', {idParam: 'serviceAccountId'}),
  'SERVICE_ACCOUNT.CREDENTIAL_CREATED': profile('CREATE', 'SERVICE_ACCOUNT_CREDENTIAL'),
  'SERVICE_ACCOUNT.CREDENTIAL_REVOKED': profile('DELETE', 'SERVICE_ACCOUNT_CREDENTIAL', {idParam: 'credentialId'}),
  'SERVICE_ACCOUNT.DECLARANT_ADDED': profile('CREATE', 'SERVICE_ACCOUNT_DECLARANT'),
  'SERVICE_ACCOUNT.DECLARANT_LINK_UPDATED': profile('UPDATE', 'SERVICE_ACCOUNT_DECLARANT', {idParam: 'linkId'}),
  'SERVICE_ACCOUNT.DECLARANT_REMOVED': profile('DELETE', 'SERVICE_ACCOUNT_DECLARANT', {idParam: 'linkId'}),

  'CONFIGURATION.DECLARATION_TYPE_CREATED': profile('CREATE', 'DECLARATION_TYPE'),
  'CONFIGURATION.DECLARATION_TYPE_UPDATED': profile('UPDATE', 'DECLARATION_TYPE', {idParam: 'declarationTypeId'}),
  'CONFIGURATION.DECLARATION_TYPE_DISABLED': profile('UPDATE', 'DECLARATION_TYPE', {idParam: 'declarationTypeId'}),
  'CONFIGURATION.DECLARATION_TYPE_RESTORED': profile('UPDATE', 'DECLARATION_TYPE', {idParam: 'declarationTypeId'}),
  'NOTIFICATION.SETTING_UPDATED': profile('UPDATE', 'NOTIFICATION_SETTING'),

  'DECLARATION.FILE_CREATED': profile('CREATE', 'DECLARATION'),
  'DECLARATION.QUICK_CREATED': profile('CREATE', 'DECLARATION'),
  'DECLARATION.DELETED': profile('DELETE', 'DECLARATION', {idParam: 'declarationId'}),
  'DECLARATION.CHUNK_RECONCILED': profile('UPDATE', 'CHUNK', {idParam: 'chunkId'}),
  'DECLARATION.CHUNK_INSTRUCTED': profile('UPDATE', 'CHUNK', {idParam: 'chunkId'}),
  'EXPORT.CREATED': profile('CREATE', 'DATA_EXPORT'),
  'EXPORT.DELETED': profile('DELETE', 'DATA_EXPORT', {idParam: 'exportId'})
})

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
}

function normalizeValue(value, depth = 0) {
  if (value === undefined) {
    return undefined
  }

  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return typeof value === 'string' ? value.slice(0, 2000) : value
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (Array.isArray(value)) {
    return value.slice(0, 100)
      .map(item => normalizeValue(item, depth + 1))
      .filter(item => item !== undefined)
  }

  if (!isPlainObject(value) || depth >= 3) {
    return String(value).slice(0, 2000)
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !IGNORED_FIELDS.has(key) && !REDACTED_FIELDS.has(key))
      .slice(0, 100)
      .map(([key, item]) => [key, normalizeValue(item, depth + 1)])
      .filter(([, item]) => item !== undefined)
  )
}

function flattenEntity(entityType, value) {
  if (!isPlainObject(value)) {
    return value
  }

  if (entityType === 'DECLARANT') {
    return {
      ...value.declarant,
      ...value.user,
      ...value
    }
  }

  if (entityType === 'USER_PROFILE') {
    return {
      ...value.declarant,
      ...value.instructor,
      ...value.user,
      ...value
    }
  }

  if (entityType === 'EXPLOITATION') {
    const summarizeUsage = usage => usage
      ? {
        id: usage.id ?? null,
        code: usage.code ?? null,
        label: usage.label ?? null
      }
      : null

    return {
      ...value,
      usageId: value.usageId ?? value.usage?.id,
      usage: summarizeUsage(value.usage) ?? value.usageId ?? null,
      secondaryUsages: getExploitationSecondaryUsages(value)
        .map(summarizeUsage)
        .sort((left, right) => String(left.code ?? left.id).localeCompare(
          String(right.code ?? right.id),
          'fr'
        )),
      collecteurUserIds: (value.collecteurs ?? [])
        .map(item => item.collecteurUserId ?? item.collecteur?.userId ?? item.collecteur?.id)
        .filter(Boolean)
        .sort(),
      connectors: (value.connectors ?? [])
        .map(item => ({connectorType: item.connectorType, rate: item.rate}))
        .sort((left, right) => String(left.connectorType).localeCompare(String(right.connectorType)))
    }
  }

  if (entityType === 'RULE') {
    return {
      ...value,
      exploitationIds: (value.exploitationIds ?? value.exploitations ?? [])
        .map(item => typeof item === 'string'
          ? item
          : item.declarantPointPrelevementId ?? item.declarantPointPrelevement?.id ?? item.id)
        .filter(Boolean)
        .sort()
    }
  }

  if (entityType === 'DOCUMENT') {
    return {
      ...value,
      declarantPointPrelevementIds: [...new Set([
        value.declarantPointPrelevementId,
        ...(value.declarantPointPrelevementIds ?? []),
        ...(value.exploitations ?? []).map(item =>
          item.declarantPointPrelevementId ?? item.declarantPointPrelevement?.id ?? item.id)
      ].filter(Boolean))].sort()
    }
  }

  if (entityType === 'ZONE_AGENT_ASSIGNMENT') {
    return {
      ...value,
      instructorUserId: value.instructorUserId ?? value.userId ?? value.instructor?.userId,
      permissions: (value.permissions ?? [])
        .map(item => typeof item === 'string' ? item : item.permission)
        .filter(Boolean)
        .sort()
    }
  }

  if (entityType === 'ZONE_MONITORING_STATION') {
    return {
      ...value.monitoringStation,
      ...value,
      monitoringStationId: value.monitoringStationId ?? value.monitoringStation?.id
    }
  }

  return value
}

function sanitizeSnapshot(entityType, value) {
  const flattened = flattenEntity(entityType, value)
  const fields = ENTITY_FIELDS[entityType]

  if (!isPlainObject(flattened)) {
    return null
  }

  if (!fields) {
    return null
  }

  return Object.fromEntries(
    fields
      .filter(field => !REDACTED_FIELDS.has(field)
        && Object.hasOwn(flattened, field)
        && flattened[field] !== undefined)
      .map(field => [field, normalizeValue(flattened[field])])
  )
}

function getResponseCandidates(body) {
  return [
    body?.data?.declaration,
    body?.declaration,
    body?.data,
    body
  ].filter(isPlainObject)
}

function extractResponseEntity(body, entityType) {
  const candidates = getResponseCandidates(body)
  const candidate = candidates.find(item => item.id || item.userId)
    ?? candidates[0]

  return candidate ? flattenEntity(entityType, candidate) : null
}

function getRequestParams(request) {
  return {
    ...request.auditAction?.params,
    ...request.params
  }
}

function getEntityId(profileValue, request, after, before) {
  const params = getRequestParams(request)

  if (profileValue.entityType === 'ZONE_AGENT_ASSIGNMENT') {
    const {zoneId} = params
    const instructorUserId = params.instructorUserId
      ?? request.body?.instructorUserId
      ?? after?.instructorUserId
      ?? before?.instructorUserId

    return zoneId && instructorUserId ? `${zoneId}:${instructorUserId}` : null
  }

  if (profileValue.entityType === 'NOTIFICATION_SETTING') {
    const {notificationType, periodType} = params
    return notificationType && periodType ? `${notificationType}:${periodType}` : null
  }

  return after?.id
    ?? after?.userId
    ?? before?.id
    ?? before?.userId
    ?? (profileValue.idParam ? params[profileValue.idParam] : null)
}

async function loadMutationEntity(client, entityType, entityId, request) {
  if (!entityId && !['NOTIFICATION_SETTING', 'ZONE_AGENT_ASSIGNMENT'].includes(entityType)) {
    return null
  }

  switch (entityType) {
    case 'POINT': {
      return client.pointPrelevement.findUnique({
        where: {id: entityId},
        include: {zones: true}
      })
    }

    case 'EXPLOITATION': {
      return client.declarantPointPrelevement.findUnique({
        where: {id: entityId},
        include: {
          usage: true,
          secondaryUsageLinks: {
            include: {usage: true},
            orderBy: {usageId: 'asc'}
          },
          collecteurs: true,
          connectors: true,
          pointPrelevement: {include: {zones: true}}
        }
      })
    }

    case 'DECLARANT': {
      return client.user.findUnique({
        where: {id: entityId},
        include: {declarant: true}
      })
    }

    case 'ZONE_DECLARATION_SETTINGS': {
      return client.zoneDeclarationSettings.findUnique({where: {zoneId: entityId}})
    }

    case 'DECLARATION_OVERRIDE': {
      return client.zoneDeclarationPeriodOverride.findUnique({where: {id: entityId}})
    }

    case 'ZONE_MONITORING_STATION': {
      return client.zoneMonitoringStation.findUnique({
        where: {id: entityId},
        include: {monitoringStation: true}
      })
    }

    case 'ZONE_AGENT_ASSIGNMENT': {
      const params = getRequestParams(request)
      const {zoneId} = params
      const instructorUserId = params.instructorUserId
        ?? request.body?.instructorUserId

      if (!zoneId || !instructorUserId) {
        return null
      }

      return client.instructorZone.findUnique({
        where: {instructorUserId_zoneId: {instructorUserId, zoneId}},
        include: {permissions: true}
      })
    }

    case 'DOCUMENT': {
      return client.resourceDocument.findUnique({
        where: {id: entityId},
        include: {exploitations: true}
      })
    }

    case 'RULE': {
      return client.resourceRule.findUnique({
        where: {id: entityId},
        include: {exploitations: true}
      })
    }

    case 'SERVICE_ACCOUNT': {
      return client.serviceAccount.findUnique({where: {id: entityId}})
    }

    case 'SERVICE_ACCOUNT_CREDENTIAL': {
      return client.serviceAccountCredential.findUnique({where: {id: entityId}})
    }

    case 'SERVICE_ACCOUNT_DECLARANT': {
      return client.serviceAccountDeclarant.findUnique({where: {id: entityId}})
    }

    case 'DECLARATION_TYPE': {
      return client.declarationType.findUnique({where: {id: entityId}})
    }

    case 'DECLARANT_DECLARATION_TYPE': {
      return client.declarantDeclarationType.findUnique({where: {id: entityId}})
    }

    case 'NOTIFICATION_SETTING': {
      const {notificationType, periodType} = getRequestParams(request)

      if (!notificationType || !periodType) {
        return null
      }

      return client.declarationNotificationSetting.findUnique({
        where: {notificationType_periodType: {notificationType, periodType}}
      })
    }

    case 'EMAIL_ALIAS': {
      return client.userEmailAlias.findUnique({where: {id: entityId}})
    }

    case 'DECLARATION': {
      return client.declaration.findUnique({where: {id: entityId}})
    }

    case 'DATA_EXPORT': {
      return client.dataExport.findUnique({where: {id: entityId}})
    }

    case 'CHUNK': {
      return client.chunk.findUnique({where: {id: entityId}})
    }

    default: {
      return null
    }
  }
}

function getProfileEntityId(profileValue, request) {
  const params = getRequestParams(request)

  if (profileValue.entityType === 'ZONE_AGENT_ASSIGNMENT') {
    const {zoneId, instructorUserId} = params
    const userId = instructorUserId ?? request.body?.instructorUserId
    return zoneId && userId ? `${zoneId}:${userId}` : null
  }

  if (profileValue.entityType === 'NOTIFICATION_SETTING') {
    const {notificationType, periodType} = params
    return notificationType && periodType ? `${notificationType}:${periodType}` : null
  }

  if (profileValue.entityType === 'ZONE_DECLARATION_SETTINGS') {
    return params.zoneId ?? null
  }

  return profileValue.idParam ? params[profileValue.idParam] : null
}

export async function captureInitialAuditMutation(request, auditAction, client) {
  const profileValue = AUDIT_MUTATION_PROFILES[auditAction.type]

  if (!profileValue || profileValue.operation === 'CREATE') {
    return
  }

  const entityId = getProfileEntityId(profileValue, request)
  const snapshot = await loadMutationEntity(
    client,
    profileValue.entityType,
    profileValue.entityType === 'ZONE_DECLARATION_SETTINGS'
      ? getRequestParams(request).zoneId
      : entityId,
    request
  )

  request.auditContext ||= {metadata: {}}
  request.auditContext.mutationBefore = snapshot
}

export async function captureFinalAuditMutation(request, auditAction, client) {
  const profileValue = AUDIT_MUTATION_PROFILES[auditAction.type]

  if (!profileValue || profileValue.operation === 'DELETE') {
    return
  }

  const responseEntity = extractResponseEntity(
    request.auditContext?.responseBody,
    profileValue.entityType
  )
  const entityId = getEntityId(
    profileValue,
    request,
    responseEntity,
    request.auditContext?.mutationBefore
  )

  if (!entityId) {
    return
  }

  request.auditContext.mutationAfter = await loadMutationEntity(
    client,
    profileValue.entityType,
    profileValue.entityType === 'ZONE_DECLARATION_SETTINGS'
      ? getRequestParams(request).zoneId
      : entityId,
    request
  )
}

function getEntityLabel(entityType, after, before, entityId) {
  const value = flattenEntity(entityType, after ?? before ?? {})

  if (entityType === 'POINT') {
    return value.usageName || value.name || entityId
  }

  if (entityType === 'DECLARANT') {
    return value.socialReason
      || [value.firstName, value.lastName].filter(Boolean).join(' ')
      || value.email
      || entityId
  }

  if (entityType === 'USER_PROFILE') {
    return [value.firstName, value.lastName].filter(Boolean).join(' ')
      || value.socialReason
      || entityId
  }

  if (entityType === 'EXPLOITATION') {
    return value.pointPrelevement?.usageName || value.pointPrelevement?.name || entityId
  }

  return value.label || value.name || value.title || value.email || value.code || entityId
}

function comparable(value) {
  return JSON.stringify(value)
}

function getChangedSnapshots(operation, before, after) {
  if (operation === 'CREATE') {
    return {
      before: null,
      after,
      changedFields: Object.keys(after ?? {}).sort()
    }
  }

  if (operation === 'DELETE') {
    return {
      before,
      after: null,
      changedFields: Object.keys(before ?? {}).sort()
    }
  }

  const fields = [...new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {})
  ])].filter(field => comparable(before?.[field]) !== comparable(after?.[field])).sort()

  return {
    before: Object.fromEntries(fields.map(field => [field, before?.[field] ?? null])),
    after: Object.fromEntries(fields.map(field => [field, after?.[field] ?? null])),
    changedFields: fields
  }
}

function getRedactedChangedFields(request) {
  return Object.keys(request.body ?? {})
    .filter(field => REDACTED_FIELDS.has(field))
    .sort()
}

function hasRequiredSnapshots(operation, before, after) {
  if (operation === 'CREATE') {
    return after !== null
  }

  if (operation === 'DELETE') {
    return before !== null
  }

  return before !== null && after !== null
}

function scope(type, id, label) {
  return id ? {resourceType: type, resourceId: String(id), resourceLabel: label || null} : null
}

function getMutationScopes(request, entityType, entityId, entityLabel, after, before) {
  const value = after ?? before ?? {}
  const params = getRequestParams(request)
  const scopes = [scope(entityType, entityId, entityLabel)]
  const snapshotValues = [
    value,
    request.auditContext?.mutationAfter,
    request.auditContext?.mutationBefore
  ].filter(isPlainObject)
  const zoneIds = new Set([
    params.zoneId,
    ...snapshotValues.flatMap(item => [
      item.zoneId,
      ...(item.zoneIds ?? []),
      ...(item.zones ?? []).map(zone => zone.zoneId ?? zone.id),
      ...(item.pointPrelevement?.zones ?? []).map(zone => zone.zoneId ?? zone.id)
    ])
  ].filter(Boolean))

  for (const zoneId of zoneIds) {
    scopes.push(scope('ZONE', zoneId))
  }

  const declarantId = params.declarantId
    ?? request.body?.declarantUserId
    ?? value.declarantUserId
    ?? value.declarant?.userId
    ?? value.declarant?.id
    ?? (entityType === 'EMAIL_ALIAS' ? value.userId : null)
  const pointId = params.pointId
    ?? request.body?.pointPrelevementId
    ?? value.pointPrelevementId
    ?? value.pointPrelevement?.id
  const exploitationId = params.exploitationId
    ?? value.declarantPointPrelevementId
  const exploitationIds = new Set([
    exploitationId,
    ...(value.exploitationIds ?? []),
    ...(value.exploitations ?? []).map(item =>
      item.declarantPointPrelevementId ?? item.declarantPointPrelevement?.id ?? item.id)
  ].filter(Boolean))

  scopes.push(
    scope('DECLARANT', declarantId),
    scope('POINT', pointId)
  )

  for (const id of exploitationIds) {
    scopes.push(scope('EXPLOITATION', id))
  }

  const uniqueScopes = new Map()

  for (const item of scopes.filter(Boolean)) {
    const key = `${item.resourceType}:${item.resourceId}`

    if (!uniqueScopes.has(key)) {
      uniqueScopes.set(key, item)
    }
  }

  return [...uniqueScopes.values()]
}

export function stageAuditMutation(request, mutation) {
  if (!request.auditEventId || !mutation) {
    return
  }

  request.auditContext ||= {metadata: {}}
  request.auditContext.mutations ||= []
  request.auditContext.mutations.push(mutation)
}

export function captureAuditResponseBody(request, body) {
  if (!request.auditAction || !AUDIT_MUTATION_PROFILES[request.auditAction.type]) {
    return
  }

  request.auditContext ||= {metadata: {}}
  request.auditContext.responseBody = body
}

function buildMutation(request, auditAction, mutation, inferred = false) {
  const profileValue = inferred
    ? AUDIT_MUTATION_PROFILES[auditAction.type]
    : profile(mutation.operation, mutation.entityType, mutation)
  const rawBefore = mutation.before
    ?? request.auditContext?.mutationBefore
    ?? (profileValue.requestResource ? request[profileValue.requestResource] : null)
  const rawAfter = mutation.after
    ?? request.auditContext?.mutationAfter
    ?? extractResponseEntity(request.auditContext?.responseBody, profileValue.entityType)
  const normalizedBefore = sanitizeSnapshot(profileValue.entityType, rawBefore)
  const normalizedAfter = sanitizeSnapshot(profileValue.entityType, rawAfter)
  const entityId = mutation.entityId
    ?? getEntityId(profileValue, request, rawAfter, rawBefore)

  if (!entityId) {
    return null
  }

  const redactedFields = [...new Set([
    ...getRedactedChangedFields(request),
    ...(mutation.redactedFields ?? [])
  ])].sort()

  const hasCompleteSnapshot = hasRequiredSnapshots(
    profileValue.operation,
    normalizedBefore,
    normalizedAfter
  )

  if (!hasCompleteSnapshot && redactedFields.length === 0) {
    return null
  }

  const snapshots = hasCompleteSnapshot
    ? getChangedSnapshots(
      profileValue.operation,
      normalizedBefore,
      normalizedAfter
    )
    : {before: null, after: null, changedFields: []}

  if (profileValue.operation === 'UPDATE'
    && snapshots.changedFields.length === 0
    && redactedFields.length === 0) {
    return null
  }

  const entityLabel = mutation.entityLabel
    ?? getEntityLabel(profileValue.entityType, rawAfter, rawBefore, entityId)
  const scopes = mutation.scopes
    ?? getMutationScopes(
      request,
      profileValue.entityType,
      entityId,
      entityLabel,
      rawAfter,
      rawBefore
    )

  return {
    operation: profileValue.operation,
    entityType: profileValue.entityType,
    entityId: String(entityId),
    entityLabel: entityLabel ? String(entityLabel).slice(0, 500) : null,
    before: snapshots.before,
    after: snapshots.after,
    changedFields: snapshots.changedFields,
    redactedFields,
    metadata: {
      ...mutation.metadata,
      ...(hasCompleteSnapshot ? {} : {snapshotUnavailable: true})
    },
    scopes
  }
}

export function buildAuditMutations(request, auditAction) {
  const staged = request.auditContext?.mutations ?? []

  if (staged.length > 0) {
    return staged
      .map(mutation => buildMutation(request, auditAction, mutation))
      .filter(Boolean)
  }

  if (!AUDIT_MUTATION_PROFILES[auditAction.type]) {
    return []
  }

  return [buildMutation(request, auditAction, {}, true)].filter(Boolean)
}

/* eslint-enable @stylistic/array-element-newline */
