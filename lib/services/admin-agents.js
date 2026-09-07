import createHttpError from 'http-errors'
import prismaPkg from '@prisma/client'

import {prisma} from '../../db/prisma.js'
import {
  ADMIN_AGENT_ACCESS_STATUSES,
  ADMIN_AGENT_ACCOUNT_STATUSES
} from '../constants/admin-agents.js'
import {
  ZONE_PERMISSION_CODES
} from '../constants/zone-permissions.js'
import {normalizeEmail} from '../util/email.js'
import {
  adminAgentCreationSchema,
  adminAgentIdSchema,
  adminAgentsListQuerySchema
} from '../validation/admin-agent-validation.js'
import {
  serializeInstructorHabilitation,
  sortInstructorHabilitations
} from './instructor-zones.js'
import {
  sendAccountCreationNotification,
  sendZoneAttachmentNotification
} from './account-notifications.js'
import {validateZonePermissions} from './zone-permissions.js'

const {Prisma} = prismaPkg

export {
  ADMIN_AGENT_ACCESS_STATUSES,
  ADMIN_AGENT_ACCOUNT_STATUSES,
  ADMIN_AGENT_ACCOUNT_STATUS_FILTERS,
  ADMIN_AGENT_SORT_FIELDS
} from '../constants/admin-agents.js'

const ZONE_SELECT = Object.freeze({
  id: true,
  type: true,
  code: true,
  name: true
})

const LIST_USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  lastLoginAt: true,
  accountCreationMailSentAt: true,
  instructor: {
    select: {
      phoneNumber: true,
      jobTitle: true,
      instructorZones: {
        select: {
          id: true,
          zoneId: true,
          startDate: true,
          endDate: true,
          zoneAttachmentMailSentAt: true,
          createdAt: true,
          updatedAt: true,
          zone: {select: ZONE_SELECT}
        }
      }
    }
  }
}

const DETAIL_USER_SELECT = {
  ...LIST_USER_SELECT,
  instructor: {
    select: {
      ...LIST_USER_SELECT.instructor.select,
      instructorZones: {
        select: {
          ...LIST_USER_SELECT.instructor.select.instructorZones.select,
          permissions: {
            select: {permission: true}
          }
        }
      }
    }
  }
}

function normalizeListInput(value) {
  const inputs = Array.isArray(value) ? value : [value]

  return [...new Set(inputs
    .flatMap(item => String(item ?? '').split(','))
    .map(item => item.trim())
    .filter(Boolean))]
}

function queryValidationError() {
  return createHttpError(400, 'Filtres de la liste des agents invalides.')
}

export function parseAdminAgentsQuery(query = {}) {
  const preparedQuery = {
    ...query,
    zoneIds: normalizeListInput(query.zoneIds),
    accessStatuses: [...new Set(
      normalizeListInput(query.accessStatuses).map(status => status.toUpperCase())
    )]
  }
  const {error, value} = adminAgentsListQuerySchema.validate(preparedQuery, {
    convert: true,
    stripUnknown: true
  })

  if (error) {
    throw queryValidationError()
  }

  const normalizedQuery = value.query || ''
  const requestedSort = value.sort || null
  const sort = requestedSort === 'RELEVANCE' && !normalizedQuery
    ? 'NAME'
    : (requestedSort || (normalizedQuery ? 'RELEVANCE' : 'NAME'))

  return {
    ...value,
    query: normalizedQuery,
    accountStatus: value.accountStatus || 'ACTIVE',
    sort
  }
}

export function validateAdminAgentCreationPayload(payload = {}) {
  const {error, value} = adminAgentCreationSchema.validate(payload, {
    abortEarly: false,
    allowUnknown: false,
    convert: true
  })

  if (error) {
    throw createHttpError(400, 'Informations de l’agent invalides.')
  }

  return {
    ...value,
    email: normalizeEmail(value.email),
    permissions: validateZonePermissions(value.permissions)
  }
}

function getAccountStatus(user) {
  return user.deletedAt ? 'DISABLED' : 'ACTIVE'
}

function countHabilitationStatuses(habilitations) {
  const counts = {
    ACTIVE: 0,
    FUTURE: 0,
    ENDED: 0
  }

  for (const habilitation of habilitations) {
    counts[habilitation.status]++
  }

  return counts
}

function getAccessStatus(counts) {
  if (counts.ACTIVE > 0) {
    return 'ACTIVE'
  }

  if (counts.FUTURE > 0) {
    return 'FUTURE'
  }

  return counts.ENDED > 0 ? 'ENDED' : 'NONE'
}

function serializeHabilitations(user, now) {
  return sortInstructorHabilitations(
    (user.instructor?.instructorZones ?? [])
      .map(right => serializeInstructorHabilitation(right, {now}))
      .filter(Boolean)
  )
}

export function serializeAdminAgentSummary(user, {now = new Date()} = {}) {
  const habilitations = serializeHabilitations(user, now)
  const counts = countHabilitationStatuses(habilitations)

  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    phoneNumber: user.instructor?.phoneNumber ?? null,
    jobTitle: user.instructor?.jobTitle ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
    accountCreationMailSentAt: user.accountCreationMailSentAt,
    accountStatus: getAccountStatus(user),
    accessStatus: getAccessStatus(counts),
    activeHabilitationsCount: counts.ACTIVE,
    futureHabilitationsCount: counts.FUTURE,
    endedHabilitationsCount: counts.ENDED,
    habilitationsCount: habilitations.length,
    zones: habilitations
      .filter(habilitation => habilitation.zone)
      .map(habilitation => ({
        ...habilitation.zone,
        status: habilitation.status
      }))
  }
}

export function serializeAdminAgentDetail(user, {now = new Date()} = {}) {
  return {
    ...serializeAdminAgentSummary(user, {now}),
    habilitations: serializeHabilitations(user, now)
  }
}

function createCountFacet(values) {
  return Object.fromEntries(values.map(value => [value, 0]))
}

function getToday(now) {
  return new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`)
}

function activeHabilitationWhere(today) {
  return {
    startDate: {lte: today},
    OR: [
      {endDate: null},
      {endDate: {gte: today}}
    ]
  }
}

function futureHabilitationWhere(today) {
  return {startDate: {gt: today}}
}

function endedHabilitationWhere(today) {
  return {endDate: {lt: today}}
}

function instructorAccessStatusWhere(status, today) {
  const active = activeHabilitationWhere(today)
  const future = futureHabilitationWhere(today)
  const ended = endedHabilitationWhere(today)

  if (status === 'ACTIVE') {
    return {instructorZones: {some: active}}
  }

  if (status === 'FUTURE') {
    return {
      AND: [
        {instructorZones: {none: active}},
        {instructorZones: {some: future}}
      ]
    }
  }

  if (status === 'ENDED') {
    return {
      AND: [
        {instructorZones: {none: active}},
        {instructorZones: {none: future}},
        {instructorZones: {some: ended}}
      ]
    }
  }

  return {instructorZones: {none: {}}}
}

function userAccessStatusWhere(status, today) {
  return {
    instructor: {
      is: instructorAccessStatusWhere(status, today)
    }
  }
}

function searchTermWhere(term) {
  const contains = {
    contains: term,
    mode: 'insensitive'
  }

  return {
    OR: [
      {email: contains},
      {firstName: contains},
      {lastName: contains},
      {
        instructor: {
          is: {
            OR: [
              {phoneNumber: contains},
              {jobTitle: contains},
              {
                instructorZones: {
                  some: {
                    zone: {
                      is: {
                        OR: [
                          {name: contains},
                          {code: contains}
                        ]
                      }
                    }
                  }
                }
              }
            ]
          }
        }
      }
    ]
  }
}

function searchWhere(query) {
  return getSearchTerms(query).map(searchTermWhere)
}

function getSearchTerms(query) {
  return [...new Set(String(query || '').trim().split(/\s+/).filter(Boolean))]
    .slice(0, 12)
}

function andWhere(where, ...conditions) {
  const additions = conditions.filter(Boolean)

  if (additions.length === 0) {
    return where
  }

  return {
    ...where,
    AND: [...(where.AND ?? []), ...additions]
  }
}

export function buildAdminAgentWhere(filters, {
  includeFacetFilters = true,
  now = new Date()
} = {}) {
  const today = getToday(now)
  let where = {
    role: 'INSTRUCTOR',
    instructor: {isNot: null},
    AND: searchWhere(filters.query)
  }

  if (!includeFacetFilters) {
    return where
  }

  if (filters.accountStatus === 'ACTIVE') {
    where = andWhere(where, {deletedAt: null})
  } else if (filters.accountStatus === 'DISABLED') {
    where = andWhere(where, {deletedAt: {not: null}})
  }

  if (filters.zoneIds.length > 0) {
    where = andWhere(where, {
      instructor: {
        is: {
          instructorZones: {
            some: {zoneId: {in: filters.zoneIds}}
          }
        }
      }
    })
  }

  if (filters.accessStatuses.length > 0) {
    where = andWhere(where, {
      OR: filters.accessStatuses.map(status => userAccessStatusWhere(status, today))
    })
  }

  return where
}

export function getAdminAgentOrderBy({order, sort}) {
  const direction = order.toLowerCase()

  if (sort === 'CREATED_AT') {
    return [
      {createdAt: direction},
      {id: 'asc'}
    ]
  }

  return [
    {lastName: direction},
    {firstName: direction},
    {email: direction},
    {id: 'asc'}
  ]
}

function rawSearchTermWhere(term) {
  return Prisma.sql`(
    strpos(lower(COALESCE(u."email"::text, '')), lower(${term})) > 0
    OR strpos(lower(COALESCE(u."firstName", '')), lower(${term})) > 0
    OR strpos(lower(COALESCE(u."lastName", '')), lower(${term})) > 0
    OR strpos(lower(COALESCE(i."phoneNumber", '')), lower(${term})) > 0
    OR strpos(lower(COALESCE(i."jobTitle", '')), lower(${term})) > 0
    OR EXISTS (
      SELECT 1
      FROM "InstructorZone" search_iz
      JOIN "Zone" search_z ON search_z."id" = search_iz."zoneId"
      WHERE search_iz."instructorUserId" = u."id"
        AND (
          strpos(lower(COALESCE(search_z."name", '')), lower(${term})) > 0
          OR strpos(lower(COALESCE(search_z."code", '')), lower(${term})) > 0
        )
    )
  )`
}

function rawActiveHabilitationWhere(alias, today) {
  return Prisma.sql`${Prisma.raw(alias)}."startDate" <= ${today}::date
    AND (${Prisma.raw(alias)}."endDate" IS NULL OR ${Prisma.raw(alias)}."endDate" >= ${today}::date)`
}

function rawFutureHabilitationWhere(alias, today) {
  return Prisma.sql`${Prisma.raw(alias)}."startDate" > ${today}::date`
}

function rawExistsHabilitation(condition) {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM "InstructorZone" status_iz
    WHERE status_iz."instructorUserId" = u."id"
      AND ${condition}
  )`
}

function rawAccessStatusWhere(status, today) {
  const active = rawExistsHabilitation(rawActiveHabilitationWhere('status_iz', today))
  const future = rawExistsHabilitation(rawFutureHabilitationWhere('status_iz', today))

  if (status === 'ACTIVE') {
    return active
  }

  if (status === 'FUTURE') {
    return Prisma.sql`NOT (${active}) AND ${future}`
  }

  if (status === 'ENDED') {
    return Prisma.sql`NOT (${active})
      AND NOT (${future})
      AND ${rawExistsHabilitation(Prisma.sql`status_iz."endDate" < ${today}::date`)}`
  }

  return Prisma.sql`NOT EXISTS (
    SELECT 1
    FROM "InstructorZone" status_iz
    WHERE status_iz."instructorUserId" = u."id"
  )`
}

function rawAdminAgentWhere(filters, now) {
  const today = getToday(now).toISOString().slice(0, 10)
  const conditions = [Prisma.sql`u."role" = 'INSTRUCTOR'`]

  if (filters.accountStatus === 'ACTIVE') {
    conditions.push(Prisma.sql`u."deletedAt" IS NULL`)
  } else if (filters.accountStatus === 'DISABLED') {
    conditions.push(Prisma.sql`u."deletedAt" IS NOT NULL`)
  }

  conditions.push(...getSearchTerms(filters.query).map(rawSearchTermWhere))

  if (filters.zoneIds.length > 0) {
    const zoneIds = filters.zoneIds.map(zoneId => Prisma.sql`${zoneId}::uuid`)
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1
      FROM "InstructorZone" zone_iz
      WHERE zone_iz."instructorUserId" = u."id"
        AND zone_iz."zoneId" IN (${Prisma.join(zoneIds)})
    )`)
  }

  if (filters.accessStatuses.length > 0) {
    const statuses = filters.accessStatuses.map(status =>
      Prisma.sql`(${rawAccessStatusWhere(status, today)})`)
    conditions.push(Prisma.sql`(${Prisma.join(statuses, ' OR ')})`)
  }

  return Prisma.join(conditions, ' AND ')
}

function rawAdminAgentOrderBy(filters, now) {
  const direction = filters.order === 'DESC' ? Prisma.sql`DESC` : Prisma.sql`ASC`
  const nameOrder = Prisma.sql`
    lower(COALESCE(u."lastName", '')) ASC,
    lower(COALESCE(u."firstName", '')) ASC,
    lower(COALESCE(u."email"::text, '')) ASC,
    u."id" ASC`

  if (filters.sort === 'ACTIVE_ZONES') {
    const today = getToday(now).toISOString().slice(0, 10)
    return Prisma.sql`(
      SELECT count(*)
      FROM "InstructorZone" active_iz
      WHERE active_iz."instructorUserId" = u."id"
        AND ${rawActiveHabilitationWhere('active_iz', today)}
    ) ${direction}, ${nameOrder}`
  }

  const normalizedQuery = filters.query.trim()
  const fullName = Prisma.sql`trim(concat_ws(' ', u."firstName", u."lastName"))`
  return Prisma.sql`CASE
      WHEN lower(COALESCE(u."email"::text, '')) = lower(${normalizedQuery}) THEN 0
      WHEN lower(${fullName}) = lower(${normalizedQuery}) THEN 0
      WHEN strpos(lower(COALESCE(u."email"::text, '')), lower(${normalizedQuery})) = 1 THEN 1
      WHEN strpos(lower(${fullName}), lower(${normalizedQuery})) = 1 THEN 1
      ELSE 2
    END ${direction}, ${nameOrder}`
}

async function findAdminAgentPage(filters, where, client, now) {
  if (!['ACTIVE_ZONES', 'RELEVANCE'].includes(filters.sort)) {
    return client.user.findMany({
      where,
      select: LIST_USER_SELECT,
      orderBy: getAdminAgentOrderBy(filters),
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize
    })
  }

  const rows = await client.$queryRaw(Prisma.sql`
    SELECT u."id"
    FROM "User" u
    JOIN "Instructor" i ON i."userId" = u."id"
    WHERE ${rawAdminAgentWhere(filters, now)}
    ORDER BY ${rawAdminAgentOrderBy(filters, now)}
    LIMIT ${filters.pageSize}
    OFFSET ${(filters.page - 1) * filters.pageSize}
  `)
  const ids = rows.map(row => row.id)

  if (ids.length === 0) {
    return []
  }

  const users = await client.user.findMany({
    where: {id: {in: ids}},
    select: LIST_USER_SELECT
  })
  const userById = new Map(users.map(user => [user.id, user]))

  return ids.map(id => userById.get(id)).filter(Boolean)
}

function withAccountStatus(where, status) {
  return andWhere(where, status === 'ACTIVE'
    ? {deletedAt: null}
    : {deletedAt: {not: null}})
}

async function getZoneFacets(client, baseWhere) {
  const groups = await client.instructorZone.groupBy({
    by: ['zoneId'],
    where: {
      instructor: {
        user: baseWhere
      }
    },
    _count: {_all: true}
  })
  const zoneIds = groups.map(group => group.zoneId)

  if (zoneIds.length === 0) {
    return []
  }

  const zones = await client.zone.findMany({
    where: {id: {in: zoneIds}},
    select: ZONE_SELECT
  })
  const countByZoneId = new Map(groups.map(group => [
    group.zoneId,
    group._count?._all ?? group._count ?? 0
  ]))

  return zones
    .map(zone => ({...zone, count: countByZoneId.get(zone.id) ?? 0}))
    .sort((left, right) =>
      (left.name || '').localeCompare(right.name || '', 'fr')
      || (left.code || '').localeCompare(right.code || '', 'fr'))
}

async function getAdminAgentFacets(client, baseWhere, now) {
  const today = getToday(now)
  const accountStatuses = createCountFacet(ADMIN_AGENT_ACCOUNT_STATUSES)
  const accessStatuses = createCountFacet(ADMIN_AGENT_ACCESS_STATUSES)
  const [activeAccounts, disabledAccounts, ...accessCounts] = await Promise.all([
    client.user.count({where: withAccountStatus(baseWhere, 'ACTIVE')}),
    client.user.count({where: withAccountStatus(baseWhere, 'DISABLED')}),
    ...ADMIN_AGENT_ACCESS_STATUSES.map(status => client.user.count({
      where: andWhere(baseWhere, userAccessStatusWhere(status, today))
    }))
  ])

  accountStatuses.ACTIVE = activeAccounts
  accountStatuses.DISABLED = disabledAccounts
  for (const [index, status] of ADMIN_AGENT_ACCESS_STATUSES.entries()) {
    accessStatuses[status] = accessCounts[index]
  }

  return {
    accountStatuses,
    accessStatuses,
    zones: await getZoneFacets(client, baseWhere)
  }
}

export async function listAdminAgents(query = {}, {
  client = prisma,
  now = new Date()
} = {}) {
  const filters = parseAdminAgentsQuery(query)
  const where = buildAdminAgentWhere(filters, {now})
  const baseWhere = buildAdminAgentWhere(filters, {
    includeFacetFilters: false,
    now
  })
  const [total, users, facets] = await Promise.all([
    client.user.count({where}),
    findAdminAgentPage(filters, where, client, now),
    getAdminAgentFacets(client, baseWhere, now)
  ])

  return {
    items: users.map(user => serializeAdminAgentSummary(user, {now})),
    page: filters.page,
    pageSize: filters.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
    facets
  }
}

function validateAgentId(agentId) {
  const {error, value} = adminAgentIdSchema.required().validate(agentId)

  if (error) {
    throw createHttpError(400, 'Identifiant d’agent invalide.')
  }

  return value
}

export async function getAdminAgent(agentId, {
  client = prisma,
  now = new Date()
} = {}) {
  const id = validateAgentId(agentId)
  const user = await client.user.findFirst({
    where: {
      id,
      role: 'INSTRUCTOR',
      instructor: {isNot: null}
    },
    select: DETAIL_USER_SELECT
  })

  if (!user) {
    throw createHttpError(404, 'Cet agent est introuvable.')
  }

  return serializeAdminAgentDetail(user, {now})
}

function isEmailConflict(error) {
  const message = [
    error?.message,
    error?.meta?.database_error,
    error?.cause?.message
  ].filter(Boolean).join(' ')

  return error?.code === 'P2002'
    || error?.code === '23505'
    || message.includes('User_email_not_alias')
    || message.includes('User_email_reserved')
    || message.includes('UserEmailIdentity_compatible_claims_check')
}

async function createAdminAgentRecords(value, client) {
  try {
    return await client.$transaction(async transaction => {
      const zone = await transaction.zone.findUnique({
        where: {id: value.zoneId},
        select: ZONE_SELECT
      })

      if (!zone) {
        throw createHttpError(404, 'Cette zone est introuvable.')
      }

      const existingUser = await transaction.user.findUnique({
        where: {email: value.email},
        select: {id: true, deletedAt: true}
      })

      if (existingUser) {
        throw createHttpError(
          409,
          existingUser.deletedAt
            ? 'Un compte désactivé utilise déjà cette adresse email.'
            : 'Cette adresse email est déjà utilisée.'
        )
      }

      const user = await transaction.user.create({
        data: {
          email: value.email,
          role: 'INSTRUCTOR',
          firstName: value.firstName,
          lastName: value.lastName,
          instructor: {
            create: {
              phoneNumber: value.phoneNumber,
              jobTitle: value.jobTitle
            }
          }
        }
      })
      const right = await transaction.instructorZone.create({
        data: {
          instructorUserId: user.id,
          zoneId: value.zoneId,
          isAdmin: value.permissions.length === ZONE_PERMISSION_CODES.length,
          startDate: value.startDate,
          endDate: value.endDate,
          permissions: {
            createMany: {
              data: value.permissions.map(permission => ({permission}))
            }
          }
        }
      })

      return {right, user, zone}
    })
  } catch (error) {
    if (isEmailConflict(error)) {
      throw createHttpError(409, 'Cette adresse email est déjà utilisée ou en cours de validation.')
    }

    throw error
  }
}

export async function createAdminAgent(payload, {
  client = prisma,
  now = new Date(),
  notifyAccountCreation = sendAccountCreationNotification,
  notifyZoneAttachment = sendZoneAttachmentNotification
} = {}) {
  const value = validateAdminAgentCreationPayload(payload)
  const {user, zone} = await createAdminAgentRecords(value, client)
  const notifications = [
    value.notifyAccountCreation
      ? {
        run: () => notifyAccountCreation(user, {role: 'INSTRUCTOR'}),
        warning: 'La notification de création du compte n’a pas pu être envoyée.'
      }
      : null,
    value.notifyZoneAttachment
      ? {
        run: () => notifyZoneAttachment({instructor: user, zone}),
        warning: 'La notification de rattachement à la zone n’a pas pu être envoyée.'
      }
      : null
  ].filter(Boolean)
  const results = await Promise.allSettled(
    notifications.map(async notification => notification.run())
  )
  const warnings = results
    .map((result, index) => result.status === 'rejected' ? notifications[index].warning : null)
    .filter(Boolean)
  const agent = await getAdminAgent(user.id, {client, now})

  return warnings.length > 0 ? {...agent, warnings} : agent
}
