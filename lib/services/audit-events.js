import createHttpError from 'http-errors'
import Joi from 'joi'

import {prisma} from '../../db/prisma.js'
import {
  AUDIT_ACTIONS,
  getAuditActionOptions
} from '../audit/catalog.js'
import {
  getDeclarantRight,
  getExploitationRight,
  getPointPrelevementRight
} from './resource-permissions.js'
import {
  getEffectiveDeclarantZoneIds,
  getExploitationZoneIds,
  getPermissionCodesForUserInZones,
  getPointZoneIds
} from './zone-permissions.js'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i
const PARIS_TIME_ZONE = 'Europe/Paris'
const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100
const DEFAULT_PERIOD_DAYS = 30
const AUDIT_OUTCOMES = ['STARTED', 'SUCCESS', 'DENIED', 'FAILURE', 'INCOMPLETE']
const RESOURCE_HISTORY_TYPES = new Set(['POINT', 'DECLARANT', 'EXPLOITATION', 'ZONE'])
const RESOURCE_HISTORY_PAGE_SIZE = 10
const RESOURCE_HISTORY_MAX_PAGE_SIZE = 50

const ACTION_HISTORY_PERMISSIONS = Object.freeze({
  'POINT.CREATED': 'pp.create',
  'POINT.CREATED_IN_ZONE': 'pp.create',
  'POINT.UPDATED': 'pp.update',
  'POINT.UPDATED_IN_ZONE': 'pp.update',
  'POINT.USAGE_NAME_UPDATED': 'pp.update',
  'POINT.DELETED': 'pp.delete',
  'POINT.DELETED_FROM_ZONE': 'pp.delete',
  'EXPLOITATION.CREATED': 'exploitation.create',
  'EXPLOITATION.CREATED_IN_ZONE': 'exploitation.create',
  'EXPLOITATION.UPDATED': 'exploitation.update',
  'EXPLOITATION.UPDATED_IN_ZONE': 'exploitation.update',
  'EXPLOITATION.DELETED': 'exploitation.delete',
  'EXPLOITATION.DELETED_FROM_ZONE': 'exploitation.delete',
  'DECLARANT.CREATED': 'declarant.create',
  'DECLARANT.UPDATED': 'declarant.update',
  'DECLARANT.ZONES_UPDATED': 'declarant.zone.update',
  'DECLARANT.DELETED': 'declarant.delete',
  'DECLARANT.DECLARATION_TYPE_ADDED': 'declarant.declaration-type.update',
  'DECLARANT.DECLARATION_TYPE_UPDATED': 'declarant.declaration-type.update',
  'DECLARANT.DECLARATION_TYPE_REMOVED': 'declarant.declaration-type.update',
  'DECLARANT.EMAIL_ALIAS_ADDED_BY_AGENT': 'declarant.email-alias.update',
  'DECLARANT.EMAIL_ALIAS_REMOVED_BY_AGENT': 'declarant.email-alias.update',
  'DECLARANT.EMAIL_ALIAS_ADDED': 'declarant.email-alias.update',
  'DECLARANT.EMAIL_ALIAS_REMOVED': 'declarant.email-alias.update',
  'DOCUMENT.CREATED': 'declarant.document.create',
  'DOCUMENT.UPDATED': 'declarant.document.update',
  'DOCUMENT.DELETED': 'declarant.document.delete',
  'RULE.CREATED': 'declarant.rule.create',
  'RULE.UPDATED': 'declarant.rule.update',
  'RULE.DELETED': 'declarant.rule.delete',
  'ZONE.DECLARATION_SETTINGS_UPDATED': 'zone.declaration.settings.update',
  'ZONE.DECLARATION_OVERRIDE_CREATED': 'zone.declaration.override.create',
  'ZONE.DECLARATION_OVERRIDE_UPDATED': 'zone.declaration.override.update',
  'ZONE.DECLARATION_OVERRIDE_DELETED': 'zone.declaration.override.delete',
  'ZONE.MONITORING_STATION_ADDED': 'zone.resource.create',
  'ZONE.MONITORING_STATION_UPDATED': 'zone.resource.update',
  'ZONE.MONITORING_STATION_REMOVED': 'zone.resource.delete',
  'ZONE.AGENT_ADDED': 'zone.agent.create',
  'ZONE.AGENT_PERMISSIONS_UPDATED': 'zone.agent.update',
  'ZONE.AGENT_REMOVED': 'zone.agent.remove'
})

const resourceHistoryQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(RESOURCE_HISTORY_MAX_PAGE_SIZE)
    .default(RESOURCE_HISTORY_PAGE_SIZE)
})

const querySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().valid(25, 50, 100).default(DEFAULT_PAGE_SIZE),
  actor: Joi.string().trim().max(200).allow(''),
  subject: Joi.string().trim().max(200).allow(''),
  target: Joi.string().trim().max(200).allow(''),
  from: Joi.string().pattern(DATE_PATTERN),
  to: Joi.string().pattern(DATE_PATTERN),
  period: Joi.string().valid('24h', 'all'),
  actionTypes: Joi.string().trim().allow(''),
  outcomes: Joi.string().trim().allow('')
}).and('from', 'to')

function getParisDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: PARIS_TIME_ZONE,
    year: 'numeric'
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))

  return `${values.year}-${values.month}-${values.day}`
}

function getTimeZoneOffset(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone,
    year: 'numeric'
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  const localTimeAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  )

  return localTimeAsUtc - date.getTime()
}

function parseDateKey(value) {
  const [year, month, day] = String(value).split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))

  if (!DATE_PATTERN.test(value) || date.toISOString().slice(0, 10) !== value) {
    throw createHttpError(400, 'Période du journal d’audit invalide.')
  }

  return date
}

function getParisDayStart(value) {
  const utcMidnight = parseDateKey(value)
  const firstEstimate = new Date(
    utcMidnight.getTime() - getTimeZoneOffset(utcMidnight, PARIS_TIME_ZONE)
  )

  return new Date(
    utcMidnight.getTime() - getTimeZoneOffset(firstEstimate, PARIS_TIME_ZONE)
  )
}

function addUtcDays(value, days) {
  const result = new Date(value)
  result.setUTCDate(result.getUTCDate() + days)
  return result
}

function getDefaultDateRange(now) {
  const to = getParisDateKey(now)
  const fromDate = addUtcDays(parseDateKey(to), -(DEFAULT_PERIOD_DAYS - 1))

  return {
    from: fromDate.toISOString().slice(0, 10),
    to
  }
}

function parseCsv(value) {
  return [...new Set(String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean))]
}

function validateSelection(values, allowedValues, label) {
  const unknownValues = values.filter(value => !allowedValues.has(value))

  if (unknownValues.length > 0) {
    throw createHttpError(400, `${label} inconnu : ${unknownValues[0]}`)
  }
}

function buildIdentitySearch(search, {textFields, idFields}) {
  if (!search) {
    return null
  }

  const containsFilters = textFields.map(field => ({
    [field]: {contains: search, mode: 'insensitive'}
  }))
  const idFilters = UUID_PATTERN.test(search)
    ? idFields.map(field => ({[field]: search}))
    : []

  return {OR: [...containsFilters, ...idFilters]}
}

function serializeAuditEvent(event, actionByType) {
  const action = actionByType.get(event.actionType)
  const {mutations, _count, ...data} = event

  return {
    ...data,
    actionLabel: action?.label ?? event.actionType,
    categoryLabel: action?.categoryLabel ?? event.actionCategory,
    mutationCount: _count?.mutations ?? mutations?.length ?? 0,
    ...(mutations ? {mutations: mutations.map(serializeAuditMutation)} : {})
  }
}

function serializeAuditMutation(mutation) {
  return {
    id: mutation.id,
    occurredAt: mutation.occurredAt,
    operation: mutation.operation,
    entityType: mutation.entityType,
    entityId: mutation.entityId,
    entityLabel: mutation.entityLabel,
    before: mutation.before,
    after: mutation.after,
    changedFields: mutation.changedFields,
    redactedFields: mutation.redactedFields,
    metadata: mutation.metadata,
    ...(mutation.scopes ? {scopes: mutation.scopes} : {})
  }
}

export function parseAuditEventQuery(query = {}, {now = new Date()} = {}) {
  const {error, value} = querySchema.validate(query, {stripUnknown: true})

  if (error) {
    throw createHttpError(400, 'Filtres du journal d’audit invalides.')
  }

  const defaultRange = getDefaultDateRange(now)
  const retentionCutoff = getAuditRetentionCutoff(now)
  const last24HoursStart = new Date(now.getTime() - (24 * 60 * 60 * 1000))
  const today = getParisDateKey(now)
  let from = value.from ?? defaultRange.from

  if (value.period === 'all') {
    from = getParisDateKey(retentionCutoff)
  } else if (value.period === '24h') {
    from = getParisDateKey(last24HoursStart)
  }

  const to = value.period ? today : value.to ?? today
  let startInstant = getParisDayStart(from)

  if (value.period === 'all') {
    startInstant = retentionCutoff
  } else if (value.period === '24h') {
    startInstant = last24HoursStart
  }

  if (from > to || to > getParisDateKey(now)) {
    throw createHttpError(400, 'Période du journal d’audit invalide.')
  }

  const actionTypes = parseCsv(value.actionTypes)
  const outcomes = parseCsv(value.outcomes)
  validateSelection(actionTypes, new Set(AUDIT_ACTIONS.map(action => action.type)), 'Type d’action')
  validateSelection(outcomes, new Set(AUDIT_OUTCOMES), 'Résultat')

  return {
    page: Math.max(1, value.page),
    pageSize: Math.min(MAX_PAGE_SIZE, value.pageSize),
    actor: value.actor || '',
    subject: value.subject || '',
    target: value.target || '',
    from,
    to,
    actionTypes,
    outcomes,
    period: value.period ?? null,
    startInstant,
    endExclusive: value.period ? now : getParisDayStart(addUtcDays(parseDateKey(to), 1).toISOString().slice(0, 10))
  }
}

export async function listAuditEvents(query, {
  client = prisma,
  excludeId,
  now = new Date()
} = {}) {
  const filters = parseAuditEventQuery(query, {now})
  const actorSearch = buildIdentitySearch(filters.actor, {
    textFields: ['actorLabel', 'actorEmail'],
    idFields: ['actorUserId', 'actorServiceAccountId']
  })
  const subjectSearch = buildIdentitySearch(filters.subject, {
    textFields: [
      'effectiveUserLabel',
      'effectiveUserEmail',
      'subjectUserLabel',
      'subjectUserEmail'
    ],
    idFields: ['effectiveUserId', 'subjectUserId']
  })
  const targetSearch = filters.target
    ? {
      OR: [
        {targetLabel: {contains: filters.target, mode: 'insensitive'}},
        {targetId: {equals: filters.target}},
        {
          mutations: {
            some: {
              OR: [
                {entityLabel: {contains: filters.target, mode: 'insensitive'}},
                {entityId: {equals: filters.target}},
                {
                  scopes: {
                    some: {
                      OR: [
                        {resourceLabel: {contains: filters.target, mode: 'insensitive'}},
                        {resourceId: {equals: filters.target}}
                      ]
                    }
                  }
                }
              ]
            }
          }
        }
      ]
    }
    : null
  const where = {
    occurredAt: {
      gte: filters.startInstant,
      lt: filters.endExclusive
    },
    ...(excludeId ? {id: {not: excludeId}} : {}),
    ...(filters.actionTypes.length > 0 ? {actionType: {in: filters.actionTypes}} : {}),
    ...(filters.outcomes.length > 0 ? {outcome: {in: filters.outcomes}} : {}),
    AND: [actorSearch, subjectSearch, targetSearch].filter(Boolean)
  }
  const [total, items] = await client.$transaction([
    client.auditEvent.count({where}),
    client.auditEvent.findMany({
      where,
      orderBy: [
        {occurredAt: 'desc'},
        {id: 'desc'}
      ],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
      include: {
        _count: {select: {mutations: true}}
      }
    })
  ])
  const actionByType = new Map(AUDIT_ACTIONS.map(action => [action.type, action]))

  return {
    items: items.map(item => serializeAuditEvent(item, actionByType)),
    pagination: {
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / filters.pageSize))
    },
    period: {
      from: filters.from,
      to: filters.to,
      preset: filters.period
    }
  }
}

export async function getAuditEventDetail(eventId, {client = prisma} = {}) {
  if (!UUID_PATTERN.test(eventId || '')) {
    throw createHttpError(400, 'Identifiant d’événement d’audit invalide.')
  }

  const event = await client.auditEvent.findUnique({
    where: {id: eventId},
    include: {
      mutations: {
        include: {scopes: true},
        orderBy: [{occurredAt: 'asc'}, {id: 'asc'}]
      }
    }
  })

  if (!event) {
    throw createHttpError(404, 'Cet événement d’audit est introuvable.')
  }

  return serializeAuditEvent(
    event,
    new Map(AUDIT_ACTIONS.map(action => [action.type, action]))
  )
}

function getAllowedHistoryActionTypes(permissions) {
  const permissionSet = new Set(permissions)

  return Object.entries(ACTION_HISTORY_PERMISSIONS)
    .filter(([, permission]) => permissionSet.has(permission))
    .map(([actionType]) => actionType)
}

async function getResourceHistoryAuthorization(user, resourceType, resourceId) {
  if (user?.role === 'ADMIN') {
    return {allowedActionTypes: null}
  }

  if (user?.role !== 'INSTRUCTOR') {
    throw createHttpError(403, 'Vous ne pouvez pas consulter cet historique.')
  }

  if (resourceType === 'POINT') {
    const right = await getPointPrelevementRight(user, resourceId)
    if (right.canEdit) {
      const zoneIds = await getPointZoneIds(resourceId)
      const permissions = await getPermissionCodesForUserInZones(user, zoneIds)
      return {allowedActionTypes: getAllowedHistoryActionTypes(permissions)}
    }
  }

  if (resourceType === 'EXPLOITATION') {
    const right = await getExploitationRight(user, resourceId)
    if (right.canEdit) {
      const zoneIds = await getExploitationZoneIds(resourceId)
      const permissions = await getPermissionCodesForUserInZones(user, zoneIds)
      return {allowedActionTypes: getAllowedHistoryActionTypes(permissions)}
    }
  }

  if (resourceType === 'DECLARANT') {
    const right = await getDeclarantRight(user, resourceId)
    if (right.canEdit) {
      const zoneIds = await getEffectiveDeclarantZoneIds(resourceId)
      const permissions = await getPermissionCodesForUserInZones(user, zoneIds)
      return {allowedActionTypes: getAllowedHistoryActionTypes(permissions)}
    }
  }

  if (resourceType === 'ZONE') {
    const permissions = new Set(
      await getPermissionCodesForUserInZones(user, [resourceId])
    )
    const allowedActionTypes = getAllowedHistoryActionTypes(permissions)

    if (allowedActionTypes.length > 0) {
      return {allowedActionTypes}
    }
  }

  throw createHttpError(403, 'Vous ne disposez pas du droit de consulter cet historique.')
}

function serializeResourceHistoryItem(scopeEntry, actionByType) {
  const {auditEvent, ...mutation} = scopeEntry.auditMutation
  const action = actionByType.get(auditEvent.actionType)

  return {
    ...serializeAuditMutation(mutation),
    actionType: auditEvent.actionType,
    actionLabel: action?.label ?? auditEvent.actionType,
    categoryLabel: action?.categoryLabel ?? auditEvent.actionCategory,
    actorType: auditEvent.actorType,
    actorUserId: auditEvent.actorUserId,
    actorServiceAccountId: auditEvent.actorServiceAccountId,
    actorLabel: auditEvent.actorLabel,
    actorEmail: auditEvent.actorEmail,
    effectiveUserId: auditEvent.effectiveUserId,
    effectiveUserLabel: auditEvent.effectiveUserLabel,
    occurredAt: auditEvent.occurredAt
  }
}

export async function listResourceAuditHistory({
  query,
  resourceId,
  resourceType,
  user
}, {client = prisma} = {}) {
  const normalizedType = String(resourceType || '').toUpperCase()

  if (!RESOURCE_HISTORY_TYPES.has(normalizedType) || !UUID_PATTERN.test(resourceId || '')) {
    throw createHttpError(400, 'Ressource d’historique invalide.')
  }

  const {error, value} = resourceHistoryQuerySchema.validate(query, {
    stripUnknown: true
  })

  if (error) {
    throw createHttpError(400, 'Pagination de l’historique invalide.')
  }

  const {allowedActionTypes} = await getResourceHistoryAuthorization(
    user,
    normalizedType,
    resourceId
  )
  const where = {
    resourceType: normalizedType,
    resourceId,
    auditMutation: {
      auditEvent: {
        outcome: 'SUCCESS',
        ...(allowedActionTypes ? {actionType: {in: allowedActionTypes}} : {})
      }
    }
  }
  const [total, entries] = await client.$transaction([
    client.auditMutationScope.count({where}),
    client.auditMutationScope.findMany({
      where,
      orderBy: [{occurredAt: 'desc'}, {id: 'desc'}],
      skip: (value.page - 1) * value.pageSize,
      take: value.pageSize,
      include: {
        auditMutation: {
          include: {
            auditEvent: {
              select: {
                actionType: true,
                actionCategory: true,
                actorType: true,
                actorUserId: true,
                actorServiceAccountId: true,
                actorLabel: true,
                actorEmail: true,
                effectiveUserId: true,
                effectiveUserLabel: true,
                occurredAt: true
              }
            }
          }
        }
      }
    })
  ])
  const actionByType = new Map(AUDIT_ACTIONS.map(action => [action.type, action]))

  return {
    items: entries.map(entry => serializeResourceHistoryItem(entry, actionByType)),
    pagination: {
      page: value.page,
      pageSize: value.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / value.pageSize))
    }
  }
}

export function getAuditEventFilterOptions() {
  return {
    actionGroups: getAuditActionOptions(),
    outcomes: [
      {value: 'SUCCESS', label: 'Réussie'},
      {value: 'DENIED', label: 'Refusée'},
      {value: 'FAILURE', label: 'En échec'},
      {value: 'STARTED', label: 'En cours'},
      {value: 'INCOMPLETE', label: 'Interrompue'}
    ]
  }
}

export function getAuditRetentionCutoff(now = new Date()) {
  const cutoff = new Date(now)
  const originalDay = cutoff.getUTCDate()
  cutoff.setUTCDate(1)
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 2)
  const lastDayOfTargetMonth = new Date(Date.UTC(
    cutoff.getUTCFullYear(),
    cutoff.getUTCMonth() + 1,
    0
  )).getUTCDate()
  cutoff.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth))
  return cutoff
}

export async function purgeExpiredAuditEvents({
  client = prisma,
  now = new Date(),
  batchSize = 5000
} = {}) {
  const cutoff = getAuditRetentionCutoff(now)
  let deletedCount = 0

  /* eslint-disable no-await-in-loop */
  for (;;) {
    const events = await client.auditEvent.findMany({
      where: {occurredAt: {lt: cutoff}},
      select: {id: true},
      orderBy: {occurredAt: 'asc'},
      take: batchSize
    })

    if (events.length === 0) {
      break
    }

    const result = await client.auditEvent.deleteMany({
      where: {id: {in: events.map(event => event.id)}}
    })
    deletedCount += result.count
  }
  /* eslint-enable no-await-in-loop */

  return {
    cutoff: cutoff.toISOString(),
    deletedCount
  }
}
