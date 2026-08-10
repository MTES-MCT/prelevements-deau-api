import createHttpError from 'http-errors'
import Joi from 'joi'

import {prisma} from '../../db/prisma.js'
import {
  AUDIT_ACTIONS,
  getAuditActionOptions
} from '../audit/catalog.js'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i
const PARIS_TIME_ZONE = 'Europe/Paris'
const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100
const DEFAULT_PERIOD_DAYS = 30
const AUDIT_OUTCOMES = ['STARTED', 'SUCCESS', 'DENIED', 'FAILURE', 'INCOMPLETE']

const querySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().valid(25, 50, 100).default(DEFAULT_PAGE_SIZE),
  actor: Joi.string().trim().max(200).allow(''),
  subject: Joi.string().trim().max(200).allow(''),
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

  return {
    ...event,
    actionLabel: action?.label ?? event.actionType,
    categoryLabel: action?.categoryLabel ?? event.actionCategory
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
  const where = {
    occurredAt: {
      gte: filters.startInstant,
      lt: filters.endExclusive
    },
    ...(excludeId ? {id: {not: excludeId}} : {}),
    ...(filters.actionTypes.length > 0 ? {actionType: {in: filters.actionTypes}} : {}),
    ...(filters.outcomes.length > 0 ? {outcome: {in: filters.outcomes}} : {}),
    AND: [actorSearch, subjectSearch].filter(Boolean)
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
      take: filters.pageSize
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
