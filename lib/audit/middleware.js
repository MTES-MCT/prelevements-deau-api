import path from 'node:path'

import * as Sentry from '@sentry/node'
import createHttpError from 'http-errors'

import {prisma} from '../../db/prisma.js'
import {findAuditAction} from './catalog.js'
import {resolveAuditNetworkContext} from './context.js'

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i
const SENSITIVE_FIELD_PATTERN = /(authorization|cookie|password|secret|token|content|comment|file|html)/i
const SAFE_BODY_VALUE_FIELDS = [
  'declarationNotificationsEnabled',
  'declarantRole',
  'declarantType',
  'enabled',
  'endDate',
  'flowType',
  'frequency',
  'isActive',
  'notificationType',
  'nature',
  'periodType',
  'pointKind',
  'quickDeclarationEnabled',
  'role',
  'startDate',
  'status',
  'type',
  'valueType',
  'waterBodyType',
  'withdrawalType'
]

function getNestedValue(source, key) {
  let value = source

  for (const segment of key.split('.')) {
    value = value?.[segment]
  }

  return value
}

function getDescriptorValue(descriptor, request, params) {
  if (!descriptor) {
    return null
  }

  if (descriptor.param) {
    return params[descriptor.param]
  }

  if (descriptor.body) {
    return getNestedValue(request.body, descriptor.body)
  }

  return null
}

function getChangedFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return []
  }

  return Object.keys(body)
    .filter(field => !SENSITIVE_FIELD_PATTERN.test(field))
    .sort()
    .slice(0, 100)
}

function getCollectionCounts(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(body)
      .filter(([field, value]) => Array.isArray(value) && !SENSITIVE_FIELD_PATTERN.test(field))
      .slice(0, 20)
      .map(([field, value]) => [`${field}Count`, value.length])
  )
}

function pickSafeValues(source, fields = []) {
  const values = {}

  for (const field of fields) {
    const value = getNestedValue(source, field)

    if (['string', 'number', 'boolean'].includes(typeof value)) {
      values[field] = typeof value === 'string' ? value.slice(0, 255) : value
    }
  }

  return values
}

function getUploadedFileMetadata(request) {
  const files = [
    ...(Array.isArray(request.files) ? request.files : []),
    ...(request.file ? [request.file] : [])
  ]

  if (files.length === 0) {
    return {}
  }

  let uploadedFileTotalBytes = 0

  for (const file of files) {
    uploadedFileTotalBytes += Number(file.size || 0)
  }

  return {
    uploadedFileCount: files.length,
    uploadedFileTotalBytes,
    uploadedFileExtensions: [...new Set(files
      .map(file => path.extname(file.originalname || '').toLowerCase())
      .filter(Boolean))]
  }
}

function buildSafeMetadata(request, auditAction, params, networkContext) {
  const changedFields = getChangedFields(request.body)
  const routeParameters = {
    ...pickSafeValues(params, auditAction.safeParamFields ?? Object.keys(params)),
    ...pickSafeValues(request.query, auditAction.safeQueryFields)
  }
  const requestedValues = pickSafeValues(request.body, SAFE_BODY_VALUE_FIELDS)
  const originalResource = request.point
    || request.declarant
    || request.exploitation
    || request.document
    || request.regle
  const previousValues = pickSafeValues(
    originalResource,
    SAFE_BODY_VALUE_FIELDS.filter(field => Object.hasOwn(request.body || {}, field))
  )

  return {
    networkContextSource: networkContext.source,
    ...(networkContext.invalidSignedContext ? {invalidSignedContext: true} : {}),
    ...(Object.keys(routeParameters).length > 0 ? {routeParameters} : {}),
    ...(Object.keys(requestedValues).length > 0 ? {requestedValues} : {}),
    ...(Object.keys(previousValues).length > 0 ? {previousValues} : {}),
    ...(changedFields.length > 0 ? {changedFields} : {}),
    ...getCollectionCounts(request.body),
    ...getUploadedFileMetadata(request),
    ...request.auditContext?.metadata
  }
}

function getUserLabel(user) {
  if (!user) {
    return null
  }

  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ')
  return user.declarant?.socialReason || fullName || user.email || user.name || user.id || null
}

function serializeUserSnapshot(user, role = user?.role) {
  if (!user?.id) {
    return null
  }

  return {
    id: user.id,
    label: getUserLabel(user),
    email: user.email || null,
    role: role || null
  }
}

function serializeServiceAccountSnapshot(serviceAccount) {
  if (!serviceAccount?.id) {
    return null
  }

  return {
    id: serviceAccount.id,
    label: serviceAccount.name || serviceAccount.id
  }
}

function resolveActor(request) {
  const explicitActor = request.auditContext?.actor
  const actor = explicitActor || request.authActor

  if (actor?.type === 'SERVICE_ACCOUNT') {
    return {
      type: 'SERVICE_ACCOUNT',
      serviceAccount: serializeServiceAccountSnapshot(actor)
    }
  }

  if (actor?.type === 'USER') {
    return {
      type: 'USER',
      user: serializeUserSnapshot(actor, actor.role)
    }
  }

  if (request.auth?.type === 'SERVICE_ACCOUNT_ACCESS' && request.serviceAccount) {
    return {
      type: 'SERVICE_ACCOUNT',
      serviceAccount: serializeServiceAccountSnapshot(request.serviceAccount)
    }
  }

  if (request.auth?.type === 'USER_SESSION' && request.user) {
    return {
      type: 'USER',
      user: serializeUserSnapshot(request.user, request.userRole)
    }
  }

  return {type: 'ANONYMOUS'}
}

function resolveEffectiveUser(request) {
  if (!['USER_SESSION', 'SERVICE_ACCOUNT_IMPERSONATION'].includes(request.auth?.type)) {
    return null
  }

  return serializeUserSnapshot(request.user, request.userRole)
}

async function resolveSubjectUser(request, auditAction, params, client) {
  if (request.auditContext?.subject) {
    return serializeUserSnapshot(request.auditContext.subject)
  }

  const candidateId = request.auditContext?.subjectId
    || getDescriptorValue(auditAction.subject, request, params)

  if (!UUID_PATTERN.test(candidateId || '')) {
    return null
  }

  const resolvedDeclarant = request.declarant?.id === candidateId
    ? request.declarant
    : null

  if (resolvedDeclarant) {
    return serializeUserSnapshot(resolvedDeclarant)
  }

  const user = await client.user.findUnique({
    where: {id: candidateId},
    include: {declarant: true}
  })

  return serializeUserSnapshot(user)
}

function getAuditOutcome(statusCode, incomplete = false) {
  if (incomplete) {
    return 'INCOMPLETE'
  }

  if ([401, 403, 429].includes(statusCode)) {
    return 'DENIED'
  }

  if (statusCode >= 400) {
    return 'FAILURE'
  }

  return 'SUCCESS'
}

function getInitialTarget(request, auditAction, params) {
  const explicitTarget = request.auditContext?.target
  const targetId = explicitTarget?.id || getDescriptorValue(auditAction.target, request, params)

  return {
    targetType: explicitTarget?.type || auditAction.target?.type || null,
    targetId: targetId ? String(targetId).slice(0, 500) : null,
    targetLabel: explicitTarget?.label ? String(explicitTarget.label).slice(0, 500) : null
  }
}

function captureResponseTarget(request, response, auditAction) {
  if (!auditAction.target || getDescriptorValue(auditAction.target, request, auditAction.params)) {
    return
  }

  const capture = body => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return
    }

    const candidates = [body, body.data, body.declaration, body.data?.declaration]
    const target = candidates.find(candidate => candidate?.id || candidate?.userId)

    if (target) {
      request.auditContext ||= {metadata: {}}
      request.auditContext.target = {
        type: auditAction.target.type,
        id: String(target.id || target.userId),
        label: target.name || target.label || null
      }

      if (auditAction.target.type === 'DECLARANT') {
        request.auditContext.subjectId = String(target.id || target.userId)
      }
    }
  }

  const originalJson = response.json
  const originalSend = response.send

  response.json = function (body) {
    capture(body)
    return originalJson.call(this, body)
  }

  response.send = function (body) {
    capture(body)
    return originalSend.call(this, body)
  }
}

// eslint-disable-next-line complexity
function buildFinalIdentityData(actor, effectiveUser, subjectUser) {
  return {
    actorType: actor.type,
    actorUserId: actor.user?.id || null,
    actorServiceAccountId: actor.serviceAccount?.id || null,
    actorLabel: actor.user?.label || actor.serviceAccount?.label || null,
    actorEmail: actor.user?.email || null,
    actorRole: actor.user?.role || null,
    effectiveUserId: effectiveUser?.id || null,
    effectiveUserLabel: effectiveUser?.label || null,
    effectiveUserEmail: effectiveUser?.email || null,
    effectiveUserRole: effectiveUser?.role || null,
    subjectUserId: subjectUser?.id || null,
    subjectUserLabel: subjectUser?.label || null,
    subjectUserEmail: subjectUser?.email || null,
    subjectUserRole: subjectUser?.role || null
  }
}

export function createAuditMiddleware({client = prisma} = {}) {
  return async (request, response, next) => {
    const requestPath = request.path.startsWith('/api/')
      ? request.path.slice(4)
      : request.path
    const auditAction = findAuditAction(request.method, requestPath)

    if (!auditAction) {
      return next()
    }

    const networkContext = resolveAuditNetworkContext(request)
    const initialTarget = getInitialTarget(request, auditAction, auditAction.params)

    try {
      const event = await client.auditEvent.create({
        data: {
          actionType: auditAction.type,
          actionCategory: auditAction.category,
          requestId: request.requestId,
          originRequestId: networkContext.originRequestId,
          httpMethod: request.method,
          route: auditAction.path,
          clientIp: networkContext.clientIp,
          userAgent: networkContext.userAgent,
          ...initialTarget,
          metadata: buildSafeMetadata(request, auditAction, auditAction.params, networkContext)
        },
        select: {id: true}
      })

      request.auditEventId = event.id
      request.auditAction = auditAction
      request.auditContext ||= {metadata: {}}
    } catch (error) {
      Sentry.captureException(error, {tags: {component: 'audit', phase: 'start'}})
      return next(createHttpError(503, 'Le journal de sécurité est momentanément indisponible. Réessayez plus tard.'))
    }

    captureResponseTarget(request, response, auditAction)

    let finalizationStarted = false
    const finalize = async incomplete => {
      if (finalizationStarted) {
        return
      }

      finalizationStarted = true

      try {
        const subjectUser = await resolveSubjectUser(request, auditAction, auditAction.params, client)
        const actor = resolveActor(request)
        const effectiveUser = resolveEffectiveUser(request)
        const target = getInitialTarget(request, auditAction, auditAction.params)

        await client.auditEvent.update({
          where: {id: request.auditEventId},
          data: {
            completedAt: new Date(),
            outcome: getAuditOutcome(response.statusCode, incomplete),
            statusCode: response.statusCode,
            ...buildFinalIdentityData(actor, effectiveUser, subjectUser),
            ...target,
            metadata: buildSafeMetadata(request, auditAction, auditAction.params, networkContext)
          }
        })
      } catch (error) {
        Sentry.captureException(error, {
          tags: {component: 'audit', phase: 'finalize'},
          contexts: {audit: {eventId: request.auditEventId, actionType: auditAction.type}}
        })
        console.error('[AUDIT_FINALIZE_ERROR]', {
          eventId: request.auditEventId,
          actionType: auditAction.type,
          message: error.message
        })
      }
    }

    response.once('finish', () => {
      finalize(false)
    })
    response.once('close', () => {
      if (!response.writableFinished) {
        finalize(true)
      }
    })

    return next()
  }
}

export const auditMiddleware = createAuditMiddleware()
