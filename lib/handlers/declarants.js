import createHttpError from 'http-errors'
import Joi from 'joi'

import {prisma} from '../../db/prisma.js'
import {stageAuditMutation} from '../audit/mutations.js'

import {
  createPreleveur,
  deletePreleveur,
  updatePreleveur
} from '../services/preleveur.js'

import {
  getCollecteurPreleveurs,
  getDeclarantById,
  getDeclarantOverviewById,
  getDeclarants,
  getDeclarantsByInstructor,
  searchCollecteurPreleveurs,
  searchDeclarants
} from '../models/declarant.js'

import {
  decoratePointPrelevement,
  getPointsFromDeclarant
} from '../services/point-prelevement.js'

import {
  getDeclarantExploitations,
  getPreleveurExploitationsViaPoints
} from '../models/exploitation.js'
import {decorateExploitation} from '../services/exploitation.js'

import {
  getPreleveurRegles
} from '../models/regle.js'

import {
  createRegle,
  decorateRegle
} from '../services/regle.js'
import {
  decorateDeclarantRight,
  decorateDeclarantsRights
} from '../services/resource-permissions.js'

import {
  getPreleveurDocuments
} from '../models/document.js'

import {
  createDocument,
  decorateDocument
} from '../services/document.js'
import {sendAccountCreationNotification} from '../services/account-notifications.js'
import {
  getEffectiveDeclarantZoneIds,
  getPermissionZoneIdsForUser,
  hasZonePermission
} from '../services/zone-permissions.js'
import {withRequestPerformancePhase} from '../util/request-performance.js'

const declarantZonesSchema = Joi.object({
  zoneIds: Joi.array()
    .items(Joi.string().guid({version: 'uuidv4'}))
    .min(1)
    .unique()
    .required()
})
const DERIVED_DECLARANT_ZONE_SOURCES = new Set([
  'EXPLOITATION',
  'DECLARATION',
  'RECONCILIATION'
])
const DECLARANT_SEARCH_ROLES = new Set(['PRELEVEUR', 'COLLECTEUR'])
const DECLARANT_SEARCH_TYPES = new Set(['NATURAL_PERSON', 'LEGAL_PERSON'])
const DECLARANT_SEARCH_PRELEVEUR_TYPES = new Set([
  'ICPE',
  'IRRIGANT',
  'GESTIONNAIRE_AEP',
  'AUTRE'
])
const DECLARANT_SEARCH_EMAIL_STATUSES = new Set(['WITH_EMAIL', 'WITHOUT_EMAIL'])
const DECLARANT_SEARCH_COLLECTEUR_STATUSES = new Set([
  'WITH_COLLECTEUR',
  'WITHOUT_COLLECTEUR'
])
const DECLARANT_SEARCH_CONNECTOR_STATUSES = new Set([
  'WITH_CONNECTOR',
  'WITHOUT_CONNECTOR'
])
const DECLARANT_SEARCH_ACTIVITY_RANGES = new Set([
  'NEVER',
  'LT_30_DAYS',
  'DAYS_30_90',
  'DAYS_91_365',
  'GT_365_DAYS'
])
const DECLARANT_SEARCH_SORTS = new Set(['RELEVANCE', 'NAME', 'LAST_DECLARATION'])
const DECLARANT_SEARCH_ORDERS = new Set(['ASC', 'DESC'])
const DECLARANT_SEARCH_WATER_BODY_TYPES = new Set([
  'SUPERFICIELLE',
  'SOUTERRAIN',
  'TRANSITION'
])
const DECLARANT_SEARCH_EXPLOITATION_STATUSES = new Set([
  'EN_ACTIVITE',
  'NON_RENSEIGNE',
  'ABANDONNEE',
  'TERMINEE'
])
const COMPACT_DECLARANT_SEARCH_PERMISSIONS = new Set([
  'declarant.detail.read',
  'declaration.list',
  'exploitation.list'
])
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value
}

function parsePositiveInteger(value, fallback, {max = Number.MAX_SAFE_INTEGER} = {}) {
  const parsed = Number.parseInt(firstQueryValue(value), 10)

  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, max)
    : fallback
}

function parseSearchEnum(value, allowedValues) {
  const normalized = String(firstQueryValue(value) ?? '').trim().toUpperCase()
  return allowedValues.has(normalized) ? normalized : null
}

function parseSearchList(value, {allowedValues, validate} = {}) {
  const values = (Array.isArray(value) ? value : [value])
    .flatMap(item => String(item ?? '').split(','))
    .map(item => item.trim())
    .filter(Boolean)
  const normalized = allowedValues
    ? values.map(item => item.toUpperCase()).filter(item => allowedValues.has(item))
    : values.filter(item => !validate || validate(item))

  return [...new Set(normalized)]
}

export function parseDeclarantsSearchQuery(query = {}) {
  return {
    page: parsePositiveInteger(query.page, 1),
    pageSize: parsePositiveInteger(query.pageSize ?? query.perPage, 25, {max: 100}),
    query: String(firstQueryValue(query.query ?? query.search) ?? '').trim().slice(0, 200),
    role: parseSearchEnum(query.role, DECLARANT_SEARCH_ROLES),
    declarantType: parseSearchEnum(query.declarantType, DECLARANT_SEARCH_TYPES),
    preleveurType: parseSearchEnum(
      query.preleveurType,
      DECLARANT_SEARCH_PRELEVEUR_TYPES
    ),
    emailStatus: parseSearchEnum(
      query.emailStatus ?? query.email,
      DECLARANT_SEARCH_EMAIL_STATUSES
    ),
    collecteurStatus: parseSearchEnum(
      query.collecteurStatus ?? query.collecteur,
      DECLARANT_SEARCH_COLLECTEUR_STATUSES
    ),
    connectorStatus: parseSearchEnum(
      query.connectorStatus ?? query.connecteur,
      DECLARANT_SEARCH_CONNECTOR_STATUSES
    ),
    activityRange: parseSearchEnum(
      query.activityRange,
      DECLARANT_SEARCH_ACTIVITY_RANGES
    ),
    sort: parseSearchEnum(query.sort, DECLARANT_SEARCH_SORTS) ?? 'RELEVANCE',
    order: parseSearchEnum(query.order, DECLARANT_SEARCH_ORDERS) ?? 'DESC',
    zoneIds: parseSearchList(query.zoneIds ?? query.zoneId, {
      validate: value => UUID_PATTERN.test(value)
    }),
    usageCodes: parseSearchList(query.usageCodes ?? query.usage),
    waterBodyTypes: parseSearchList(
      query.waterBodyTypes ?? query.waterBodyType,
      {allowedValues: DECLARANT_SEARCH_WATER_BODY_TYPES}
    ),
    exploitationStatuses: parseSearchList(
      query.exploitationStatuses ?? query.status,
      {allowedValues: DECLARANT_SEARCH_EXPLOITATION_STATUSES}
    ),
    ...(String(firstQueryValue(query.format) ?? '').trim().toLowerCase() === 'compact'
      ? {format: 'compact'}
      : {})
  }
}

export function toCompactDeclarantSearchItem(item, {
  trustedCollectorScope = false
} = {}) {
  const declarant = item.declarant ?? {}
  const permissions = new Set((item.right?.permissions ?? [])
    .filter(permission => COMPACT_DECLARANT_SEARCH_PERMISSIONS.has(permission)))
  const isAdmin = item.right?.isAdmin === true
  const declarantRole = declarant.declarantRole ?? 'PRELEVEUR'
  const canReadDetail = isAdmin
    || item.right?.canRead === true
    || permissions.has('declarant.detail.read')
  const canDisplayPoints = trustedCollectorScope
    || isAdmin
    || permissions.has('exploitation.list')
  const canDisplayActivity = isAdmin || permissions.has('declaration.list')
  const pointCount = declarantRole === 'COLLECTEUR'
    ? declarant._count?.collecteurExploitations ?? 0
    : declarant._count?.pointPrelevements ?? 0

  return {
    id: item.id ?? item.userId,
    email: item.email ?? null,
    civility: item.civility ?? declarant.civility ?? null,
    firstName: item.firstName ?? null,
    lastName: item.lastName ?? null,
    declarantRole,
    declarantType: declarant.declarantType ?? null,
    preleveurType: declarant.preleveurType ?? null,
    socialReason: declarant.socialReason ?? null,
    city: declarant.city ?? null,
    lastDeclarationAt: canDisplayActivity
      ? declarant.lastDeclarationAt ?? null
      : null,
    pointCount: canDisplayPoints ? pointCount : null,
    usages: canDisplayPoints ? item.searchSummary?.usages ?? [] : null,
    canReadDetail,
    canDisplayPoints,
    canDisplayActivity
  }
}

export function getInstructorZoneScope(req) {
  return req.user?.role === 'INSTRUCTOR'
    ? {
      zoneIds: Array.isArray(req.permittedZoneIds)
        ? req.permittedZoneIds
        : []
    }
    : {}
}

export async function getDeclarantZoneUpdatePlan({
  currentLinks = [],
  effectiveZoneIds = [],
  nextZoneIds = [],
  user
}, {
  client = prisma,
  now = new Date()
} = {}) {
  const currentZoneIds = [...new Set(currentLinks.map(link => link.zoneId))]
  const uniqueNextZoneIds = [...new Set(nextZoneIds)]
  const current = new Set(currentZoneIds)
  const next = new Set(uniqueNextZoneIds)
  const effective = new Set(effectiveZoneIds)
  const removedZoneIds = currentZoneIds.filter(zoneId => !next.has(zoneId))
  const addedZoneIds = uniqueNextZoneIds.filter(zoneId => !current.has(zoneId))
  const changedZoneIds = [...removedZoneIds, ...addedZoneIds]

  if (changedZoneIds.length > 0 && user?.role !== 'ADMIN') {
    const permittedChangedZoneIds = await getPermissionZoneIdsForUser(
      user,
      'declarant.zone.update',
      {client, now, zoneIds: changedZoneIds}
    )

    if (permittedChangedZoneIds.length !== changedZoneIds.length) {
      throw createHttpError(403, 'Vous ne pouvez modifier que les rattachements des zones où ce droit vous est attribué.')
    }
  }

  const derivedSelectedZoneIds = currentLinks
    .filter(link =>
      next.has(link.zoneId)
      && effective.has(link.zoneId)
      && DERIVED_DECLARANT_ZONE_SOURCES.has(link.source))
    .map(link => link.zoneId)
  const uniqueDerivedSelectedZoneIds = [...new Set(derivedSelectedZoneIds)]
  let promotableZoneIds = []

  if (user?.role === 'ADMIN') {
    promotableZoneIds = uniqueDerivedSelectedZoneIds
  } else if (uniqueDerivedSelectedZoneIds.length > 0) {
    promotableZoneIds = await getPermissionZoneIdsForUser(
      user,
      'declarant.zone.update',
      {client, now, zoneIds: uniqueDerivedSelectedZoneIds}
    )
  }

  return {
    addedZoneIds,
    removedZoneIds,
    promotableZoneIds
  }
}

function extractNotificationOptions(payload) {
  const {notifyAccountCreation, zoneIds, ...data} = payload || {}

  return {
    shouldNotifyAccountCreation: notifyAccountCreation === true,
    zoneIds,
    data
  }
}

async function sendDeclarantAccountCreationNotification(declarantId) {
  const declarant = await getDeclarantById(declarantId)

  if (!declarant?.user) {
    throw createHttpError(404, 'Ce déclarant est introuvable.')
  }

  await sendAccountCreationNotification(declarant.user, {role: 'DECLARANT'})

  return getDeclarantById(declarantId)
}

// Liste des déclarants
export async function listDeclarants(req, res) {
  const declarants = req.user.role === 'ADMIN'
    ? await getDeclarants()
    : await getDeclarantsByInstructor(req.user.id)

  res.send(await decorateDeclarantsRights(declarants, req.user))
}

export async function searchDeclarantsHandler(req, res) {
  const filters = parseDeclarantsSearchQuery(req.query)
  const result = await withRequestPerformancePhase(
    'search_model',
    async () => searchDeclarants(req.user, filters)
  )
  const items = await withRequestPerformancePhase(
    'search_rights',
    async () => decorateDeclarantsRights(result.items, req.user)
  )

  res.send({
    ...result,
    items: filters.format === 'compact'
      ? items.map(item => toCompactDeclarantSearchItem(item))
      : items
  })
}

// Liste des préleveurs accessibles par le collecteur connecté
export async function getCollecteurPreleveursHandler(req, res) {
  if (req.user?.declarant?.declarantRole !== 'COLLECTEUR') {
    throw createHttpError(403, 'Cette liste est réservée aux collecteurs.')
  }

  const preleveurs = await getCollecteurPreleveurs(req.user.id)
  res.send(await decorateDeclarantsRights(preleveurs, req.user))
}

export async function searchCollecteurPreleveursHandler(req, res) {
  if (req.user?.declarant?.declarantRole !== 'COLLECTEUR') {
    throw createHttpError(403, 'Cette liste est réservée aux collecteurs.')
  }

  const filters = parseDeclarantsSearchQuery(req.query)
  const result = await withRequestPerformancePhase(
    'collector_model',
    async () => searchCollecteurPreleveurs(
      req.user.id,
      filters
    )
  )
  const items = await withRequestPerformancePhase(
    'collector_rights',
    async () => decorateDeclarantsRights(result.items, req.user)
  )

  res.send({
    ...result,
    items: filters.format === 'compact'
      ? items.map(item => toCompactDeclarantSearchItem(item, {
        trustedCollectorScope: true
      }))
      : items
  })
}

function restrictDeclarantRelations(declarant, user) {
  if (user.role === 'INSTRUCTOR' && !declarant.right.permissions.includes('exploitation.list')) {
    declarant.pointPrelevements = []
    declarant.collecteurExploitations = []
  }

  if (user.role === 'INSTRUCTOR' && !declarant.right.permissions.includes('declarant.email-alias.read')) {
    declarant.emailAliases = []
    if (declarant.user) {
      declarant.user.emailAliases = []
    }
  }

  return declarant
}

export async function getDeclarantRelationsOptions(user, {
  client = prisma,
  now = new Date()
} = {}) {
  if (user.role !== 'INSTRUCTOR') {
    return {}
  }

  return {
    exploitationZoneIds: await getPermissionZoneIdsForUser(
      user,
      'exploitation.list',
      {client, now}
    )
  }
}

// Détail d'un déclarant
export async function getDeclarantDetail(req, res) {
  const declarant = await getDeclarantById(
    req.declarant.id,
    await getDeclarantRelationsOptions(req.user)
  )
  const decoratedDeclarant = await decorateDeclarantRight(declarant, req.user)

  res.send(restrictDeclarantRelations(decoratedDeclarant, req.user))
}

export async function getDeclarantOverviewHandler(req, res) {
  const declarant = await getDeclarantOverviewById(
    req.declarant.id,
    await getDeclarantRelationsOptions(req.user)
  )
  const decoratedDeclarant = await decorateDeclarantRight(declarant, req.user)

  res.send(restrictDeclarantRelations(decoratedDeclarant, req.user))
}

export async function getDeclarantZonesHandler(req, res) {
  const declarant = await getDeclarantById(req.declarant.id)

  res.send({
    items: (declarant.zones ?? []).map(link => ({
      id: link.id,
      zoneId: link.zoneId,
      zone: link.zone,
      source: link.source,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt
    }))
  })
}

export async function updateDeclarantZonesHandler(req, res) {
  const {error, value} = declarantZonesSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true
  })

  if (error) {
    throw createHttpError(400, 'Sélectionnez au moins une zone valide.')
  }

  const [currentLinks, effectiveZoneIds] = await Promise.all([
    prisma.declarantZone.findMany({
      where: {declarantUserId: req.declarant.id},
      select: {source: true, zoneId: true}
    }),
    getEffectiveDeclarantZoneIds(req.declarant.id)
  ])
  const updatePlan = await getDeclarantZoneUpdatePlan({
    currentLinks,
    effectiveZoneIds,
    nextZoneIds: value.zoneIds,
    user: req.user
  })

  const existingZonesCount = await prisma.zone.count({
    where: {id: {in: value.zoneIds}}
  })
  if (existingZonesCount !== value.zoneIds.length) {
    throw createHttpError(400, 'Une ou plusieurs zones sont introuvables.')
  }

  await prisma.$transaction(async tx => {
    if (updatePlan.removedZoneIds.length > 0) {
      await tx.declarantZone.deleteMany({
        where: {
          declarantUserId: req.declarant.id,
          zoneId: {in: updatePlan.removedZoneIds}
        }
      })
    }

    if (updatePlan.addedZoneIds.length > 0) {
      await tx.declarantZone.createMany({
        data: updatePlan.addedZoneIds.map(zoneId => ({
          declarantUserId: req.declarant.id,
          zoneId,
          source: 'MANUAL',
          createdByUserId: req.user.id
        })),
        skipDuplicates: true
      })
    }

    const manualZoneIds = [...new Set([
      ...updatePlan.addedZoneIds,
      ...updatePlan.promotableZoneIds
    ])]

    if (manualZoneIds.length > 0) {
      await tx.declarantZone.updateMany({
        where: {
          declarantUserId: req.declarant.id,
          zoneId: {in: manualZoneIds},
          source: {in: [...DERIVED_DECLARANT_ZONE_SOURCES]}
        },
        data: {
          source: 'MANUAL',
          createdByUserId: req.user.id
        }
      })
    }
  })

  const nextEffectiveZoneIds = await getEffectiveDeclarantZoneIds(req.declarant.id)
  const changedZones = await prisma.zone.findMany({
    where: {id: {in: [...new Set([...effectiveZoneIds, ...nextEffectiveZoneIds])]}},
    select: {id: true, name: true}
  })
  const zoneById = new Map(changedZones.map(zone => [zone.id, zone]))
  const serializeZones = zoneIds => [...zoneIds]
    .sort()
    .map(zoneId => zoneById.get(zoneId) ?? {id: zoneId, name: zoneId})

  stageAuditMutation(req, {
    operation: 'UPDATE',
    entityType: 'DECLARANT_ZONES',
    entityId: req.declarant.id,
    entityLabel: req.declarant.declarant?.socialReason
      || [req.declarant.firstName, req.declarant.lastName].filter(Boolean).join(' ')
      || req.declarant.email,
    before: {
      declarantUserId: req.declarant.id,
      zones: serializeZones(effectiveZoneIds)
    },
    after: {
      declarantUserId: req.declarant.id,
      zones: serializeZones(nextEffectiveZoneIds)
    }
  })

  const declarant = await getDeclarantById(req.declarant.id)
  res.send(await decorateDeclarantRight(declarant, req.user))
}

// Création d'un déclarant
export async function createPreleveurHandler(req, res) {
  const {data, shouldNotifyAccountCreation} = extractNotificationOptions(req.body)

  if (shouldNotifyAccountCreation && !await hasZonePermission(
    req.user,
    'declarant.invite',
    req.declarantZoneIds
  )) {
    throw createHttpError(403, 'Vous ne disposez pas du droit d’envoyer l’email de création de compte.')
  }

  let preleveur = await createPreleveur(data, {
    zoneIds: req.declarantZoneIds,
    createdByUserId: req.user.id
  })

  if (shouldNotifyAccountCreation) {
    preleveur = await sendDeclarantAccountCreationNotification(preleveur.userId || preleveur.id)
  }

  res.send(preleveur)
}

// Mise à jour d'un déclarant
export async function updatePreleveurHandler(req, res) {
  const {data} = extractNotificationOptions(req.body)
  const preleveur = Object.keys(data).length > 0
    ? await updatePreleveur(req.declarant.id, data)
    : await getDeclarantById(req.declarant.id)

  res.send(preleveur)
}

export async function sendDeclarantAccountCreationNotificationHandler(req, res) {
  res.send(await sendDeclarantAccountCreationNotification(req.declarant.id))
}

// Suppression d'un déclarant
export async function deletePreleveurHandler(req, res) {
  const deletedPreleveur = await deletePreleveur(req.declarant.id)

  res.send(deletedPreleveur)
}

// Liste des points de prélèvement d'un déclarant
export async function getPreleveurPointsPrelevement(req, res) {
  const points = await getPointsFromDeclarant(
    req.declarant.id,
    false,
    getInstructorZoneScope(req)
  )
  const decoratedPoints = await Promise.all(points.map(p => decoratePointPrelevement(p, {user: req.user})))

  res.send(decoratedPoints)
}

// Liste des exploitations d'un déclarant directement liées
export async function getPreleveurExploitationsHandler(req, res) {
  const exploitations = await getDeclarantExploitations(
    req.declarant.id,
    undefined,
    getInstructorZoneScope(req)
  )

  res.send(await Promise.all(
    exploitations.map(exploitation => decorateExploitation(exploitation, {user: req.user}))
  ))
}

// Liste des exploitations d'un déclarant via les points de prélèvements
export async function getPreleveurExploitationsViaPointsHandler(req, res) {
  const exploitations = await getPreleveurExploitationsViaPoints(
    req.declarant.id,
    getInstructorZoneScope(req)
  )

  res.send(await Promise.all(
    exploitations.map(exploitation => decorateExploitation(exploitation, {user: req.user}))
  ))
}

// Liste des règles d'un déclarant
export async function getPreleveurReglesHandler(req, res) {
  const regles = await getPreleveurRegles(req.declarant.id)
  const decoratedRegles = await Promise.all(regles.map(r => decorateRegle(r)))

  res.send(decoratedRegles)
}

// Création d'une règle pour un déclarant
export async function createPreleveurRegle(req, res) {
  const regle = await createRegle(req.body, req.declarant.id)
  const decoratedRegle = await decorateRegle(regle)

  res.send(decoratedRegle)
}

// Liste des documents d'un déclarant
export async function getPreleveurDocumentsHandler(req, res) {
  const documents = await getPreleveurDocuments(req.declarant.id)
  const decoratedDocuments = await Promise.all(documents.map(d => decorateDocument(d, {includeRelations: true})))

  res.send(decoratedDocuments)
}

// Création d'un document pour un déclarant
export async function createPreleveurDocument(req, res) {
  const document = await createDocument({
    payload: req.body,
    file: req.file,
    declarantUserId: req.declarant.id
  })

  const decoratedDocument = await decorateDocument(document)
  res.send(decoratedDocument)
}
