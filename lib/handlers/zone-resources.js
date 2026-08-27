import {Buffer} from 'node:buffer'

import createHttpError from 'http-errors'
import ExcelJS from 'exceljs'
import Joi from 'joi'

import {prisma} from '../../db/prisma.js'
import {stageAuditMutation} from '../audit/mutations.js'
import {ZONE_PERMISSION_CODES} from '../constants/zone-permissions.js'
import {activeWindowWhere, getPointPrelevement} from '../models/point-prelevement.js'
import {defaultExploitationInclude, getExploitation} from '../models/exploitation.js'
import {
  createPointPrelevement,
  decoratePointPrelevement,
  decoratePointsPrelevement,
  deletePointPrelevement,
  updatePointPrelevement
} from '../services/point-prelevement.js'
import {
  createExploitation,
  decorateExploitation,
  deleteExploitation,
  updateExploitation
} from '../services/exploitation.js'
import {getEffectiveDeclarantUserIdsByZone} from '../services/zone-permissions.js'
import {
  getRootWaterUseCode,
  getWaterUse,
  legacyUsageToRootUsageCode,
  normalizeWaterUseCode
} from '../constants/sandre-water-uses.js'
import {
  getExploitationWaterUses,
  serializeExploitationUsageFields
} from '../services/exploitation-usages.js'
import {
  rankExploitationIds,
  rankPointIds,
  rankScopedDeclarantIds,
  rankScopedPointIds
} from '../services/smart-search.js'
import {
  getDeclarationPeriodKey,
  getDeclarationPeriodKeysBetween,
  getDeclarationPeriodLabel,
  getDeclarationPeriodStart,
  getNextDeclarationPeriodStart,
  parseDeclarationPeriodKey,
  parseDeclarationPeriodType
} from '../util/declaration-periods.js'
import {
  getPrimaryDeclarantContactEmail,
  hasDeclarantContactEmail,
  serializeDeclarantContactEmails
} from '../services/declarant-contact-emails.js'

const uuidSchema = Joi.string().guid({version: 'uuidv4'}).required()
const DEFAULT_PAGE = 1
const DEFAULT_PER_PAGE = 20
const MAX_PER_PAGE = 100
const DEFAULT_MATRIX_PERIODS = 12
const MAX_MATRIX_PERIODS = 36
const PERIOD_TYPES_BY_PRIORITY = new Map([
  ['month', 1],
  ['week', 2]
])
const PERIOD_TYPE_FROM_DB = new Map([
  ['MONTH', 'month'],
  ['WEEK', 'week']
])

const STATUS_VALUES = new Set(['EN_ACTIVITE', 'NON_RENSEIGNE', 'ABANDONNEE', 'TERMINEE'])
const DECLARANT_ROLE_VALUES = new Set(['PRELEVEUR', 'COLLECTEUR'])
const COLLECTEUR_FILTER_VALUES = new Set(['WITH_COLLECTEUR', 'WITHOUT_COLLECTEUR'])
const EMAIL_FILTER_VALUES = new Set(['WITH_EMAIL', 'WITHOUT_EMAIL'])
const CONNECTOR_FILTER_VALUES = new Set(['WITH_CONNECTOR', 'WITHOUT_CONNECTOR'])
const DECLARANT_TYPE_VALUES = new Set(['NATURAL_PERSON', 'LEGAL_PERSON'])
const PRELEVEUR_TYPE_VALUES = new Set(['ICPE', 'IRRIGANT', 'GESTIONNAIRE_AEP', 'AUTRE'])
const WATER_BODY_TYPE_VALUES = new Set(['SUPERFICIELLE', 'SOUTERRAIN', 'TRANSITION'])
const FLOW_TYPE_VALUES = new Set(['PRELEVEMENT', 'REJET'])
const ACTIVITY_RANGE_VALUES = new Set([
  'NEVER',
  'LT_30_DAYS',
  'DAYS_30_90',
  'DAYS_91_365',
  'GT_365_DAYS'
])
const LIST_SORT_VALUES = new Set([
  'RELEVANCE',
  'NAME',
  'LAST_DECLARATION',
  'CREATED_AT'
])
const LIST_ORDER_VALUES = new Set(['ASC', 'DESC'])
const DAY_IN_MS = 24 * 60 * 60 * 1000
const FACET_LABELS = Object.freeze({
  PRELEVEUR: 'Préleveur',
  COLLECTEUR: 'Collecteur',
  NATURAL_PERSON: 'Personne physique',
  LEGAL_PERSON: 'Personne morale',
  ICPE: 'ICPE',
  IRRIGANT: 'Irrigant',
  GESTIONNAIRE_AEP: 'Gestionnaire AEP',
  AUTRE: 'Autre',
  WITH_EMAIL: 'Avec email',
  WITHOUT_EMAIL: 'Sans email',
  WITH_COLLECTEUR: 'Avec collecteur',
  WITHOUT_COLLECTEUR: 'Sans collecteur',
  WITH_CONNECTOR: 'Avec connecteur',
  WITHOUT_CONNECTOR: 'Sans connecteur',
  NEVER: 'Aucune déclaration',
  LT_30_DAYS: 'Moins de 30 jours',
  DAYS_30_90: 'De 30 à 90 jours',
  DAYS_91_365: 'De 91 jours à un an',
  GT_365_DAYS: 'Plus d’un an',
  SUPERFICIELLE: 'Eau superficielle',
  SOUTERRAIN: 'Eau souterraine',
  TRANSITION: 'Eau de transition',
  PRELEVEMENT: 'Prélèvement',
  REJET: 'Rejet',
  EN_ACTIVITE: 'En activité',
  NON_RENSEIGNE: 'Non renseignée',
  ABANDONNEE: 'Abandonnée',
  TERMINEE: 'Terminée'
})
const STATUS_SEARCH_ALIASES = new Map([
  ['EN ACTIVITE', 'EN_ACTIVITE'],
  ['EN ACTIVITÉ', 'EN_ACTIVITE'],
  ['ACTIVE', 'EN_ACTIVITE'],
  ['ACTIF', 'EN_ACTIVITE'],
  ['ACTIFS', 'EN_ACTIVITE'],
  ['TERMINEE', 'TERMINEE'],
  ['TERMINÉE', 'TERMINEE'],
  ['TERMINE', 'TERMINEE'],
  ['TERMINÉ', 'TERMINEE'],
  ['ABANDONNEE', 'ABANDONNEE'],
  ['ABANDONNÉE', 'ABANDONNEE'],
  ['ABANDONNE', 'ABANDONNEE'],
  ['ABANDONNÉ', 'ABANDONNEE'],
  ['NON RENSEIGNE', 'NON_RENSEIGNE'],
  ['NON RENSEIGNÉ', 'NON_RENSEIGNE']
])

const DECLARANT_ROLE_ALIASES = new Map([
  ['PRELEVEUR', 'PRELEVEUR'],
  ['PRÉLEVEUR', 'PRELEVEUR'],
  ['PRELEVEURS', 'PRELEVEUR'],
  ['PRÉLEVEURS', 'PRELEVEUR'],
  ['COLLECTEUR', 'COLLECTEUR'],
  ['COLLECTEURS', 'COLLECTEUR']
])

function validateUuid(value, label) {
  const {error, value: uuid} = uuidSchema.validate(value)

  if (error) {
    throw createHttpError(400, `${label} invalide.`)
  }

  return uuid
}

function isGlobalAdmin(user) {
  return user?.role === 'ADMIN'
}

function optionalText(value) {
  if (value === undefined || value === null) {
    return null
  }

  const trimmed = String(value).trim()
  return trimmed || null
}

function parsePositiveInteger(value, fallback, {max = Number.MAX_SAFE_INTEGER} = {}) {
  const parsed = Number.parseInt(value, 10)

  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback
  }

  return Math.min(parsed, max)
}

function normalizeEnumSearch(value) {
  return String(value || '')
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036F]/g, '')
    .toUpperCase()
    .replaceAll(/[^A-Z\d]+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
}

function getStatusSearch(value) {
  const normalized = normalizeEnumSearch(value)
  const spaced = String(value || '').trim().toUpperCase()

  if (STATUS_VALUES.has(normalized)) {
    return normalized
  }

  return STATUS_SEARCH_ALIASES.get(spaced) ?? null
}

function getDeclarantRoleSearch(value) {
  const normalized = normalizeEnumSearch(value)

  if (DECLARANT_ROLE_VALUES.has(normalized)) {
    return normalized
  }

  return DECLARANT_ROLE_ALIASES.get(String(value || '').trim().toUpperCase()) ?? null
}

function getCollecteurFilter(value) {
  const normalized = normalizeEnumSearch(value)

  if (COLLECTEUR_FILTER_VALUES.has(normalized)) {
    return normalized
  }

  if (['AVEC_COLLECTEUR', 'AVEC_COLLECTEURS'].includes(normalized)) {
    return 'WITH_COLLECTEUR'
  }

  if (['SANS_COLLECTEUR', 'SANS_COLLECTEURS'].includes(normalized)) {
    return 'WITHOUT_COLLECTEUR'
  }

  return null
}

function getEmailFilter(value) {
  const normalized = normalizeEnumSearch(value)

  if (EMAIL_FILTER_VALUES.has(normalized)) {
    return normalized
  }

  if (['AVEC_EMAIL', 'AVEC_MAIL'].includes(normalized)) {
    return 'WITH_EMAIL'
  }

  if (['SANS_EMAIL', 'SANS_MAIL'].includes(normalized)) {
    return 'WITHOUT_EMAIL'
  }

  return null
}

function getConnectorFilter(value) {
  const normalized = normalizeEnumSearch(value)

  if (CONNECTOR_FILTER_VALUES.has(normalized)) {
    return normalized
  }

  if (['AVEC_CONNECTEUR', 'AVEC_CONNECTEURS'].includes(normalized)) {
    return 'WITH_CONNECTOR'
  }

  if (['SANS_CONNECTEUR', 'SANS_CONNECTEURS'].includes(normalized)) {
    return 'WITHOUT_CONNECTOR'
  }

  return null
}

function getUsageSearch(value) {
  return legacyUsageToRootUsageCode(value) ?? normalizeWaterUseCode(value)
}

function queryValues(value) {
  return (Array.isArray(value) ? value : [value])
    .flatMap(item => String(item ?? '').split(','))
    .map(item => item.trim())
    .filter(Boolean)
}

function parseEnumList(value, allowedValues, normalize = normalizeEnumSearch) {
  return [...new Set(queryValues(value)
    .map(item => normalize(item))
    .filter(item => item && allowedValues.has(item)))]
}

function parseUsageList(value) {
  return [...new Set(queryValues(value).map(getUsageSearch).filter(Boolean))]
}

function parseEnum(value, allowedValues) {
  const [item] = parseEnumList(value, allowedValues)
  return item ?? null
}

export function parseListQuery(query = {}) {
  const page = parsePositiveInteger(query.page, DEFAULT_PAGE)
  const perPage = parsePositiveInteger(
    query.pageSize ?? query.perPage,
    DEFAULT_PER_PAGE,
    {max: MAX_PER_PAGE}
  )
  const search = (optionalText(query.query ?? query.search) || '').slice(0, 200)
  const exploitationStatuses = parseEnumList(
    query.exploitationStatuses ?? query.status,
    STATUS_VALUES,
    getStatusSearch
  )
  const usageCodes = parseUsageList(query.usageCodes ?? query.usage)
  const collecteurStatus = getCollecteurFilter(
    query.collecteurStatus ?? query.collecteur ?? query.collector
  )
  const emailStatus = getEmailFilter(query.emailStatus ?? query.email)

  return {
    page,
    perPage,
    search,
    sort: parseEnum(query.sort, LIST_SORT_VALUES) ?? 'RELEVANCE',
    order: parseEnum(query.order, LIST_ORDER_VALUES) ?? 'DESC',
    filters: {
      declarantRole: getDeclarantRoleSearch(query.declarantRole ?? query.role),
      declarantType: parseEnum(query.declarantType, DECLARANT_TYPE_VALUES),
      preleveurTypes: parseEnumList(
        query.preleveurTypes ?? query.preleveurType,
        PRELEVEUR_TYPE_VALUES
      ),
      emailStatus,
      collecteurStatus,
      connectorStatus: getConnectorFilter(
        query.connectorStatus ?? query.connecteur ?? query.connector
      ),
      activityRange: parseEnum(query.activityRange, ACTIVITY_RANGE_VALUES),
      flowTypes: parseEnumList(query.flowTypes ?? query.flowType, FLOW_TYPE_VALUES),
      waterBodyTypes: parseEnumList(
        query.waterBodyTypes ?? query.waterBodyType,
        WATER_BODY_TYPE_VALUES
      ),
      usageCodes,
      exploitationStatuses,
      // Compatibilité avec les filtres historiques exposés dans `meta.filters`.
      status: exploitationStatuses[0] ?? null,
      usage: usageCodes[0] ?? null,
      collecteur: collecteurStatus,
      email: emailStatus
    },
    skip: (page - 1) * perPage,
    take: perPage
  }
}

function createPaginationMeta({
  page,
  perPage,
  total,
  totalAll,
  count,
  search,
  filters,
  sort,
  order
}) {
  return {
    page,
    perPage,
    total,
    totalAll,
    count,
    pages: Math.max(1, Math.ceil(total / perPage)),
    search: search || null,
    filters: filters || {},
    sort,
    order
  }
}

function sendPaginated(res, data, query, {facets = {}, total, totalAll}) {
  const meta = createPaginationMeta({
    page: query.page,
    perPage: query.perPage,
    total,
    totalAll,
    count: data.length,
    search: query.search,
    filters: query.filters,
    sort: query.sort,
    order: query.order
  })

  res.send({
    data,
    meta: Object.keys(facets).length > 0 ? {...meta, facets} : meta
  })
}

async function getZoneById(zoneId) {
  return prisma.zone.findUnique({
    where: {id: zoneId},
    select: {
      id: true,
      type: true,
      code: true,
      name: true
    }
  })
}

export async function getZoneRightOrThrow(user, zoneId, {permission} = {}) {
  if (isGlobalAdmin(user)) {
    const zone = await getZoneById(zoneId)

    if (!zone) {
      throw createHttpError(404, 'Cette zone est introuvable.')
    }

    return {
      zone,
      isAdmin: true,
      permissions: [],
      startDate: null,
      endDate: null
    }
  }

  const right = await prisma.instructorZone.findFirst({
    where: {
      instructorUserId: user.id,
      zoneId,
      ...activeWindowWhere(new Date(), {
        startNullable: false,
        endNullable: true
      })
    },
    include: {
      permissions: true,
      zone: {
        select: {
          id: true,
          type: true,
          code: true,
          name: true
        }
      }
    }
  })

  if (!right) {
    throw createHttpError(403, 'Vous n’avez pas accès à cette zone.')
  }

  if (permission && !right.permissions.some(item => item.permission === permission)) {
    throw createHttpError(403, 'Vous ne disposez pas de ce droit sur cette zone.')
  }

  return right
}

async function isPointInZone(pointPrelevementId, zoneId) {
  const point = await prisma.pointPrelevement.findFirst({
    where: {
      id: pointPrelevementId,
      deletedAt: null,
      zones: {
        some: {zoneId}
      }
    },
    select: {id: true}
  })

  return Boolean(point)
}

async function assertPointInZone(pointPrelevementId, zoneId) {
  const allowed = await isPointInZone(pointPrelevementId, zoneId)

  if (!allowed) {
    throw createHttpError(404, 'Ce point de prélèvement n’est pas rattaché à cette zone.')
  }
}

function getCoordinatesPair(coordinates) {
  if (
    !coordinates
    || coordinates.type !== 'Point'
    || !Array.isArray(coordinates.coordinates)
    || coordinates.coordinates.length !== 2
  ) {
    throw createHttpError(400, 'Les coordonnées du point sont invalides.')
  }

  const [longitude, latitude] = coordinates.coordinates

  if (
    typeof longitude !== 'number'
    || typeof latitude !== 'number'
    || !Number.isFinite(longitude)
    || !Number.isFinite(latitude)
    || longitude < -180
    || longitude > 180
    || latitude < -90
    || latitude > 90
  ) {
    throw createHttpError(400, 'Les coordonnées du point sont invalides.')
  }

  return {longitude, latitude}
}

async function assertCoordinatesInZone(zoneId, coordinates) {
  const {longitude, latitude} = getCoordinatesPair(coordinates)

  const rows = await prisma.$queryRaw`
    SELECT EXISTS (
      SELECT 1
      FROM "Zone"
      WHERE id = ${zoneId}::uuid
        AND ST_Intersects(
          coordinates,
          ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)
        )
    ) AS intersects
  `

  if (!rows?.[0]?.intersects) {
    throw createHttpError(
      400,
      'Les coordonnées du point doivent se situer dans la zone administrée.'
    )
  }
}

async function getPointInZone(zoneId, pointId) {
  await assertPointInZone(pointId, zoneId)
  return getPointPrelevement(pointId)
}

async function getExploitationInZone(zoneId, exploitationId) {
  const exploitation = await getExploitation(exploitationId)

  if (!exploitation) {
    return null
  }

  if (!await isPointInZone(exploitation.pointPrelevementId, zoneId)) {
    return null
  }

  return exploitation
}

async function decorateZoneExploitation(
  exploitation,
  user,
  {includeDeclarantDetails = true} = {}
) {
  if (!exploitation) {
    return null
  }

  const decorated = await decorateExploitation(exploitation, {user})

  if (!exploitation.declarant || !includeDeclarantDetails) {
    if (!includeDeclarantDetails) {
      return {
        ...decorated,
        declarant: null,
        collecteurs: (decorated.collecteurs ?? []).map(link => ({
          ...link,
          collecteur: null
        }))
      }
    }

    return decorated
  }

  const {user: declarantUser, ...declarantData} = exploitation.declarant

  return {
    ...decorated,
    declarant: {
      ...declarantData,
      ...declarantUser,
      id: declarantData.userId,
      userId: declarantData.userId,
      loginEmail: declarantUser.email ?? null,
      contactEmail: getPrimaryDeclarantContactEmail(exploitation.declarant),
      contactEmails: serializeDeclarantContactEmails(exploitation.declarant),
      user: declarantUser
    }
  }
}

function serializeDeclarantOption(item) {
  const user = item.user ?? item
  const declarant = item.declarant ?? item
  const userId = user.id ?? declarant.userId

  return {
    id: userId,
    userId,
    email: user.email ?? null,
    loginEmail: user.email ?? null,
    contactEmail: getPrimaryDeclarantContactEmail(item),
    contactEmails: serializeDeclarantContactEmails(item),
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    lastLoginAt: user.lastLoginAt ?? null,
    declarantType: declarant.declarantType ?? null,
    declarantRole: declarant.declarantRole ?? 'PRELEVEUR',
    preleveurType: declarant.preleveurType ?? null,
    socialReason: declarant.socialReason ?? null,
    civility: declarant.civility ?? null,
    siret: declarant.siret ?? null,
    city: declarant.city ?? null,
    phoneNumber: declarant.phoneNumber ?? null,
    declarant: declarant.declarant || {
      socialReason: declarant.socialReason ?? null,
      declarantType: declarant.declarantType ?? null,
      declarantRole: declarant.declarantRole ?? 'PRELEVEUR',
      preleveurType: declarant.preleveurType ?? null
    },
    user
  }
}

export async function listDeclarantOptionsForZone(zoneId, {client = prisma} = {}) {
  const declarantUserIdsByZone = await getEffectiveDeclarantUserIdsByZone(
    [zoneId],
    {client}
  )
  const declarantUserIds = declarantUserIdsByZone.get(zoneId) ?? []

  if (declarantUserIds.length === 0) {
    return []
  }

  const users = await client.user.findMany({
    where: {
      id: {in: declarantUserIds},
      role: 'DECLARANT',
      deletedAt: null
    },
    include: {
      declarant: {
        include: {contactEmails: true}
      }
    },
    orderBy: [
      {lastName: 'asc'},
      {firstName: 'asc'},
      {email: 'asc'}
    ]
  })

  return users.map(serializeDeclarantOption)
}

function pointInZoneWhere(zoneId) {
  return {
    deletedAt: null,
    zones: {
      some: {zoneId}
    }
  }
}

function getZonePointBaseWhere(zoneId) {
  return pointInZoneWhere(zoneId)
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))]
}

function getActivityRange(lastDeclarationAt, now = new Date()) {
  if (!lastDeclarationAt) {
    return 'NEVER'
  }

  const ageInDays = Math.max(
    0,
    Math.floor((now - new Date(lastDeclarationAt)) / DAY_IN_MS)
  )

  if (ageInDays < 30) {
    return 'LT_30_DAYS'
  }

  if (ageInDays <= 90) {
    return 'DAYS_30_90'
  }

  if (ageInDays <= 365) {
    return 'DAYS_91_365'
  }

  return 'GT_365_DAYS'
}

function matchesSelectedValues(actualValues, selectedValues) {
  return selectedValues.length === 0
    || actualValues.some(value => selectedValues.includes(value))
}

function matchesZoneListFilters(record, filters) {
  return (!filters.declarantRole || record.declarantRoles.includes(filters.declarantRole))
    && (!filters.declarantType || record.declarantTypes.includes(filters.declarantType))
    && (!filters.emailStatus || record.emailStatuses.includes(filters.emailStatus))
    && (!filters.activityRange || record.activityRanges.includes(filters.activityRange))
    && (!filters.collecteurStatus || record.collecteurStatus === filters.collecteurStatus)
    && (!filters.connectorStatus || record.connectorStatus === filters.connectorStatus)
    && matchesSelectedValues(record.preleveurTypes, filters.preleveurTypes)
    && matchesSelectedValues(record.flowTypes, filters.flowTypes)
    && matchesSelectedValues(record.waterBodyTypes, filters.waterBodyTypes)
    && matchesSelectedValues(record.usageCodes, filters.usageCodes)
    && matchesSelectedValues(
      record.exploitationStatuses,
      filters.exploitationStatuses
    )
}

function createFacet(records, getValues, getDetails = value => ({
  value,
  label: FACET_LABELS[value] ?? value
})) {
  const counts = new Map()
  const details = new Map()

  for (const record of records) {
    for (const value of uniqueValues(getValues(record))) {
      counts.set(value, (counts.get(value) ?? 0) + 1)
      details.set(value, getDetails(value, record))
    }
  }

  return [...counts.entries()]
    .map(([value, count]) => ({...details.get(value), value, count}))
    .sort((left, right) => left.label.localeCompare(right.label, 'fr'))
}

function createZoneListFacets(records, {
  includeDeclarantDetails = false,
  includeDeclarationDetails = false,
  includeExploitationDetails = false,
  includePointDetails = false
} = {}) {
  return {
    ...(includeDeclarantDetails
      ? {
        roles: createFacet(records, record => record.declarantRoles),
        declarantTypes: createFacet(records, record => record.declarantTypes),
        preleveurTypes: createFacet(records, record => record.preleveurTypes),
        emailStatuses: createFacet(records, record => record.emailStatuses)
      }
      : {}),
    ...(includeDeclarationDetails
      ? {activityRanges: createFacet(records, record => record.activityRanges)}
      : {}),
    ...(includePointDetails
      ? {
        flowTypes: createFacet(records, record => record.flowTypes),
        waterBodyTypes: createFacet(records, record => record.waterBodyTypes)
      }
      : {}),
    ...(includeExploitationDetails
      ? {
        collecteurStatuses: createFacet(records, record => [record.collecteurStatus]),
        connectorStatuses: createFacet(records, record => [record.connectorStatus]),
        usageCodes: createFacet(
          records,
          record => record.usageCodes,
          (value, record) => ({
            value,
            label: record.usageDetails.get(value)?.label ?? value
          })
        ),
        exploitationStatuses: createFacet(
          records,
          record => record.exploitationStatuses
        )
      }
      : {})
  }
}

export function getZoneListCapabilities(user, right) {
  if (isGlobalAdmin(user)) {
    return {
      canReadDeclarants: true,
      canReadExploitations: true,
      canReadPointDetails: true
    }
  }

  const permissions = new Set(
    (right?.permissions ?? []).map(item => item.permission ?? item)
  )

  return {
    canReadDeclarants: permissions.has('declarant.list'),
    canReadExploitations: permissions.has('exploitation.list'),
    canReadPointDetails: permissions.has('pp.detail.read')
  }
}

export function scopeZoneListQuery(query, {
  canReadDeclarants,
  canReadExploitations
}) {
  const filters = {...query.filters}

  if (!canReadDeclarants) {
    filters.declarantRole = null
    filters.declarantType = null
    filters.preleveurTypes = []
    filters.emailStatus = null
    filters.email = null
    filters.activityRange = null
  }

  if (!canReadExploitations) {
    filters.collecteurStatus = null
    filters.collecteur = null
    filters.connectorStatus = null
    filters.usageCodes = []
    filters.usage = null
    filters.exploitationStatuses = []
    filters.status = null
  }

  return {...query, filters}
}

export function normalizeZoneExploitationListQuery(query) {
  return query.sort === 'RELEVANCE' && !query.search
    ? {...query, sort: 'CREATED_AT'}
    : query
}

function compareNullableDates(left, right, order) {
  const leftTime = left ? new Date(left).getTime() : null
  const rightTime = right ? new Date(right).getTime() : null

  if (leftTime === null) {
    return rightTime === null ? 0 : 1
  }

  if (rightTime === null) {
    return -1
  }

  return order === 'ASC' ? leftTime - rightTime : rightTime - leftTime
}

function sortZoneListRecords(records, query, {fallback = 'NAME'} = {}) {
  const collator = new Intl.Collator('fr', {numeric: true, sensitivity: 'base'})
  const sort = query.sort === 'RELEVANCE' && !query.search ? fallback : query.sort

  return [...records].sort((left, right) => {
    if (sort === 'LAST_DECLARATION') {
      const dateOrder = compareNullableDates(
        left.lastDeclarationAt,
        right.lastDeclarationAt,
        query.order
      )

      if (dateOrder !== 0) {
        return dateOrder
      }
    }

    if (sort === 'CREATED_AT') {
      const createdOrder = compareNullableDates(
        left.createdAt,
        right.createdAt,
        query.order
      )

      if (createdOrder !== 0) {
        return createdOrder
      }
    }

    return collator.compare(left.label, right.label) || left.id.localeCompare(right.id)
  })
}

async function filterAndRankZoneListRecords(
  records,
  query,
  rank,
  {fallback = 'NAME'} = {}
) {
  const filtered = records.filter(record => matchesZoneListFilters(record, query.filters))

  if (!query.search) {
    return sortZoneListRecords(filtered, query, {fallback})
  }

  const ranked = await rank(filtered.map(record => record.id), query.search)
  const relevanceById = new Map(ranked.map(item => [item.id, Number(item.relevance)]))
  const matched = filtered.filter(record => relevanceById.has(record.id))

  if (query.sort !== 'RELEVANCE') {
    return sortZoneListRecords(matched, query, {fallback})
  }

  return matched.sort((left, right) =>
    relevanceById.get(right.id) - relevanceById.get(left.id)
    || left.label.localeCompare(right.label, 'fr', {sensitivity: 'base'})
    || left.id.localeCompare(right.id))
}

function pageRecordIds(records, query) {
  return records.slice(query.skip, query.skip + query.take).map(record => record.id)
}

function orderItemsByIds(items, ids) {
  const byId = new Map(items.map(item => [item.id ?? item.userId, item]))
  return ids.map(id => byId.get(id)).filter(Boolean)
}

function createUsageDetails(exploitations) {
  const details = new Map()

  for (const exploitation of exploitations) {
    for (const usage of getExploitationWaterUses(exploitation)) {
      if (!usage?.code) {
        continue
      }

      const code = getRootWaterUseCode(usage.code)

      if (code) {
        details.set(code, getWaterUse(code) ?? usage)
      }
    }
  }

  return details
}

function createPointSearchRecord(point, now = new Date()) {
  const exploitations = point.declarants ?? []
  const declarants = exploitations.map(item => item.declarant).filter(Boolean)
  const usageDetails = createUsageDetails(exploitations)

  return {
    id: point.id,
    label: point.usageName || point.name,
    createdAt: point.createdAt,
    lastDeclarationAt: declarants
      .map(declarant => declarant.lastDeclarationAt)
      .filter(Boolean)
      .sort((left, right) => new Date(right) - new Date(left))[0] ?? null,
    declarantRoles: uniqueValues(declarants.map(item => item.declarantRole)),
    declarantTypes: uniqueValues(declarants.map(item => item.declarantType)),
    preleveurTypes: uniqueValues(declarants.map(item => item.preleveurType)),
    emailStatuses: uniqueValues(declarants.map(item =>
      hasDeclarantContactEmail(item) ? 'WITH_EMAIL' : 'WITHOUT_EMAIL')),
    activityRanges: uniqueValues(declarants.map(item =>
      getActivityRange(item.lastDeclarationAt, now))),
    flowTypes: [point.flowType],
    waterBodyTypes: [point.waterBodyType],
    usageCodes: [...usageDetails.keys()],
    usageDetails,
    exploitationStatuses: uniqueValues(exploitations.map(item => item.status)),
    collecteurStatus: exploitations.some(item => item.collecteurs.length > 0)
      ? 'WITH_COLLECTEUR'
      : 'WITHOUT_COLLECTEUR',
    connectorStatus: exploitations.some(item => item.connectors.length > 0)
      ? 'WITH_CONNECTOR'
      : 'WITHOUT_CONNECTOR'
  }
}

function createExploitationSearchRecord(exploitation, now = new Date()) {
  const {declarant, pointPrelevement: point} = exploitation
  const usageDetails = createUsageDetails([exploitation])

  return {
    id: exploitation.id,
    label: `${point?.usageName || point?.name || ''} ${preleveurLabel(declarant)}`.trim(),
    createdAt: exploitation.createdAt,
    lastDeclarationAt: declarant?.lastDeclarationAt ?? null,
    declarantRoles: uniqueValues([declarant?.declarantRole]),
    declarantTypes: uniqueValues([declarant?.declarantType]),
    preleveurTypes: uniqueValues([declarant?.preleveurType]),
    emailStatuses: [hasDeclarantContactEmail(declarant) ? 'WITH_EMAIL' : 'WITHOUT_EMAIL'],
    activityRanges: [getActivityRange(declarant?.lastDeclarationAt, now)],
    flowTypes: uniqueValues([point?.flowType]),
    waterBodyTypes: uniqueValues([point?.waterBodyType]),
    usageCodes: [...usageDetails.keys()],
    usageDetails,
    exploitationStatuses: uniqueValues([exploitation.status]),
    collecteurStatus: exploitation.collecteurs.length > 0
      ? 'WITH_COLLECTEUR'
      : 'WITHOUT_COLLECTEUR',
    connectorStatus: exploitation.connectors.length > 0
      ? 'WITH_CONNECTOR'
      : 'WITHOUT_CONNECTOR'
  }
}

function createDeclarantSearchRecord(user, now = new Date()) {
  const declarant = user.declarant ?? {}
  const directExploitations = declarant.pointPrelevements ?? []
  const managedExploitations = (declarant.collecteurExploitations ?? [])
    .map(item => item.exploitation)
    .filter(Boolean)
  const exploitations = [...directExploitations, ...managedExploitations]
  const usageDetails = createUsageDetails(exploitations)

  return {
    id: user.id,
    label: declarant.socialReason
      || [user.firstName, user.lastName].filter(Boolean).join(' ')
      || getPrimaryDeclarantContactEmail(user)
      || 'Déclarant sans nom',
    createdAt: user.createdAt,
    lastDeclarationAt: declarant.lastDeclarationAt ?? null,
    declarantRoles: uniqueValues([declarant.declarantRole ?? 'PRELEVEUR']),
    declarantTypes: uniqueValues([declarant.declarantType]),
    preleveurTypes: uniqueValues([declarant.preleveurType]),
    emailStatuses: [hasDeclarantContactEmail(user) ? 'WITH_EMAIL' : 'WITHOUT_EMAIL'],
    activityRanges: [getActivityRange(declarant.lastDeclarationAt, now)],
    flowTypes: uniqueValues(exploitations.map(item => item.pointPrelevement?.flowType)),
    waterBodyTypes: uniqueValues(
      exploitations.map(item => item.pointPrelevement?.waterBodyType)
    ),
    usageCodes: [...usageDetails.keys()],
    usageDetails,
    exploitationStatuses: uniqueValues(exploitations.map(item => item.status)),
    collecteurStatus: directExploitations.some(item => item.collecteurs?.length > 0)
      ? 'WITH_COLLECTEUR'
      : 'WITHOUT_COLLECTEUR',
    connectorStatus: exploitations.some(item => item.connectors?.length > 0)
      ? 'WITH_CONNECTOR'
      : 'WITHOUT_CONNECTOR'
  }
}

function createDeclarantSearchScope(user) {
  return {
    declarantId: user.id,
    exploitationIds: uniqueValues([
      ...(user.declarant?.pointPrelevements ?? []).map(exploitation => exploitation.id),
      ...(user.declarant?.collecteurExploitations ?? [])
        .map(link => link.exploitation?.id)
    ])
  }
}

function getZoneExploitationBaseWhere(zoneId) {
  return {
    pointPrelevement: pointInZoneWhere(zoneId),
    declarant: {
      declarantRole: 'PRELEVEUR',
      user: {
        deletedAt: null
      }
    }
  }
}

export function getZoneDeclarantBaseWhere(declarantUserIds = [], declarantRole = null) {
  return {
    id: {in: [...new Set(declarantUserIds)]},
    role: 'DECLARANT',
    deletedAt: null,
    ...(declarantRole ? {declarant: {declarantRole}} : {})
  }
}

export function getZoneDeclarantInclude(zoneId, {includeExploitations = true} = {}) {
  if (!includeExploitations) {
    return {
      declarant: {
        include: {contactEmails: true}
      }
    }
  }

  return {
    declarant: {
      include: {
        contactEmails: true,
        pointPrelevements: {
          where: {
            pointPrelevement: pointInZoneWhere(zoneId)
          },
          include: {
            pointPrelevement: {
              select: {
                id: true,
                name: true,
                usageName: true,
                flowType: true,
                waterBodyType: true
              }
            },
            usage: true,
            secondaryUsageLinks: {
              include: {usage: true},
              orderBy: {usageId: 'asc'}
            },
            connectors: {
              select: {id: true}
            },
            collecteurs: {
              where: {
                collecteur: {
                  user: {deletedAt: null}
                }
              },
              include: {
                collecteur: {
                  include: {
                    user: true,
                    contactEmails: true
                  }
                }
              },
              orderBy: {
                createdAt: 'asc'
              }
            }
          },
          orderBy: {
            createdAt: 'asc'
          }
        },
        collecteurExploitations: {
          where: {
            exploitation: {
              pointPrelevement: pointInZoneWhere(zoneId)
            }
          },
          include: {
            exploitation: {
              include: {
                pointPrelevement: {
                  select: {
                    id: true,
                    name: true,
                    usageName: true,
                    flowType: true,
                    waterBodyType: true
                  }
                },
                usage: true,
                secondaryUsageLinks: {
                  include: {usage: true},
                  orderBy: {usageId: 'asc'}
                },
                connectors: {
                  select: {id: true}
                },
                collecteurs: {
                  where: {
                    collecteur: {
                      user: {deletedAt: null}
                    }
                  },
                  select: {id: true}
                },
                declarant: {
                  include: {
                    user: true,
                    contactEmails: true
                  }
                }
              }
            }
          },
          orderBy: {
            createdAt: 'asc'
          }
        }
      }
    }
  }
}

function preleveurLabel(declarant) {
  const user = declarant?.user
  const socialReason = optionalText(declarant?.socialReason)

  if (socialReason) {
    return socialReason
  }

  return [user?.firstName, user?.lastName].filter(Boolean).join(' ')
    || getPrimaryDeclarantContactEmail(declarant)
    || 'Préleveur sans nom'
}

function collecteurLabel(collecteur) {
  const user = collecteur?.user
  const socialReason = optionalText(collecteur?.socialReason)

  if (socialReason) {
    return socialReason
  }

  return [user?.firstName, user?.lastName].filter(Boolean).join(' ')
    || getPrimaryDeclarantContactEmail(collecteur)
    || 'Collecteur sans nom'
}

function normalizeCollecteurLink(link) {
  const {collecteur} = link

  if (!collecteur) {
    return null
  }

  return {
    id: link.id,
    collecteurUserId: collecteur.userId,
    label: collecteurLabel(collecteur),
    email: collecteur.user?.email ?? null,
    loginEmail: collecteur.user?.email ?? null,
    contactEmail: getPrimaryDeclarantContactEmail(collecteur),
    contactEmails: serializeDeclarantContactEmails(collecteur),
    firstName: collecteur.user?.firstName ?? null,
    lastName: collecteur.user?.lastName ?? null,
    lastLoginAt: collecteur.user?.lastLoginAt ?? null,
    socialReason: collecteur.socialReason ?? null
  }
}

function normalizeZoneDeclarant(user, zoneId) {
  const declarant = user.declarant ?? {}
  const directPoints = (declarant.pointPrelevements ?? [])
    .map(link => {
      const serialized = serializeExploitationUsageFields(link)

      return {
        id: link.pointPrelevement?.id,
        name: link.pointPrelevement?.name,
        exploitationId: link.id,
        status: link.status,
        startDate: link.startDate,
        endDate: link.endDate,
        usage: serialized.usage,
        secondaryUsages: serialized.secondaryUsages,
        collecteurs: (link.collecteurs ?? []).map(normalizeCollecteurLink).filter(Boolean)
      }
    })
    .filter(point => point.id)

  const collecteurExploitations = (declarant.collecteurExploitations ?? [])
    .map(link => {
      const {exploitation} = link
      const point = exploitation?.pointPrelevement
      const preleveur = exploitation?.declarant
      const serialized = serializeExploitationUsageFields(exploitation)

      return {
        id: link.id,
        exploitationId: exploitation?.id,
        pointPrelevementId: point?.id,
        pointName: point?.name,
        status: exploitation?.status,
        startDate: exploitation?.startDate,
        endDate: exploitation?.endDate,
        usage: serialized.usage,
        secondaryUsages: serialized.secondaryUsages,
        preleveurUserId: preleveur?.userId,
        preleveurLabel: preleveurLabel(preleveur),
        preleveurLastLoginAt: preleveur?.user?.lastLoginAt ?? null,
        createdAt: link.createdAt,
        updatedAt: link.updatedAt
      }
    })
    .filter(link => link.exploitationId && link.pointPrelevementId)

  const pointsById = new Map()

  for (const point of directPoints) {
    pointsById.set(point.id, point)
  }

  for (const link of collecteurExploitations) {
    if (!pointsById.has(link.pointPrelevementId)) {
      pointsById.set(link.pointPrelevementId, {
        id: link.pointPrelevementId,
        name: link.pointName,
        exploitationId: link.exploitationId,
        status: link.status,
        startDate: link.startDate,
        endDate: link.endDate,
        usage: link.usage ?? null,
        secondaryUsages: link.secondaryUsages ?? [],
        collecteurs: []
      })
    }
  }

  const points = [...pointsById.values()]
    .filter(point => point.id)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'fr'))

  return {
    id: user.id,
    userId: user.id,
    email: user.email,
    loginEmail: user.email,
    contactEmail: getPrimaryDeclarantContactEmail(user),
    contactEmails: serializeDeclarantContactEmails(user),
    firstName: user.firstName,
    lastName: user.lastName,
    lastLoginAt: user.lastLoginAt,
    declarantType: declarant.declarantType,
    declarantRole: declarant.declarantRole ?? 'PRELEVEUR',
    preleveurType: declarant.preleveurType ?? null,
    civility: declarant.civility,
    socialReason: declarant.socialReason,
    siret: declarant.siret,
    phoneNumber: declarant.phoneNumber,
    city: declarant.city,
    declarant: {
      socialReason: declarant.socialReason,
      declarantType: declarant.declarantType,
      declarantRole: declarant.declarantRole ?? 'PRELEVEUR',
      preleveurType: declarant.preleveurType ?? null,
      _count: {
        pointPrelevements: directPoints.length,
        collecteurExploitations: collecteurExploitations.length
      }
    },
    zoneId,
    points,
    collecteurExploitations
  }
}

function parseMatrixToPeriod(value, periodType) {
  const raw = optionalText(value)

  if (!raw) {
    return getDeclarationPeriodKey(periodType)
  }

  const periodKey = parseDeclarationPeriodKey(raw, periodType)

  if (!periodKey) {
    throw createHttpError(400, 'Le paramètre "to" est invalide pour ce type de période.')
  }

  return periodKey
}

function createPeriodDescriptor(periodType, periodKey) {
  const start = getDeclarationPeriodStart(periodType, periodKey)
  const end = new Date(getNextDeclarationPeriodStart(periodType, periodKey).getTime() - 1)

  return {
    key: periodKey,
    periodType,
    label: periodType === 'week'
      ? periodKey
      : start.toLocaleDateString('fr-FR', {month: 'short', year: '2-digit', timeZone: 'UTC'}),
    fullLabel: getDeclarationPeriodLabel(periodType, periodKey),
    start,
    end
  }
}

function getPreviousMatrixPeriodKey(periodType, periodKey) {
  const start = getDeclarationPeriodStart(periodType, periodKey)
  const previous = new Date(start)

  if (periodType === 'week') {
    previous.setUTCDate(previous.getUTCDate() - 7)
  } else {
    previous.setUTCMonth(previous.getUTCMonth() - 1)
  }

  return getDeclarationPeriodKey(periodType, previous)
}

function buildPeriodDescriptors({to, periodType, periodsCount}) {
  let periodKey = parseMatrixToPeriod(to, periodType)
  const periods = []

  for (let index = 0; index < periodsCount; index++) {
    periods.unshift(createPeriodDescriptor(periodType, periodKey))

    periodKey = getPreviousMatrixPeriodKey(periodType, periodKey)
  }

  return periods
}

function parseMatrixQuery(query = {}) {
  const selectedPeriodKey = optionalText(query.periodKey)

  if (selectedPeriodKey) {
    const periodType = parseDeclarationPeriodType(query.periodType)
    const periodKey = parseDeclarationPeriodKey(selectedPeriodKey, periodType)

    if (!periodKey) {
      throw createHttpError(400, 'La période sélectionnée est invalide.')
    }

    const periods = [createPeriodDescriptor(periodType, periodKey)]

    return {
      periodType,
      periodMode: 'selected',
      periods,
      periodsCount: 1,
      from: periodKey,
      to: periodKey,
      fromDate: periods[0].start,
      toDate: periods[0].end
    }
  }

  const periodsCount = parsePositiveInteger(
    query.periodCount ?? query.periods ?? query.months,
    DEFAULT_MATRIX_PERIODS,
    {max: MAX_MATRIX_PERIODS}
  )
  const periods = buildPeriodDescriptors({
    to: query.to,
    periodType: 'month',
    periodsCount
  })

  return {
    periodType: 'mixed',
    periodMode: 'expected',
    periods,
    periodsCount,
    from: periods[0].key,
    to: periods.at(-1).key,
    fromDate: periods[0].start,
    toDate: periods.at(-1).end
  }
}

function dateOrNull(value) {
  if (!value) {
    return null
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function overlapsPeriod(range, period) {
  const start = dateOrNull(range.startDate ?? range.minDate)
  const end = dateOrNull(range.endDate ?? range.maxDate)

  if (start && start > period.end) {
    return false
  }

  if (end && end < period.start) {
    return false
  }

  return true
}

function fromDbPeriodType(periodType) {
  return PERIOD_TYPE_FROM_DB.get(periodType) ?? 'month'
}

function getPeriodTypePriority(periodType) {
  return PERIOD_TYPES_BY_PRIORITY.get(periodType) ?? 0
}

function getZoneExpectedPeriodType(zone, period) {
  const override = (zone.declarationOverrides ?? [])
    .find(item => overlapsPeriod(item, period))

  return override
    ? fromDbPeriodType(override.periodType)
    : fromDbPeriodType(zone.declarationSettings?.defaultPeriodType ?? 'MONTH')
}

function getExpectedPeriodTypeForExploitation(exploitation, period) {
  const zones = (exploitation.pointPrelevement?.zones ?? [])
    .map(link => link.zone)
    .filter(Boolean)

  if (zones.length === 0) {
    return null
  }

  return zones
    .map(zone => getZoneExpectedPeriodType(zone, period))
    .sort((a, b) => getPeriodTypePriority(b) - getPeriodTypePriority(a))[0] ?? null
}

function isPeriodTypeExpectedForExploitation(exploitation, period) {
  return getExpectedPeriodTypeForExploitation(exploitation, period) === period.periodType
}

function isExploitationExpectedForPeriod(exploitation, period) {
  if (exploitation.status === 'ABANDONNEE') {
    return false
  }

  return overlapsPeriod(exploitation, period)
}

function isDeclarationExpectedForMatrixPeriod(exploitation, period) {
  return isExploitationExpectedForPeriod(exploitation, period)
    && isPeriodTypeExpectedForExploitation(exploitation, period)
}

function shouldIncludePeriod(exploitations, period) {
  return exploitations.some(exploitation => isDeclarationExpectedForMatrixPeriod(exploitation, period))
}

function buildExpectedMatrixPeriods({exploitations, basePeriods}) {
  const periodsByKey = new Map()

  for (const monthPeriod of basePeriods) {
    if (shouldIncludePeriod(exploitations, monthPeriod)) {
      periodsByKey.set(monthPeriod.key, monthPeriod)
    }

    const weekKeys = getDeclarationPeriodKeysBetween('week', monthPeriod.start, monthPeriod.end)

    for (const weekKey of weekKeys) {
      const weekPeriod = createPeriodDescriptor('week', weekKey)

      if (shouldIncludePeriod(exploitations, weekPeriod)) {
        periodsByKey.set(weekPeriod.key, weekPeriod)
      }
    }
  }

  const periods = [...periodsByKey.values()]
    .sort((a, b) => a.start - b.start || getPeriodTypePriority(a.periodType) - getPeriodTypePriority(b.periodType))

  return periods.length > 0 ? periods : basePeriods
}

function declarationActorLabel(actor) {
  if (!actor) {
    return null
  }

  const user = actor.user ?? actor
  const socialReason = optionalText(actor.socialReason)

  if (socialReason) {
    return socialReason
  }

  return [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || null
}

function normalizeDeclarationForCell(declaration, globalInstructionStatus) {
  return {
    id: declaration.id,
    code: declaration.code,
    createdAt: declaration.createdAt,
    createdByDeclarantUserId: declaration.createdByDeclarantUserId,
    createdByDeclarantLabel: declarationActorLabel(declaration.createdByDeclarant),
    globalInstructionStatus
  }
}

function addDeclarationToPeriodIndex(index, {key, declaration}) {
  const current = index.get(key) ?? new Map()
  current.set(declaration.id, declaration)
  index.set(key, current)
}

function createDeclarationIndex(chunks, periods) {
  const declarationIndex = new Map()

  for (const chunk of chunks) {
    const declaration = chunk.source?.declaration

    if (!declaration || !chunk.pointPrelevementId) {
      continue
    }

    for (const period of periods) {
      if (!overlapsPeriod(chunk, period)) {
        continue
      }

      const key = `${chunk.pointPrelevementId}:${period.key}`
      addDeclarationToPeriodIndex(declarationIndex, {
        key,
        declaration: normalizeDeclarationForCell(declaration, chunk.source?.globalInstructionStatus)
      })
    }
  }

  return declarationIndex
}

function getCellStatus({declarations, isExpected}) {
  if (!isExpected) {
    return 'INACTIVE'
  }

  return declarations.length > 0 ? 'DECLARED' : 'MISSING'
}

function incrementMatrixSummary(summary, {status, isExpected}) {
  summary[status.toLowerCase()] += 1

  if (isExpected) {
    summary.expected += 1
  }

  summary.totalCells += 1
}

function createMatrixCell({declarationIndex, exploitation, period, pointId, summary}) {
  const declarationsById = declarationIndex.get(`${pointId}:${period.key}`)
  const declarations = declarationsById ? [...declarationsById.values()] : []
  const expectedPeriodType = getExpectedPeriodTypeForExploitation(exploitation, period)
  const isExpected = isExploitationExpectedForPeriod(exploitation, period)
    && expectedPeriodType === period.periodType
  const status = getCellStatus({declarations, isExpected})

  incrementMatrixSummary(summary, {status, isExpected})

  return {
    period: period.key,
    month: period.key,
    periodType: period.periodType,
    periodLabel: period.fullLabel,
    expectedPeriodType,
    status,
    expected: isExpected,
    declarationsCount: declarations.length,
    declarations
  }
}

function createMatrixRows({exploitations, chunks, periods}) {
  const declarationIndex = createDeclarationIndex(chunks, periods)
  const groupsByDeclarantId = new Map()
  const rows = []
  const summary = {
    declared: 0,
    missing: 0,
    inactive: 0,
    expected: 0,
    totalCells: 0,
    rows: 0
  }

  for (const exploitation of exploitations) {
    const {declarant} = exploitation
    const declarantUser = declarant?.user
    const declarantId = declarant?.userId
    const point = exploitation.pointPrelevement

    if (!declarantId || !point?.id) {
      continue
    }

    const cells = periods.map(period => createMatrixCell({
      declarationIndex,
      exploitation,
      period,
      pointId: point.id,
      summary
    }))

    const collecteurs = (exploitation.collecteurs ?? [])
      .map(normalizeCollecteurLink)
      .filter(Boolean)

    const serialized = serializeExploitationUsageFields(exploitation)
    const row = {
      id: exploitation.id,
      exploitationId: exploitation.id,
      declarantUserId: declarantId,
      declarantLabel: preleveurLabel(declarant),
      declarantEmail: getPrimaryDeclarantContactEmail(declarant),
      declarantLoginEmail: declarantUser?.email ?? null,
      declarantFirstName: declarantUser?.firstName ?? null,
      declarantLastName: declarantUser?.lastName ?? null,
      declarantLastLoginAt: declarantUser?.lastLoginAt ?? null,
      declarantPhoneNumber: declarant.phoneNumber ?? null,
      declarantSocialReason: declarant.socialReason ?? null,
      pointPrelevementId: point.id,
      pointName: point.name,
      resourceName: point.resourceName ?? null,
      exploitationStatus: exploitation.status,
      startDate: exploitation.startDate,
      endDate: exploitation.endDate,
      usage: serialized.usage,
      secondaryUsages: serialized.secondaryUsages,
      collecteurs,
      cells
    }

    rows.push(row)
    summary.rows += 1

    const group = groupsByDeclarantId.get(declarantId) ?? {
      declarantUserId: declarantId,
      declarantLabel: row.declarantLabel,
      declarantEmail: row.declarantEmail,
      declarantLastLoginAt: row.declarantLastLoginAt,
      rows: []
    }

    group.rows.push(row)
    groupsByDeclarantId.set(declarantId, group)
  }

  const groups = [...groupsByDeclarantId.values()]
    .map(group => ({
      ...group,
      rows: group.rows.sort((a, b) => a.pointName.localeCompare(b.pointName, 'fr'))
    }))
    .sort((a, b) => a.declarantLabel.localeCompare(b.declarantLabel, 'fr'))

  return {
    groups,
    rows,
    summary
  }
}

function exportValue(value) {
  return optionalText(value) ?? 'Non renseigné'
}

function exportList(values = []) {
  const normalized = [...new Set(values.map(value => optionalText(value)).filter(Boolean))]

  return normalized.length > 0 ? normalized.join(', ') : 'Non renseigné'
}

function createMissingDeclarationsWorkbook({matrix, periods}) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Non déclarants')
  const periodsByKey = new Map(periods.map(period => [period.key, period]))

  sheet.columns = [
    {header: 'Raison sociale', key: 'socialReason', width: 28},
    {header: 'Nom', key: 'lastName', width: 20},
    {header: 'Prénom', key: 'firstName', width: 20},
    {header: 'Mail', key: 'email', width: 32},
    {header: 'Téléphone', key: 'phoneNumber', width: 18},
    {header: 'Point concerné', key: 'pointName', width: 32},
    {header: 'Usage', key: 'usage', width: 24},
    {header: 'Usages secondaires', key: 'secondaryUsages', width: 36},
    {header: 'Ressource', key: 'resourceName', width: 24},
    {header: 'Période attendue', key: 'period', width: 24},
    {header: 'Collecteurs', key: 'collecteurs', width: 32},
    {header: 'Mails collecteurs', key: 'collecteurEmails', width: 36}
  ]

  for (const row of matrix.rows) {
    const missingCells = row.cells.filter(cell => cell.status === 'MISSING')

    for (const cell of missingCells) {
      const period = periodsByKey.get(cell.period)

      sheet.addRow({
        socialReason: exportValue(row.declarantSocialReason),
        lastName: exportValue(row.declarantLastName),
        firstName: exportValue(row.declarantFirstName),
        email: exportValue(row.declarantEmail),
        phoneNumber: exportValue(row.declarantPhoneNumber),
        pointName: exportValue(row.pointName),
        usage: exportValue(row.usage?.label),
        secondaryUsages: exportList(row.secondaryUsages.map(usage => usage.label)),
        resourceName: exportValue(row.resourceName),
        period: exportValue(period?.fullLabel ?? period?.label ?? cell.period),
        collecteurs: exportList(row.collecteurs.map(collecteur => collecteur.label)),
        collecteurEmails: exportList(row.collecteurs.map(collecteur =>
          collecteur.contactEmail ?? collecteur.email))
      })
    }
  }

  sheet.getRow(1).font = {bold: true}
  sheet.views = [{state: 'frozen', ySplit: 1}]
  sheet.autoFilter = {
    from: 'A1',
    to: 'L1'
  }

  return workbook
}

function defaultExploitationIncludeWithContactEmails() {
  const include = defaultExploitationInclude()
  include.declarant = {
    include: {
      user: true,
      contactEmails: true
    }
  }
  include.collecteurs = {
    include: {
      collecteur: {
        include: {
          user: true,
          contactEmails: true
        }
      }
    },
    orderBy: {createdAt: 'asc'}
  }

  return include
}

async function getZoneExploitationsForMatrix(zoneId) {
  const include = defaultExploitationIncludeWithContactEmails()
  include.pointPrelevement = {
    include: {
      zones: {
        where: {zoneId},
        include: {
          zone: {
            include: {
              declarationSettings: true,
              declarationOverrides: true
            }
          }
        }
      }
    }
  }

  return prisma.declarantPointPrelevement.findMany({
    where: getZoneExploitationBaseWhere(zoneId),
    include,
    orderBy: [
      {createdAt: 'asc'}
    ]
  })
}

async function getChunksForMatrix({pointIds, fromDate, toDate}) {
  if (pointIds.length === 0) {
    return []
  }

  return prisma.chunk.findMany({
    where: {
      pointPrelevementId: {in: pointIds},
      minDate: {lte: toDate},
      maxDate: {gte: fromDate},
      source: {
        type: 'DECLARATION'
      }
    },
    select: {
      id: true,
      pointPrelevementId: true,
      minDate: true,
      maxDate: true,
      source: {
        select: {
          id: true,
          globalInstructionStatus: true,
          declaration: {
            select: {
              id: true,
              code: true,
              createdAt: true,
              declarantUserId: true,
              createdByDeclarantUserId: true,
              createdByDeclarant: {
                select: {
                  userId: true,
                  socialReason: true,
                  user: {
                    select: {
                      email: true,
                      firstName: true,
                      lastName: true
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    orderBy: [
      {minDate: 'asc'},
      {createdAt: 'asc'}
    ]
  })
}

export async function getZoneGeometryHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')

  const right = await getZoneRightOrThrow(req.user, zoneId, {permission: 'zone.geometry.read'})

  const rows = await prisma.$queryRaw`
    SELECT
      id,
      name,
      type,
      code,
      ST_AsGeoJSON(coordinates)::json AS geometry
    FROM "Zone"
    WHERE id = ${zoneId}::uuid
  `

  const zone = rows?.[0]

  if (!zone?.geometry) {
    throw createHttpError(404, 'Géométrie de zone introuvable.')
  }

  res.send({
    type: 'Feature',
    properties: {
      id: zone.id,
      name: zone.name,
      type: zone.type,
      code: zone.code,
      isAdmin: isGlobalAdmin(req.user) || right.permissions.length === ZONE_PERMISSION_CODES.length
    },
    geometry: zone.geometry
  })
}

export async function listZonePointsPrelevementHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const query = parseListQuery(req.query)

  const right = await getZoneRightOrThrow(req.user, zoneId, {permission: 'pp.list'})
  const capabilities = getZoneListCapabilities(req.user, right)
  const includeDeclarantDetails = capabilities.canReadDeclarants
    && capabilities.canReadExploitations
  const scopedQuery = scopeZoneListQuery(query, {
    ...capabilities,
    canReadDeclarants: includeDeclarantDetails
  })

  const baseWhere = getZonePointBaseWhere(zoneId)
  const pointsForSearch = await prisma.pointPrelevement.findMany({
    where: baseWhere,
    select: {
      id: true,
      name: true,
      usageName: true,
      createdAt: true,
      flowType: true,
      waterBodyType: true,
      ...(capabilities.canReadExploitations
        ? {
          declarants: {
            where: {
              declarant: {user: {deletedAt: null}}
            },
            select: {
              id: true,
              status: true,
              usage: {
                select: {code: true, label: true}
              },
              secondaryUsageLinks: {
                select: {
                  usage: {
                    select: {code: true, label: true}
                  }
                }
              },
              collecteurs: {
                where: {collecteur: {user: {deletedAt: null}}},
                select: {id: true}
              },
              connectors: {select: {id: true}},
              ...(includeDeclarantDetails
                ? {
                  declarant: {
                    select: {
                      declarantRole: true,
                      declarantType: true,
                      preleveurType: true,
                      contactEmails: {
                        select: {
                          id: true,
                          email: true,
                          isPrimary: true
                        }
                      },
                      user: {select: {email: true}}
                    }
                  }
                }
                : {})
            }
          }
        }
        : {})
    }
  })
  const pointRecords = pointsForSearch.map(point => createPointSearchRecord(point))
  const pointScopesById = new Map(pointsForSearch.map(point => [
    point.id,
    {
      pointId: point.id,
      exploitationIds: (point.declarants ?? []).map(exploitation => exploitation.id)
    }
  ]))
  const orderedRecords = await filterAndRankZoneListRecords(
    pointRecords,
    scopedQuery,
    (ids, search) => includeDeclarantDetails
      ? rankScopedPointIds(
        ids.map(id => pointScopesById.get(id)).filter(Boolean),
        search,
        {includeSensitiveIdentifiers: capabilities.canReadPointDetails}
      )
      : rankPointIds(ids, search, {
        includeSensitiveIdentifiers: capabilities.canReadPointDetails
      })
  )
  const pageIds = pageRecordIds(orderedRecords, scopedQuery)
  const points = pageIds.length === 0
    ? []
    : await prisma.pointPrelevement.findMany({
      where: {...baseWhere, id: {in: pageIds}},
      include: {
        zones: {
          include: {
            zone: true
          }
        },
        ...(capabilities.canReadExploitations ? {declarants: true} : {})
      }
    })
  const decorated = await decoratePointsPrelevement(
    orderItemsByIds(points, pageIds),
    {
      user: req.user,
      includeDeclarantDetails,
      includeExploitationDetails: capabilities.canReadExploitations
    }
  )

  sendPaginated(res, decorated, scopedQuery, {
    total: orderedRecords.length,
    totalAll: pointRecords.length,
    facets: createZoneListFacets(pointRecords, {
      includeDeclarantDetails,
      includeExploitationDetails: capabilities.canReadExploitations,
      includePointDetails: true
    })
  })
}

export async function listZonePointOptionsHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'pp.list'})

  const points = await prisma.pointPrelevement.findMany({
    where: getZonePointBaseWhere(zoneId),
    select: {
      id: true,
      name: true,
      codeBSS: true
    },
    orderBy: {
      name: 'asc'
    }
  })

  res.send(points)
}

export async function getZonePointPrelevementHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const pointId = validateUuid(req.params.pointId, 'Identifiant de point')

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'pp.detail.read'})

  const point = await getPointInZone(zoneId, pointId)

  if (!point) {
    throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
  }

  res.send(await decoratePointPrelevement(point, {user: req.user}))
}

export async function createZonePointPrelevementHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'pp.create'})
  await assertCoordinatesInZone(zoneId, req.body.coordinates)

  const point = await createPointPrelevement(req.body, {user: req.user})
  await assertPointInZone(point.id, zoneId)

  stageAuditMutation(req, {
    operation: 'CREATE',
    entityType: 'POINT',
    entityId: point.id,
    entityLabel: point.usageName || point.name,
    after: point
  })

  res.status(201).send(await decoratePointPrelevement(point, {user: req.user}))
}

export async function updateZonePointPrelevementHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const pointId = validateUuid(req.params.pointId, 'Identifiant de point')

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'pp.update'})
  const existing = await getPointInZone(zoneId, pointId)

  if (Object.hasOwn(req.body, 'coordinates')) {
    await assertCoordinatesInZone(zoneId, req.body.coordinates)
  }

  const point = await updatePointPrelevement(pointId, req.body, {user: req.user})
  await assertPointInZone(point.id, zoneId)

  stageAuditMutation(req, {
    operation: 'UPDATE',
    entityType: 'POINT',
    entityId: point.id,
    entityLabel: point.usageName || point.name,
    before: existing,
    after: point
  })

  res.send(await decoratePointPrelevement(point, {user: req.user}))
}

export async function deleteZonePointPrelevementHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const pointId = validateUuid(req.params.pointId, 'Identifiant de point')

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'pp.delete'})
  const existing = await getPointInZone(zoneId, pointId)

  const deletedPoint = await deletePointPrelevement(pointId)

  if (!deletedPoint) {
    throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
  }

  stageAuditMutation(req, {
    operation: 'DELETE',
    entityType: 'POINT',
    entityId: existing.id,
    entityLabel: existing.usageName || existing.name,
    before: existing
  })

  res.send(deletedPoint)
}

export async function listZoneExploitationsHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const query = parseListQuery(req.query)

  const right = await getZoneRightOrThrow(req.user, zoneId, {
    permission: 'exploitation.list'
  })
  const capabilities = {
    ...getZoneListCapabilities(req.user, right),
    canReadDeclarants: true
  }
  const scopedQuery = scopeZoneListQuery(
    normalizeZoneExploitationListQuery(query),
    capabilities
  )

  const baseWhere = getZoneExploitationBaseWhere(zoneId)
  const exploitationsForSearch = await prisma.declarantPointPrelevement.findMany({
    where: baseWhere,
    select: {
      id: true,
      createdAt: true,
      status: true,
      usage: {
        select: {code: true, label: true}
      },
      secondaryUsageLinks: {
        select: {
          usage: {
            select: {code: true, label: true}
          }
        }
      },
      pointPrelevement: {
        select: {
          id: true,
          name: true,
          usageName: true,
          flowType: true,
          waterBodyType: true
        }
      },
      ...(capabilities.canReadDeclarants
        ? {
          declarant: {
            select: {
              declarantRole: true,
              declarantType: true,
              preleveurType: true,
              socialReason: true,
              lastDeclarationAt: true,
              contactEmails: {
                select: {
                  id: true,
                  email: true,
                  isPrimary: true
                }
              },
              user: {
                select: {
                  email: true,
                  firstName: true,
                  lastName: true
                }
              }
            }
          }
        }
        : {}),
      collecteurs: {
        where: {collecteur: {user: {deletedAt: null}}},
        select: {id: true}
      },
      connectors: {select: {id: true}}
    }
  })
  const exploitationRecords = exploitationsForSearch
    .map(exploitation => createExploitationSearchRecord(exploitation))
  const orderedRecords = await filterAndRankZoneListRecords(
    exploitationRecords,
    scopedQuery,
    (ids, search) => rankExploitationIds(ids, search, {
      includeDeclarantDetails: capabilities.canReadDeclarants
    }),
    {fallback: 'CREATED_AT'}
  )
  const pageIds = pageRecordIds(orderedRecords, scopedQuery)
  const exploitations = pageIds.length === 0
    ? []
    : await prisma.declarantPointPrelevement.findMany({
      where: {...baseWhere, id: {in: pageIds}},
      include: defaultExploitationIncludeWithContactEmails()
    })

  const decorated = await Promise.all(
    orderItemsByIds(exploitations, pageIds)
      .map(exploitation => decorateZoneExploitation(
        exploitation,
        req.user,
        {includeDeclarantDetails: capabilities.canReadDeclarants}
      ))
  )

  sendPaginated(res, decorated, scopedQuery, {
    total: orderedRecords.length,
    totalAll: exploitationRecords.length,
    facets: createZoneListFacets(exploitationRecords, {
      includeDeclarantDetails: capabilities.canReadDeclarants,
      includeDeclarationDetails: true,
      includeExploitationDetails: true,
      includePointDetails: true
    })
  })
}

export async function getZoneExploitationHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const exploitationId = validateUuid(req.params.exploitationId, 'Identifiant d’exploitation')

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'exploitation.detail.read'})

  const exploitation = await getExploitationInZone(zoneId, exploitationId)

  if (!exploitation) {
    throw createHttpError(404, 'Cette exploitation est introuvable dans cette zone.')
  }

  res.send(await decorateZoneExploitation(exploitation, req.user))
}

export async function createZoneExploitationHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'exploitation.create'})

  if (!req.body?.pointPrelevementId) {
    throw createHttpError(400, 'Le point de prélèvement est obligatoire.')
  }

  await assertPointInZone(req.body.pointPrelevementId, zoneId)

  const exploitation = await createExploitation(req.body, {user: req.user})

  stageAuditMutation(req, {
    operation: 'CREATE',
    entityType: 'EXPLOITATION',
    entityId: exploitation.id,
    before: null,
    after: exploitation
  })

  res.status(201).send(await decorateZoneExploitation(exploitation, req.user))
}

export async function updateZoneExploitationHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const exploitationId = validateUuid(req.params.exploitationId, 'Identifiant d’exploitation')

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'exploitation.update'})

  const existing = await getExploitationInZone(zoneId, exploitationId)

  if (!existing) {
    throw createHttpError(404, 'Cette exploitation est introuvable dans cette zone.')
  }

  if (req.body?.pointPrelevementId) {
    await assertPointInZone(req.body.pointPrelevementId, zoneId)
  }

  const exploitation = await updateExploitation(exploitationId, req.body, {user: req.user})

  stageAuditMutation(req, {
    operation: 'UPDATE',
    entityType: 'EXPLOITATION',
    entityId: exploitation.id,
    before: existing,
    after: exploitation
  })

  res.send(await decorateZoneExploitation(exploitation, req.user))
}

export async function deleteZoneExploitationHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const exploitationId = validateUuid(req.params.exploitationId, 'Identifiant d’exploitation')

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'exploitation.delete'})

  const existing = await getExploitationInZone(zoneId, exploitationId)

  if (!existing) {
    throw createHttpError(404, 'Cette exploitation est introuvable dans cette zone.')
  }

  const deleted = await deleteExploitation(exploitationId)

  stageAuditMutation(req, {
    operation: 'DELETE',
    entityType: 'EXPLOITATION',
    entityId: existing.id,
    before: existing
  })

  res.send(deleted)
}

export async function listZoneDeclarantOptionsHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')

  const right = await getZoneRightOrThrow(req.user, zoneId)
  const permissions = new Set(
    (right.permissions ?? []).map(item => item.permission ?? item)
  )

  if (!isGlobalAdmin(req.user)
    && !permissions.has('exploitation.create')
    && !permissions.has('exploitation.update')) {
    throw createHttpError(403, 'Vous ne disposez pas du droit de gérer les exploitations de cette zone.')
  }

  const options = await listDeclarantOptionsForZone(zoneId)

  res.send(options.sort((a, b) => {
    const labelA = optionalText(a.socialReason) || `${a.firstName || ''} ${a.lastName || ''}`.trim() || a.contactEmail || a.email || ''
    const labelB = optionalText(b.socialReason) || `${b.firstName || ''} ${b.lastName || ''}`.trim() || b.contactEmail || b.email || ''

    return labelA.localeCompare(labelB, 'fr')
  }))
}

async function listZoneDeclarantsByRole(req, res, forcedDeclarantRole = null) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const query = parseListQuery(req.query)
  const right = await getZoneRightOrThrow(req.user, zoneId, {
    permission: 'declarant.list'
  })
  const capabilities = getZoneListCapabilities(req.user, right)
  const scopedQuery = scopeZoneListQuery(query, capabilities)
  const effectiveQuery = {
    ...scopedQuery,
    filters: {
      ...scopedQuery.filters,
      declarantRole: forcedDeclarantRole ?? scopedQuery.filters.declarantRole
    }
  }

  const declarantUserIdsByZone = await getEffectiveDeclarantUserIdsByZone([zoneId])
  const declarantUserIds = declarantUserIdsByZone.get(zoneId) ?? []
  const baseWhere = getZoneDeclarantBaseWhere(declarantUserIds, forcedDeclarantRole)
  const users = await prisma.user.findMany({
    where: baseWhere,
    include: getZoneDeclarantInclude(zoneId, {
      includeExploitations: capabilities.canReadExploitations
    })
  })
  const declarantRecords = users.map(user => createDeclarantSearchRecord(user))
  const scopesByDeclarantId = new Map(users.map(user => [
    user.id,
    createDeclarantSearchScope(user)
  ]))
  const orderedRecords = await filterAndRankZoneListRecords(
    declarantRecords,
    effectiveQuery,
    (ids, search) => rankScopedDeclarantIds(
      ids.map(id => scopesByDeclarantId.get(id)).filter(Boolean),
      search
    )
  )
  const pageIds = pageRecordIds(orderedRecords, effectiveQuery)
  const pageUsers = orderItemsByIds(users, pageIds)

  sendPaginated(
    res,
    pageUsers.map(user => normalizeZoneDeclarant(user, zoneId)),
    effectiveQuery,
    {
      total: orderedRecords.length,
      totalAll: declarantRecords.length,
      facets: createZoneListFacets(declarantRecords, {
        includeDeclarantDetails: true,
        includeDeclarationDetails: true,
        includeExploitationDetails: capabilities.canReadExploitations,
        includePointDetails: capabilities.canReadExploitations
      })
    }
  )
}

export async function listZoneDeclarantsHandler(req, res) {
  await listZoneDeclarantsByRole(req, res)
}

export async function listZoneCollecteursHandler(req, res) {
  await listZoneDeclarantsByRole(req, res, 'COLLECTEUR')
}

export async function getZoneDeclarationMonthlyStatusHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const matrixQuery = parseMatrixQuery(req.query)

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'declaration.followup.read'})

  const exploitations = await getZoneExploitationsForMatrix(zoneId)
  const periods = matrixQuery.periodMode === 'expected'
    ? buildExpectedMatrixPeriods({
      exploitations,
      basePeriods: matrixQuery.periods
    })
    : matrixQuery.periods
  const pointIds = [...new Set(exploitations.map(exploitation => exploitation.pointPrelevementId).filter(Boolean))]
  const chunks = await getChunksForMatrix({
    pointIds,
    fromDate: matrixQuery.fromDate,
    toDate: matrixQuery.toDate
  })

  const matrix = createMatrixRows({
    exploitations,
    chunks,
    periods
  })

  const serializedPeriods = periods.map(period => ({
    key: period.key,
    periodType: period.periodType,
    label: period.label,
    fullLabel: period.fullLabel
  }))

  res.send({
    data: {
      periodType: matrixQuery.periodType,
      periodMode: matrixQuery.periodMode,
      periods: serializedPeriods,
      months: serializedPeriods,
      groups: matrix.groups,
      rows: matrix.rows,
      legend: [
        {status: 'DECLARED', label: 'Déclaration déposée sur cette période'},
        {status: 'MISSING', label: 'Déclaration attendue mais non trouvée'},
        {status: 'INACTIVE', label: 'Exploitation inactive ou hors période'}
      ]
    },
    meta: {
      zoneId,
      periodType: matrixQuery.periodType,
      from: matrixQuery.from,
      to: matrixQuery.to,
      periodsCount: periods.length,
      monthsCount: matrixQuery.periodsCount,
      generatedAt: new Date().toISOString(),
      summary: matrix.summary
    }
  })
}

export async function exportZoneDeclarationMissingHandler(req, res) {
  const zoneId = validateUuid(req.params.zoneId, 'Identifiant de zone')
  const periodType = parseDeclarationPeriodType(req.query.periodType)
  const periodKey = parseDeclarationPeriodKey(req.query.periodKey ?? req.query.to, periodType)

  if (!periodKey) {
    throw createHttpError(400, 'La période à exporter est obligatoire.')
  }

  const query = {
    periodType,
    periodKey
  }
  const matrixQuery = parseMatrixQuery(query)

  await getZoneRightOrThrow(req.user, zoneId, {permission: 'declaration.followup.export'})

  const exploitations = await getZoneExploitationsForMatrix(zoneId)
  const pointIds = [...new Set(exploitations.map(exploitation => exploitation.pointPrelevementId).filter(Boolean))]
  const chunks = await getChunksForMatrix({
    pointIds,
    fromDate: matrixQuery.fromDate,
    toDate: matrixQuery.toDate
  })
  const matrix = createMatrixRows({
    exploitations,
    chunks,
    periods: matrixQuery.periods
  })
  const workbook = createMissingDeclarationsWorkbook({
    matrix,
    periods: matrixQuery.periods
  })
  const buffer = await workbook.xlsx.writeBuffer()
  const filename = `non-declarants-${matrixQuery.periodType}-${matrixQuery.to}.xlsx`

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(Buffer.from(buffer))
}
